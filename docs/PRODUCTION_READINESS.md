# Üretime Hazırlık Değerlendirmesi

Bu belge, YapiFin repository'sinin mevcut hâlinin (Faz 0/1 — kimlik doğrulama, organizasyon, davet, proje iskeleti) üretime alınmadan önce taşıdığı riskleri belgeler. Kapsam salt inceleme ve dokümantasyondur; uygulama kodu, Prisma şeması, migration, servis, action, UI bileşeni veya test dosyası **değiştirilmemiştir**.

- **İncelenen dal:** `docs/production-readiness-review` (worktree: `YapiFin-worktrees/production-review`)
- **Referans commit:** `7499012` (`main`, PR #1 sonrası)
- **Yöntem:** `CLAUDE.md` ve `docs/` altındaki ilgili belgeler okunduktan sonra yalnızca ortam/güvenlik/dağıtım ile ilgili kaynak kökleri hedeflendi: `lib/env.ts`, `lib/auth/*`, `lib/email/mailer.ts`, `lib/db.ts`, `server/services/auth-service.ts`, `server/services/invitation-service.ts`, `server/services/organization-service.ts`, `app/actions/*.ts`, `prisma/schema.prisma`, `.github/workflows/ci.yml`, `next.config.ts`, `docker-compose.yml`, `.env.example`. Geniş, tüm-repo taraması yapılmadı; bu belgedeki bulgular yukarıdaki dosyaların doğrudan okunmasına dayanır.
- **Doğrulama:** `npm audit`, `npm run lint`, `npm run typecheck`, `npm run test`, `npm run build` bu incelemede fiilen çalıştırıldı (bkz. §4 ve rapor sonu).

---

## 0. Uygulama notu (YF-506 — çözüldü)

Aşağıdaki §1 ve §2, bu belgenin orijinal (salt inceleme) sürümüne aittir ve
bulundukları hâliyle tarihsel kayıt olarak korunmuştur. **R-1 ve R-2**,
`fix/yf-506-env-smtp-hardening` dalında çözülmüştür:

- `lib/env.ts` artık tek yetkili, tipli ve donmuş (immutable) env doğrulama
  noktasıdır; `instrumentation.ts`'in `register()` kancası aracılığıyla her
  sunucu başlangıcında (`next start`/`next dev`, Node.js runtime) çağrılır.
  Eksik/güvensiz bir değişken varsa süreç ilk isteği karşılamadan çöker
  (doğrulandı: bkz. §11).
- Üretimde SMTP eksikse (`SMTP_HOST` yok) `getEnv()` başlangıçta hata
  fırlatır — dev outbox (§2'de anlatılan konsola yazma davranışı) artık
  üretimde **hiçbir zaman** tetiklenemez; `lib/email/mailer.ts` ayrıca
  savunma amaçlı ikinci bir fail-closed kontrolü de içerir.
- Doğrulama/parola sıfırlama/davet e-posta gönderim hataları artık
  gizlenmez (bkz. §11 "E-posta hata davranışı").

§1 ve §2'deki tablolar ve gözlemler, bu değişiklikten önceki durumu
yansıtır; hâlâ okunmaya değerdir çünkü *neden* bu tasarım kararlarının
alındığını açıklar. Güncel, yetkili sözleşme için §11'e bakın.

---

## 1. Ortam değişkenleri

`lib/env.ts` bir Zod şeması ile `process.env`'i doğrular, ancak **`getEnv()` fonksiyonu kod tabanının hiçbir yerinde çağrılmıyor** (repo genelinde grep ile teyit edildi). Yani bu doğrulama şu an ölü koddur: uygulama başlangıcında hiçbir env değişkeni doğrulanmaz; eksik/bozuk bir değişken yalnızca ona ilk erişildiğinde (örn. Prisma bağlantı hatası, `NaN` SMTP portu) çalışma zamanında ortaya çıkar.

| Değişken | Zorunlu (şemada) | Fiilen kullanıldığı yer | Üretim gereksinimi |
|---|---|---|---|
| `NODE_ENV` | Hayır (default `development`) | `lib/db.ts` (log seviyesi, global Prisma cache), `lib/auth/session.ts` (cookie `secure` bayrağı) | Barındırma platformunun `production` olarak ayarlaması **zorunlu**; `next start` bunu otomatik yapar ama özel süreç yöneticileriyle (pm2, systemd) elle export edilmesi unutulmamalı. |
| `DATABASE_URL` | Evet | `prisma/schema.prisma` → tüm DB erişimi | Üretimde `.env.example`/`docker-compose.yml`'deki `yapifin_dev_password` **kesinlikle kullanılmamalı**; ayrı, rastgele üretilmiş parola ve ayrı bir üretim veritabanı örneği gerekir. |
| `AUTH_SECRET` | Evet, min. 16 karakter | **Hiçbir yerde okunmuyor.** `lib/auth/session.ts` oturumları `crypto.randomBytes(32)` ile üretilen opak token + SHA-256 hash olarak DB'de tutuyor (`lib/auth/tokens.ts`); JWT imzalama yok. | Şema zorunlu tutuyor ama kod kullanmıyor — muhtemelen ileride planlanan Auth.js entegrasyonundan (README: "Auth.js veya eşdeğer") kalan bir alan. Üretime çıkmadan önce ya (a) `getEnv()` gerçekten çağrılıp bu değişken kaldırılmalı, ya da (b) gelecekte imzalama için kullanılacaksa amacı dokümante edilmeli. Şu haliyle `.env.example`'daki `change-me-with-a-long-random-secret` değeri prod'a taşınsa bile **hiçbir güvenlik etkisi olmaz** — bu yanıltıcıdır. |
| `NEXT_PUBLIC_APP_URL` | Hayır (default `http://localhost:3000`) | `lib/email/mailer.ts` → davet/doğrulama/sıfırlama linklerinin domaini | Üretimde gerçek `https://` domain zorunlu; `http://localhost:3000` olarak kalırsa gönderilen tüm e-posta linkleri kırık olur. `NEXT_PUBLIC_*` önekli olduğu için istemci tarafına da gömülür — hassas değil ama yanlış değer sessizce e-posta linklerini bozar. |
| `NEXT_PUBLIC_APP_NAME` | Hayır (default `YapiFin`) | `app.config.ts` üzerinden marka metni | Düşük risk. |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASSWORD` / `SMTP_FROM` | Hayır (opsiyonel) | `lib/email/mailer.ts` | Bkz. §2 — `SMTP_HOST` boşsa uygulama **hatasız** çalışmaya devam eder ama e-posta hiç gönderilmez. Üretimde bu değişken grubunun eksiksiz set edildiğini doğrulayan bir dağıtım kontrolü (health check veya deploy-time assertion) yok. |
| `SMTP_PASSWORD` | — | `lib/email/mailer.ts` | Sır olarak saklanmalı (secret manager); repoya veya build loglarına asla yazılmamalı. |
| `AUTH_URL` | — | **`.env.example`'da var, `lib/env.ts` şemasında ve kodda hiç yok.** | Kullanılmayan, kafa karıştırıcı bir kalıntı. Kaldırılması veya gerçekten kullanılacaksa (örn. bir OAuth callback base URL'i) şemaya eklenmesi önerilir. |
| `S3_ENDPOINT`, `S3_REGION`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | — | Kod tabanında hiç referans yok (`.env.example` yorumu: "sonraki faz") | Şu an devre dışı; dosya yükleme özelliği (docs/SECURITY.md §5 "Dosya yüklemede mime/uzantı/boyut kontrolü") uygulanana kadar üretim için gerekli değil. |

**Sırlar için genel öneri:** `.env` dosyaları yerine barındırma platformunun secret store'u (Vercel/Fly/Render env secrets, Docker secrets, Vault vb.) kullanılmalı; `AUTH_SECRET`, `DATABASE_URL`, `SMTP_PASSWORD` CI/CD loglarına asla basılmamalı. `.github/workflows/ci.yml` şu an `ci-secret-not-for-production-0000000000` gibi anlaşılır bir CI-only değer kullanıyor — bu doğru pratik, üretim secret'larıyla karıştırılmamalı.

**Asla geliştirme varsayımıyla üretime çıkmaması gerekenler:** `AUTH_SECRET` (şema kontrolü olsa da anlamsız — bkz. yukarı), `DATABASE_URL`, `SMTP_PASSWORD`, `NEXT_PUBLIC_APP_URL`, `NODE_ENV`.

---

## 2. E-posta gönderimi

`lib/email/mailer.ts` üç akışı besliyor: davet (`sendInvitationEmail`), e-posta doğrulama (`sendVerificationEmail`), parola sıfırlama (`sendPasswordResetEmail`).

**Geliştirme çıkışı (dev outbox) vs. üretim gönderimi:** `SMTP_HOST` tanımlı değilse `sendMail()` e-postayı göndermeden JSON log satırı yazıp **başarılı döner** (`lib/email/mailer.ts:14-27`). Bu MVP geliştirme için kullanışlı, ancak üretimde `SMTP_HOST` yanlışlıkla boş bırakılırsa (deploy hatası, unutulan secret) uygulama **sessizce** dev-outbox moduna düşer: kullanıcılar hiç e-posta almaz, hata da fırlatılmaz, log satırında token/link düz metin olarak görünür. Üretim ortamı için önerilen: `NODE_ENV === "production"` iken `SMTP_HOST` boşsa `getEnv()`'in (bkz. §1) uygulama başlangıcında hata fırlatması.

**Yeniden deneme ve hata davranışı:** Nodemailer gönderimi başarısız olursa (`transport.sendMail` reddi) `sendMail()` hatayı olduğu gibi yukarı fırlatır — retry/backoff yok. Çağıran taraflarda tutarsızlık var:

- `registerOwnerAndOrganization` (`server/services/organization-service.ts:132-134`) gönderim hatasını `.catch()` ile yakalayıp `console.error` ile loglar; kayıt işlemi başarısız olmaz, kullanıcı sonradan "doğrulama e-postasını yeniden gönder" ile tekrar deneyebilir.
- `resendVerificationEmail`, `requestPasswordReset` (`server/services/auth-service.ts:44-64`) ve `createInvitation`/`resendInvitation` (`server/services/invitation-service.ts:59-64`, `82-87`) gönderim hatasını **yakalamıyor**. DB kaydı (token/davet) zaten oluşturulmuş olur, ardından `sendMail` reddedilirse istisna server action'a kadar yükselir, `toActionError` genel bir Türkçe hata mesajı gösterir (`lib/action-state.ts:9-15`) ve konsola tam hata basılır — ama kullanıcıya "tekrar deneyin" dışında bir yol sunulmaz; arka planda geçerli bir token DB'de asılı kalır.
- Bu asimetri, üretimde SMTP geçici olarak kesintiye uğradığında davet/parola sıfırlama akışlarının kullanıcıya belirsiz bir hata olarak yansımasına yol açar; izlenebilirlik de yok (bkz. §8).

**SMTP gereksinimleri:** `lib/email/mailer.ts:30-37` `SMTP_PORT`'u `465` ile karşılaştırarak `secure` bayrağını belirliyor (465 → TLS-wrapped, aksi halde STARTTLS varsayımı — 587 için doğru). `SMTP_USER` boşsa `auth` tanımlanmıyor; bu, kimliksiz açık relay senaryosunu da mümkün kılıyor — üretimde `SMTP_USER`/`SMTP_PASSWORD` çiftinin gerçekten set edildiği ayrıca doğrulanmalı. `SMTP_FROM` için domain SPF/DKIM/DMARC kaydı olmadan gönderilen postalar spam'e düşer; bu, uygulama kapsamı dışında bir DNS/e-posta sağlayıcı görevidir ama launch checklist'inde yer almalı.

**Bağımlılık riski:** `nodemailer@6.9.16` birden fazla yüksek/orta önemde CVE'ye sahip (SMTP komut enjeksiyonu, `raw`/`envelope` üzerinden SSRF/dosya okuma — bkz. §4). Uygulama şu an `to`/`subject`/`text`/`html` dışında kullanıcıdan `raw` veya `envelope.size` almıyor, dolayısıyla en kritik CVE'ler (`raw` bypass, `envelope.size` enjeksiyonu) şu an doğrudan tetiklenemez; yine de sürüm yükseltmesi önerilir (bkz. §4, breaking).

---

## 3. Rate limiting

`lib/auth/rate-limit.ts` bellek-içi bir `Map` kullanıyor: 15 dakikalık pencerede anahtar başına 10 deneme, kod içi yorumla açıkça "tek instance için yeterli, çok instanslı üretimde Redis'e taşınmalı" diye işaretlenmiş.

**Şu an nerede kullanılıyor:** Yalnızca `loginAction` (`app/actions/auth.ts:39-43`), anahtar `login:${ip}:${email}`.

**Rate limit'i olmayan, hassas uç noktalar:**

- `forgotPasswordAction` (`app/actions/auth.ts:59-66`) — e-posta numaralandırma saldırısı `requestPasswordReset`'in her durumda aynı yanıtı dönmesiyle zaten engellenmiş, ama sınırsız istek SMTP kotasını tüketebilir / hedef kutuyu spam'leyebilir.
- `resendVerificationAction` (`app/actions/auth.ts:81-86`) — oturum açmış bir kullanıcı bu action'ı sınırsız çağırıp kendi (veya paylaşılan) e-posta adresini bombalayabilir.
- `createInvitation` / `resendInvitation` (`server/services/invitation-service.ts`) — bir ADMIN/OWNER hesabı ele geçirilirse veya kötüye kullanılırsa, sınırsız davet e-postası üçüncü taraf kutulara gönderilebilir.
- `acceptInvitationAction` / token'la çalışan uç noktalar (`verify-email/[token]`, `reset-password/[token]`, `invite/[token]`) — token'lar 32 byte rastgele (`crypto.randomBytes(32)`) olduğundan kaba kuvvetle tahmin pratik değil, ancak yine de istek başına hız sınırı olmaması DoS/kaynak tüketimi açısından savunmasız bırakır.

**Çoklu instance sınırlaması:** `Map` süreç-içi olduğundan yatay ölçeklenen (birden fazla Next.js/Node process'i, container replikası veya serverless fonksiyon örneği) bir dağıtımda her instance kendi sayaç setini tutar. Bir saldırgan istekleri replikalar arasında dağıtarak (ki bir load balancer bunu otomatik yapar) limiti fiilen etkisiz kılabilir. Ayrıca `Map` girdileri yalnızca aynı anahtara tekrar erişildiğinde temizleniyor (`entry.resetAt < now` kontrolü) — hiç tekrar sorgulanmayan anahtarlar için proaktif bir temizlik/TTL yok; uzun süre çalışan tek bir process'te çok sayıda benzersiz IP/e-posta kombinasyonu biriktikçe bellek büyür (düşük öncelikli ama gerçek bir sızıntı).

**Önerilen Redis geçiş yolu:**

1. `ioredis` (veya mevcut hosting'in yönettiği bir Redis) ekleyip `INCR` + `EXPIRE` atomik deseniyle (ya da `rate-limiter-flexible` gibi hazır bir kütüphaneyle Redis store) `checkRateLimit`'i aynı imzayla yeniden yaz — çağıran taraflarda (`app/actions/auth.ts`) değişiklik gerekmez.
2. Anahtar şemasını koru (`login:${ip}:${email}` gibi), yeni uç noktalar için `forgot-password:${ip}:${email}`, `resend-verification:${userId}`, `invitation-create:${organizationId}`, `invitation-resend:${invitationId}` gibi ayrı anahtarlarla sınırla.
3. Sıkı limit gereken uç noktalar (öncelik sırasıyla): giriş (mevcut), parola sıfırlama isteği, e-posta doğrulama yeniden gönderimi, davet oluşturma/yeniden gönderme, hesap oluşturma (`registerOwnerAction`).

---

## 4. `npm audit`

`npm ci` sonrası (`node_modules` bu worktree'de mevcut değildi, taze kuruldu) `npm audit --json` çalıştırıldı: **12 zafiyet — 1 kritik, 7 yüksek, 4 orta.**

| Paket | Direct/Transitive | Runtime/Dev | Önem | Şu an istismar edilebilir mi? | Düzeltme | Kırıcı mı? |
|---|---|---|---|---|---|---|
| `next` (16.2.5) | Direct | **Runtime** | Yüksek | Middleware/proxy bypass, Server Action SSRF/DoS, cache karışıklığı CVE'leri `>=16.0.0 <16.2.11` aralığını etkiliyor. Uygulama özel middleware/rewrite kullanmıyor (middleware.ts yok) ama Server Actions yoğun kullanılıyor (`app/actions/*.ts`) — saldırı yüzeyi teorik olarak mevcut. | `next@16.3.0` | **Hayır** (`isSemVerMajor: false`) — güvenli/uygulanabilir bir yükseltme, bu incelemede uygulanmadı. |
| `nodemailer` (6.9.16) | Direct | **Runtime** (e-posta) | Yüksek | `raw`/`envelope.size` kullanıcı girdisinden beslenmiyor → en kritik CVE'ler şu an tetiklenemez; yine de eski sürüm birikmiş risk taşıyor. | `nodemailer@9.0.4` | **Evet** — major, API değişikliği olasılığı var, kod incelemesi gerektirir. |
| `postcss` | Transitive (`next`, `@tailwindcss/postcss` üzerinden) | Build-time (CSS derleme) | Yüksek | Saldırgan kontrollü CSS/sourcemap gerektirir; uygulama yalnızca kendi yazdığı Tailwind CSS'ini derliyor → düşük gerçek risk. | `next`/`tailwindcss` yükseltmesiyle otomatik çözülür | `next` üzerinden hayır. |
| `sharp` | Transitive (`next` → opsiyonel, Image Optimization API) | Runtime (yalnızca kullanılırsa) | Yüksek | Kod tabanında `next/image` bileşeni **hiç kullanılmıyor** (yalnızca `next-env.d.ts` referansı) → şu an ölü kod yolu, istismar edilemez. | `next@16.3.0` ile düzelir | Hayır. |
| `vite`, `vite-node`, `@vitest/mocker` | Transitive (`vitest` üzerinden) | **Dev-only** (test çalıştırıcı) | Orta/Yüksek | Üretime hiç taşınmıyor; yalnızca `vitest --ui` ağa açık çalıştırılırsa anlamlı — proje bunu kullanmıyor (`npm run test` → `vitest run`). | `vitest@4.1.10` | **Evet** — major. |
| `vitest` (2.1.8) | Direct (devDependency) | **Dev-only** | **Kritik (9.8)** | CVE, "Vitest UI server dinlerken" senaryosuna özgü; bu proje UI modunu kullanmıyor → şu an istismar edilemez, ama CI/geliştirici makinelerinde yanlışlıkla `--ui` ile çalıştırılmamalı. | `vitest@4.1.10` | **Evet** — major (v2 → v4). |
| `@tailwindcss/postcss` (^4) | Direct (devDependency) | Build-time | Orta | `postcss` üzerinden, düşük gerçek risk (yukarı bkz.) | `npm audit fix` ile kırıcı olmayan düzeltme mevcut | Hayır. |
| `brace-expansion` | Transitive (`eslint`/`typescript-eslint` → `minimatch`) | **Dev-only** tooling | Yüksek (ReDoS) | Lint aracı saldırgan kontrollü girdi üzerinde çalışmıyor → istismar edilemez. | `npm audit fix` ile kırıcı olmayan düzeltme mevcut | Hayır. |
| `js-yaml` | Transitive (`eslint` → `@eslint/eslintrc`) | **Dev-only** tooling | Yüksek (ReDoS) | Aynı şekilde çalışma zamanında erişilemez. | `npm audit fix` ile kırıcı olmayan düzeltme mevcut | Hayır. |

**Özet ve öneri:**

- **Öncelik 1 (üretim çalışma zamanı, kırıcı olmayan):** `next` → `16.3.0`. `postcss` ve `sharp` zafiyetleri bu yükseltmeyle otomatik kapanır. Ayrı bir PR'da uygulanmalı, ayrı test edilmeli.
- **Öncelik 2 (üretim çalışma zamanı, kırıcı):** `nodemailer` → `9.0.4`. `lib/email/mailer.ts`'deki `createTransport`/`sendMail` çağrı imzası v9'da değişmiş olabilir; yükseltme sonrası davet/doğrulama/sıfırlama e-postaları manuel test edilmeli.
- **Öncelik 3 (yalnızca dev, kırıcı):** `vitest` ailesi → v4. Test dosyaları (`tests/*.test.ts`) ve `vitest.config.ts` v3/v4 API farklarına göre gözden geçirilmeli; üretim davranışını etkilemez, MVP lansmanını **bloklamaz**.
- **Öncelik 4 (dev tooling, kırıcı değil):** `@tailwindcss/postcss`, `brace-expansion`, `js-yaml` → `npm audit fix` (force gerekmez).
- Bu incelemede **hiçbir paket sürümü değiştirilmedi**; yukarıdaki sıralama sonraki bir görev için önerilir.

---

## 5. Veritabanı işlemleri

- **Migration dağıtımı:** `package.json` içinde `prisma:migrate:deploy` (`prisma migrate deploy`) tanımlı ve `.github/workflows/ci.yml:49-50`'de her PR/main push'ta çalıştırılıyor — doğru desen. Üretim dağıtımında da build/start öncesinde aynı komutun çalıştırılması gerekir (bkz. §7).
- **Tek migration:** Şu an yalnızca `20260805125134_init` var; şema hâlâ hızlı değişiyor olabileceğinden ileri migration'larda `migrate dev` ile üretilen dosyaların gözden geçirilip (özellikle `NOT NULL` kolon eklemeleri, kolon tipi değişiklikleri) geriye dönük uyumluluğu değerlendirilmesi gerekecek.
- **Bağlantı havuzlama:** `lib/db.ts` tek bir `PrismaClient` örneği oluşturuyor (Next.js dev sıcak-yeniden-yükleme için `globalForPrisma` cache deseni doğru uygulanmış), ama `DATABASE_URL`'de veya Prisma yapılandırmasında **connection pooling parametresi yok** (`connection_limit`, `pool_timeout` veya PgBouncer/Prisma Accelerate). Serverless/çoklu-instance bir dağıtımda (örn. Vercel + her fonksiyon çağrısında yeni process) bu, PostgreSQL bağlantı limitine hızla çarpma riski taşır. Klasik Node sunucusu (tek uzun-ömürlü process, `next start`) için mevcut kurulum kabul edilebilir.
- **Yedekleme:** Repository içinde yedekleme scripti/otomasyonu yok; `docs/ARCHITECTURE.md` §10 "Günlük DB yedeği" öneriyor ama bu bir uygulama görevi değil, barındırma/altyapı görevi — launch checklist'ine eklenmeli (örn. yönetilen Postgres sağlayıcısının otomatik yedeği + saklama süresi politikası).
- **Restore testi:** Hiç doğrulanmamış; bir yedeğin gerçekten geri yüklenebildiğini kanıtlayan bir runbook/tatbikat yok. Finansal veri tutan bir üründe bu, launch-blocker düzeyinde bir eksik olarak değerlendirilmeli (bkz. Risk kaydı R-5).
- **Üretim seed kısıtlaması:** Repository'de hiçbir seed script'i yok (`package.json`'da `prisma:seed` tanımlı değil, `scripts/` altında yalnızca `publish-initial-repository.ps1` var). Bu, "yanlışlıkla prod'a demo veri seed'lenmesi" riskini şu an ortadan kaldırıyor; ileride bir seed script eklenirse `NODE_ENV !== "production"` koruması **başından itibaren** eklenmeli.

---

## 6. Güvenlik kontrol listesi

| Kontrol | Durum | Not |
|---|---|---|
| Güvenli çerezler | ✅ Kısmen | `lib/auth/session.ts:45-51` `httpOnly: true`, `sameSite: "lax"`, `secure: NODE_ENV === "production"`. `secure` bayrağının doğru davranması için barındırma ortamının `NODE_ENV=production` set etmesi **şart**. |
| HTTPS | ⚠️ Uygulama sorumluluğunda değil | Next.js kendi başına TLS terminasyonu yapmaz; reverse proxy/CDN katmanında zorunlu kılınmalı (docs/ARCHITECTURE.md §10 "Reverse proxy" öneriyor). Uygulama tarafında HTTPS'i zorlayan bir yönlendirme/HSTS header'ı yok. |
| CSRF | ✅ Büyük ölçüde | Next.js Server Actions varsayılan olarak `Origin`/`Host` header eşleşmesi kontrolü yapar (framework düzeyinde). Cookie `sameSite: "lax"` ek bir katman sağlıyor. Özel bir CSRF token mekanizması yok ama mevcut mimaride (yalnızca Server Actions, klasik REST API endpoint'i yok) gerekli değil. |
| Oturum sonlandırma | ✅ | Parola sıfırlandığında tüm oturumlar siliniyor (`auth-service.ts:76`, `db.session.deleteMany`); kullanıcı `SUSPENDED` yapıldığında oturumlar sonlandırılıyor (test: `tests/user-management.test.ts` → "pasifleştirilen kullanıcının tüm oturumları sonlandırılır", bu incelemede **geçti**). `getSessionUser` her istekte DB'den taze okuyor (`lib/auth/session.ts:64-69` yorumu), JWT süre dolumu beklemiyor. |
| Tenant izolasyonu | ✅ | `tests/tenant-isolation.test.ts` (3 test, bu incelemede geçti) organizasyonlar arası veri sızıntısı ve bilinen ID ile doğrudan erişim senaryolarını kapsıyor. Servis katmanı fonksiyonları (`invitation-service.ts`, vb.) tutarlı biçimde `actor.organizationId` ile scope ediyor. |
| Hassas veri olmadan loglama | ⚠️ Kısmi risk | `lib/email/mailer.ts:17-25` dev-outbox modunda **token'ı düz metin olarak** stdout'a yazıyor — geliştirme için kasıtlı ve dokümante edilmiş, ama bu kod yolu üretimde `SMTP_HOST` boş kalırsa da çalışır (bkz. §2). `lib/action-state.ts:13` ve `organization-service.ts:133` beklenmeyen hataları `console.error` ile logluyor; bu hata nesneleri kullanıcı girdisi (email, form alanları) içerebilir ama parola/token içermez. Yapılandırılmış/redakte edilmiş bir logger (pino/winston + alan maskesi) yok; şu an düz `console.*`. |
| Parola işleme | ✅ | `bcryptjs`, `SALT_ROUNDS = 12` (`lib/auth/password.ts`) — kabul edilebilir bir maliyet faktörü. Parolalar hiçbir yerde loglanmıyor/geri döndürülmüyor. |
| Token işleme | ✅ | Tüm token'lar (`generateToken`, `lib/auth/tokens.ts`) `crypto.randomBytes(32)` ile üretiliyor, DB'de yalnızca SHA-256 hash'i tutuluyor — ham değer sadece kullanıcıya (cookie/e-posta linki) gidiyor. DB sızıntısı tek başına oturum/token ele geçirmeye yetmiyor. |
| Güvenlik header'ları (CSP, X-Frame-Options, HSTS vb.) | ❌ Yok | `next.config.ts` içinde `headers()` tanımı yok, `middleware.ts` dosyası yok. Üretime çıkmadan önce en azından `Strict-Transport-Security`, `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY` (veya `frame-ancestors` CSP direktifi), temel bir `Content-Security-Policy` eklenmesi önerilir. |

---

## 7. CI/CD ve dağıtım

**Mevcut CI (`\.github/workflows/ci.yml`):** `push: [main]` ve her `pull_request`'te tetikleniyor; sıra: `npm ci` → `lint` → `typecheck` → `prisma migrate deploy` (CI'nin kendi Postgres servisine karşı) → `test` → `build`. Bu, mantıklı bir sıralama (statik kontroller önce, sonra DB'ye bağımlı adımlar).

**Merge öncesi zorunlu kontroller (önerilen):** Şu an branch protection kuralları bu inceleme kapsamında doğrulanamadı (GitHub ayarları repo dışı). Önerilen minimum: `lint-typecheck-test-build` job'ının PR'da **zorunlu status check** olarak işaretlenmesi, doğrudan `main`'e push'un engellenmesi, en az 1 review zorunluluğu.

**Migration sırası:** Üretim dağıtımında migration'ların **yeni kod deploy edilmeden önce** uygulanması gerekir (`prisma migrate deploy`, ardından `next build` + `next start`). Mevcut CI bunu doğru sırayla test ediyor ama gerçek üretim dağıtım pipeline'ı (Vercel/Docker/vb.) bu repo içinde tanımlı değil — bir dağıtım scripti veya platform yapılandırması (örn. Vercel "Build Command" öncesi migration hook'u, ya da Docker entrypoint'inde `prisma migrate deploy && next start`) eklenmesi gerekiyor.

**Build/start komutları:** `package.json` → `build: "next build"`, `start: "next start"`. Bu incelemede `next build` başarıyla tamamlandı (bkz. rapor sonu). `postinstall: "prisma generate"` her `npm install`/`npm ci` sonrası otomatik çalışıyor — doğru.

**Rollback prosedürü:** Repo içinde tanımlı bir rollback runbook'u yok. Prisma migration'ları varsayılan olarak geri alınabilir değildir (`prisma migrate deploy` yalnızca ileri gider); bir migration üretimde soruna yol açarsa iki seçenek var: (a) önceki uygulama sürümüne dön + yeni bir "geri alma" migration'ı yaz (tercih edilen, çünkü veri kaybı riskini azaltır), (b) DB'yi yedekten geri yükle (bkz. §5, restore testi yapılmamış). Bu prosedürün yazılı hale getirilmesi ve en az bir kez tatbik edilmesi önerilir.

**Health check önerisi:** Kod tabanında `/api/health` veya benzeri bir health-check endpoint'i yok. Barındırma platformunun (load balancer, orchestrator) uygulamanın ayakta olduğunu ve DB'ye erişebildiğini doğrulayabilmesi için basit bir `GET /api/health` (DB'ye `SELECT 1` atan) endpoint'i eklenmesi önerilir — bu, mevcut kodu değiştirmeden yapılabilecek küçük, izole bir görevdir.

---

## 8. İzleme (monitoring)

Repository'de şu an harici bir hata izleme/APM entegrasyonu yok (`docs/ARCHITECTURE.md` §9 "Hata izleme entegrasyonuna hazır yapı" diyor — yani planlanmış ama uygulanmamış). Aşağıdaki alanların üretim öncesi netleştirilmesi gerekiyor:

- **Uygulama hataları:** Şu an yalnızca `console.error` (bkz. §6 tablo). Bir hata izleme servisi (Sentry vb.) entegre edilmeli; özellikle `lib/action-state.ts:13`'teki genel `catch` bloğu iyi bir enjeksiyon noktası.
- **Başarısız e-posta gönderimi:** Hiç loglanmıyor/metriklenmiyor (bkz. §2 — bazı akışlarda hata tamamen yutuluyor, bazılarında yalnızca console'a düşüyor). SMTP gönderim başarı/başarısızlık oranı için ayrı bir metrik/uyarı önerilir.
- **Başarısız giriş ve rate-limit olayları:** `checkRateLimit` sınıra ulaşıldığında (`allowed: false`) herhangi bir log/metrik üretmiyor (`lib/auth/rate-limit.ts`) — yalnızca kullanıcıya Türkçe hata mesajı dönüyor. Kaba kuvvet/credential-stuffing tespiti için bu olayların loglanması (IP, zaman, hedef e-posta — parola **hariç**) önerilir.
- **Veritabanı sağlığı:** Bağlantı havuzu doygunluğu, yavaş sorgular için bir izleme yok; §7'deki health-check endpoint'i ve barındırma platformunun kendi Postgres metrikleri (CPU, bağlantı sayısı, disk) asgari başlangıç noktası olmalı.
- **Audit log izleme:** `AuditLog` tablosu doğru olaylarda yazılıyor (kullanıcı daveti/kabulü, parola sıfırlama, organizasyon/kullanıcı oluşturma — `lib/audit.ts` ve çağıran servisler doğrulandı), ama bu tabloyu **okuyan** hiçbir arayüz/rapor/alarm yok. Kritik aksiyonlar (örn. kısa sürede çok sayıda rol değişikliği, olağandışı saatte organizasyon ayarı değişikliği) için bir izleme/uyarı katmanı yok — bu, MVP'nin finansal modüllerine geçmeden önce ele alınmalı.

---

## 9. Risk kaydı

| ID | Risk | Önem | Mevcut durum | Üretim etkisi | Önerilen aksiyon | MVP lansmanını bloklar mı? |
|---|---|---|---|---|---|---|
| R-1 | `getEnv()` hiç çağrılmıyor; env doğrulaması çalışma zamanında etkisiz | Yüksek | `lib/env.ts` tanımlı ama kullanılmıyor | Eksik/bozuk bir env değişkeni uygulama açılışında değil, ilk kullanıldığı istekte (kullanıcıya yansıyan bir hata olarak) ortaya çıkar | `getEnv()`'i uygulama başlangıcında (örn. `instrumentation.ts` veya `lib/db.ts` importunda) çağır; `AUTH_SECRET`'in gerçek kullanımını netleştir veya şemadan çıkar | **Evet** |
| R-2 | SMTP yanlış yapılandırılırsa (`SMTP_HOST` boş) üretimde e-posta sessizce gönderilmiyor | Yüksek | `lib/email/mailer.ts:15-27` | Kullanıcılar davet/doğrulama/parola sıfırlama e-postası hiç almaz, sistem hata vermez | Üretimde `SMTP_HOST` zorunlu kıl (R-1'e bağlı `getEnv()` ile); dev-outbox davranışını yalnızca `NODE_ENV !== "production"` ile sınırla | **Evet** |
| R-3 | Rate limiting tek process'e bağlı, çoğu hassas uç noktada yok | Orta-Yüksek | `lib/auth/rate-limit.ts`, yalnızca login'de kullanılıyor | Çoklu instance dağıtımda etkisiz; parola sıfırlama/davet/doğrulama-tekrar-gönder sınırsız tetiklenebilir | Redis tabanlı paylaşımlı rate limiter'a geç (bkz. §3); eksik uç noktalara limit ekle | Tek instance dağıtım için hayır; yatay ölçekleme planlanıyorsa evet |
| R-4 | Bilinen CVE'li doğrudan bağımlılıklar (`next`, `nodemailer`, `vitest`) | Yüksek (next, nodemailer runtime) / Kritik ama dev-only (vitest) | §4'te detaylı — **`next` kısmı YF-507'de, `nodemailer` kısmı YF-508'de çözüldü, bkz. §12/§13** | `next`/`nodemailer` güncel değilse bilinen istismar tekniklerine (kısmen) açık yüzey taşır | `next@16.3.0`'a kırıcı olmayan yükseltme (öncelik 1) — **uygulandı**; `nodemailer@9.0.4`'e kırıcı majör yükseltme (öncelik 2) — **uygulandı** | `next` yükseltmesi olmadan **evet** (üretim runtime CVE'si) — **artık hayır**; `vitest` yükseltmesi hâlâ ayrı, dev-only görev, MVP lansmanını bloklamaz |
| R-5 | Yedek geri yükleme (restore) hiç test edilmemiş | Yüksek | Yedekleme otomasyonu bile repo dışı, restore tatbikatı yok | Bir veri kaybı senaryosunda geri dönüş süresi/başarısı bilinmiyor | Yönetilen Postgres yedeği + en az bir kez restore tatbikatı + yazılı runbook | **Evet** (finansal veri tutan bir üründe) |
| R-6 | Güvenlik header'ları (CSP, HSTS, X-Frame-Options) yok | Orta | `next.config.ts`'de `headers()` yok, `middleware.ts` yok | Clickjacking, MIME sniffing, downgrade saldırılarına karşı ek bir katman eksik | `next.config.ts` `headers()` veya `middleware.ts` ile temel güvenlik header'larını ekle | Hayır (savunma derinliği eksikliği, tek başına kritik değil) — ama launch öncesi önerilir |
| R-7 | Health-check endpoint'i yok | Düşük-Orta | Kod tabanında yok | Orchestrator/load balancer uygulamanın/DB'nin sağlıklı olduğunu bilmiyor | `GET /api/health` (DB `SELECT 1`) ekle | Hayır, ama operasyonel görünürlük için önerilir |
| R-8 | Hata izleme/APM entegrasyonu yok | Orta | Yalnızca `console.error` | Üretimde sessiz hatalar fark edilmeyebilir | Sentry (veya eşdeğeri) entegre et; §8'deki tüm izleme boşluklarını kapat | Hayır, ama erken eklenmesi güçlü tavsiye edilir |
| R-9 | E-posta gönderim hatalarının bir kısmı yakalanmıyor (`requestPasswordReset`, `createInvitation`, `resendInvitation`) | Orta | §2'de detaylı | SMTP geçici kesintisinde kullanıcı belirsiz bir hata görür, token DB'de asılı kalır | Tutarlı bir `.catch()` + kullanıcıya "e-posta gönderilemedi, tekrar deneyin" mesajı + log/metrik | Hayır |
| R-10 | Bağlantı havuzlama parametresi yok | Düşük (tek-instance) / Orta (serverless) | `lib/db.ts`, tek `PrismaClient` | Serverless/çoklu-instance dağıtımda bağlantı limiti aşımı riski | Hedef barındırma modeli netleşince `connection_limit`/PgBouncer/Prisma Accelerate değerlendir | Hayır (mevcut tek-instance varsayımıyla) |

---

## Doğrulama sonuçları

Bu incelemede aşağıdaki komutlar `YapiFin-worktrees/production-review` içinde fiilen çalıştırıldı (önce `npm ci` ile bağımlılıklar kuruldu):

| Komut | Sonuç |
|---|---|
| `npm ci` | ✅ Başarılı (478 paket kuruldu; 12 zafiyet uyarısı — bkz. §4) |
| `npm audit` | ✅ Çalıştı, sonuçlar §4'te işlendi |
| `npm run lint` | ✅ Hatasız |
| `npm run typecheck` | ✅ Hatasız |
| `npm run test` | ⚠️ Ortam gereksinimi vardı, aşağıya bakın → sonrasında ✅ 4 test dosyası / 16 test geçti |
| `npm run build` | ✅ Başarılı (`next build`, Turbopack, 12 route) |

**`npm run test` engeli ve çözümü:** Test paketi (`tests/*.test.ts`, `tests/helpers.ts`) her testten önce gerçek bir PostgreSQL'e karşı `cleanDatabase()` çalıştırıyor ve `DATABASE_URL` ortam değişkeni gerektiriyor; bu değişken varsayılan kabukta tanımlı değildi ve ilk çalıştırmada `PrismaClientInitializationError: Environment variable not found: DATABASE_URL` ile 4 test dosyası da başarısız oldu. Uygulama davranışı değiştirilmeden, geçici ve izole bir Postgres konteyneri (`docker run ... postgres:16-alpine`, ayrı port `55432`, iş bitince kaldırıldı — mevcut `yapifin-postgres-1` geliştirme konteynerine dokunulmadı) ayağa kaldırıldı, `DATABASE_URL`/`AUTH_SECRET`/`NEXT_PUBLIC_APP_URL` yalnızca o kabuk oturumunda export edildi, `npx prisma migrate deploy` ile şema uygulandı ve testler bu geçici veritabanına karşı çalıştırıldı. Bu, `.github/workflows/ci.yml`'nin kendi Postgres servisiyle yaptığıyla aynı deseni yerel olarak tekrarlar. **Kalıcı bir öneri:** yerel geliştirme için bu adımların `README.md`'ye (veya bir `npm run test:local` script'ine) eklenmesi, her katkıda bulunanın aynı manuel adımları tekrar keşfetmesini önler — ancak bu, bu incelemenin "kod değiştirme" kısıtı dışında bırakıldı, sonraki görev olarak önerilir.

---

## Sonraki mantıklı görev (orijinal inceleme, tamamlandı)

`getEnv()`'i uygulama başlangıcına bağlamak ve `SMTP_HOST` için üretim zorunluluğu eklemek (R-1 + R-2), tek bir küçük, test edilebilir PR olarak ele alınabilir ve bu belgedeki en yüksek etkili/en düşük riskli düzeltmedir.

**Durum: `fix/yf-506-env-smtp-hardening` dalında uygulandı — bkz. §11.**

---

## 11. YF-506 — Nihai env sözleşmesi ve e-posta gönderim davranışı

### 11.1 Tek yetkili doğrulama noktası

`lib/env.ts`'deki `getEnv()`, tüm `process.env` okumalarının tek geçtiği
yerdir; sonucu donmuş (`Object.freeze`) ve bellek-içi önbelleklidir.
Servis/action/mailer katmanları artık ham `process.env.X` okumaz.

`instrumentation.ts`'in `register()` kancası — Next.js'in her sunucu
örneği (cold start) başladığında bir kez çağırdığı resmi kanca —
`NEXT_RUNTIME === "nodejs"` iken `getEnv()`'i çağırır. Doğrulama başarısız
olursa süreç, ilk isteği karşılamadan, açık ve sır içermeyen bir Türkçe
hata mesajıyla çöker.

**Doğrulanmış davranış (bu görevde fiilen test edildi, bkz. §12):**
`next build`, `register()`'ı çalıştırmaz (Next.js 16.2.5 — build, bir
sunucu örneği başlatmaz); dolayısıyla CI'nin `npm run build` adımı
`NEXT_PUBLIC_APP_URL=http://localhost:3000` gibi üretim-dışı değerlerle
bile güvenle çalışır. Gerçek geçit, `next start` (ve `next dev`) sırasında
çalışan `register()`'dır.

### 11.2 Değişken sözleşmesi

| Değişken | Her ortamda zorunlu mu? | Yalnızca üretimde ek kural |
|---|---|---|
| `NODE_ENV` | Hayır (varsayılan `development`) | — |
| `DATABASE_URL` | Evet — dolu ve `postgres(ql)://` biçiminde olmalı | `yapifin_dev_password` içeremez |
| `AUTH_SECRET` | Evet — en az 16 karakter | Üretimde en az **32** karakter VE placeholder olamaz (`change-me...`, `secret`, `password`, boş, vb. reddedilir) |
| `NEXT_PUBLIC_APP_URL` | Hayır (varsayılan `http://localhost:3000`) — mutlak URL olmalı | Üretimde `https://` zorunlu; **istisna:** `localhost`/`127.0.0.1`/`::1` (dokümante edilmiş, iç/test amaçlı istisna) |
| `NEXT_PUBLIC_APP_NAME` | Hayır (varsayılan `YapiFin`) | — |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_FROM` | Hayır (development/test'te boş bırakılabilir → dev outbox) | Üretimde **üçü de zorunlu** |
| `SMTP_USER` / `SMTP_PASSWORD` | Hayır | Her ortamda: ikisi birlikte tanımlanmalı veya ikisi de boş olmalı (yarım bırakılamaz). Üretimde ikisi de boşsa **güvenilir relay** (kimlik doğrulamasız SMTP) olarak kabul edilir — bilinçli bir tasarım kararıdır (bkz. 11.3). |

Doğrulama hatası mesajları yalnızca alan adı + kural adını içerir; hiçbir
zaman `AUTH_SECRET`, `SMTP_PASSWORD`, token veya `DATABASE_URL` içeriğini
içermez (bkz. `tests/env.test.ts` "hata mesajı sırları sızdırmaz").

### 11.3 Kararlar (açık ve dokümante edilmiş)

- **SMTP kimlik doğrulaması güvenilir relay için atlanabilir:** `SMTP_USER`/`SMTP_PASSWORD` ikisi de boşsa, üretimde bile kabul edilir (`env.smtp.auth = null`, nodemailer'a `auth: undefined` geçilir). Şirket içi/VPC içi bir relay (ör. AWS SES SMTP relay'i IAM rolüyle, veya ağ düzeyinde kısıtlı bir internal relay) için gereksiz kimlik bilgisi zorunluluğu getirmemek amacıyla. Yarım bırakılamaz kuralı (yalnızca biri set) her zaman reddedilir.
- **`NEXT_PUBLIC_APP_URL` için localhost istisnası:** Üretimde HTTPS zorunludur, ancak `localhost`/`127.0.0.1`/`::1` host'ları istisnadır — bu, iç/test dağıtımları (ör. bir reverse proxy arkasında yalnızca iç ağda çalışan bir doğrulama ortamı) için CLAUDE.md'nin "TLS terminasyonu reverse proxy katmanında yapılır" mimarisiyle uyumludur. Gerçek bir public-facing üretim dağıtımında operasyon ekibi bu değişkeni gerçek `https://` domain'e ayarlamakla yükümlüdür — kod bunu zorunlu kılamaz çünkü localhost aynı zamanda meşru bir iç dağıtım senaryosudur.
- **Üretimde SMTP eksikse dev outbox'a düşülmez (fail-closed):** `getEnv()` başlangıçta engeller; `lib/email/mailer.ts`'deki `sendMail()` ayrıca ikinci bir savunma katmanı olarak `NODE_ENV === "production" && !env.smtp` durumunda hata fırlatır (env doğrulaması bir şekilde atlanmışsa bile).
- **E-posta gönderim hatası asla yutulmaz, ama akışa göre farklı işlenir** (bkz. 11.4) — anonim/numaralandırmaya açık akışlarda (parola sıfırlama isteği) çağırana yansıtılmaz (yalnızca güvenli loglanır), kimlik doğrulamalı/idempotent akışlarda (yeniden gönder, davet) çağırana `ServiceError` olarak yansıtılır.
- **Organizasyon kaydı e-posta hatası için geri alınmaz:** `registerOwnerAndOrganization` işlemi (organizasyon + kullanıcı + varsayılan kategoriler + Ana Kasa) transaction içinde commit edilir; doğrulama e-postası bundan sonra, best-effort gönderilir. Ürün sözleşmesi atomik e-posta teslimatı istemiyor (CLAUDE.md kapsamı: finansal çekirdek + kayıt akışı; e-posta teslimatı bir yan etki, birincil işlem değil).

### 11.4 E-posta gönderim hata davranışı — akış bazında

| Akış | Dosya | E-posta hatasında davranış |
|---|---|---|
| Firma kaydı (`registerOwnerAndOrganization`) | `server/services/organization-service.ts` | Kayıt **geri alınmaz**. `verificationEmailSent: false` döner; `registerOwnerAction` bunu kullanıcıya dürüst bir Türkçe mesajla gösterir ("Hesabınız oluşturuldu, ancak doğrulama e-postası şu anda gönderilemedi...") ve oturum zaten açıldığı için manuel "Panele git" bağlantısı sunar (otomatik `redirect()` yalnızca e-posta başarılıysa tetiklenir). Hata güvenli şekilde loglanır (yalnızca `err.message`). |
| Parola sıfırlama isteği (`requestPasswordReset`) | `server/services/auth-service.ts` | Hata **çağırana yansıtılmaz** — anti-enumeration korunmalıdır (var olan/olmayan e-posta için aynı yanıt). Hata yalnızca güvenli şekilde (`err.message`, token/parola içermeden) loglanır. |
| Doğrulama e-postası yeniden gönder (`resendVerificationEmail`) | `server/services/auth-service.ts` | Oturum açmış kullanıcıya özel, anonim değil → `ServiceError("Doğrulama e-postası gönderilemedi...")` fırlatılır, `resendVerificationAction` bunu `toActionError` ile forma yansıtır. |
| Davet oluştur / yeniden gönder (`createInvitation`/`resendInvitation`) | `server/services/invitation-service.ts` | Davet DB kaydı **korunur** (yeniden gönderilebilir), ama `ServiceError` fırlatılır → çağıran action (`app/actions/users.ts`, zaten `toActionError` ile sarılı) asla "gönderildi" başarı mesajı döndürmez. |

### 11.5 Testler (`npm run test`)

- `tests/env.test.ts` — development/production/test için SMTP yok/eksik/tam, placeholder ve kısa `AUTH_SECRET`, geliştirme DB parolası reddi, HTTPS zorunluluğu + localhost istisnası, SMTP_USER/PASSWORD eşleşme kuralı, güvenilir relay (auth yok), donmuş sonuç, sır sızdırmayan hata mesajı.
- `tests/mailer.test.ts` — dev outbox (SMTP yok, nodemailer hiç çağrılmaz), üretimde SMTP yoksa fail-closed hata, gerçek SMTP parametreleriyle `nodemailer.createTransport` çağrısı (port 465→`secure:true`, 587→`secure:false`), güvenilir relay için `auth: undefined`, SMTP gönderim hatasının yutulmadan çağırana yansıması, `SMTP_PASSWORD`'ün hiçbir konsol çıktısına yazılmaması.
- `tests/email-delivery-failure.test.ts` — gerçek PostgreSQL'e karşı: kayıt e-postası başarısız olsa da organizasyon/kullanıcı DB'de kalır; parola sıfırlama var-olan/olmayan e-posta için e-posta hatasında bile aynı (fırlatmayan) sonucu verir; doğrulama yeniden gönderim ve davet oluştur/yeniden gönder hataları `ServiceError` olarak yansır ve davet kaydı silinmez.

### 11.6 Doğrulama sonuçları (bu görevde çalıştırıldı)

| Komut | Sonuç |
|---|---|
| `npm ci` (worktree: `YapiFin-worktrees/env-smtp-hardening`) | ✅ Başarılı |
| `npm run lint` | ✅ Hatasız |
| `npm run typecheck` | ✅ Hatasız |
| `npm run test` | ✅ 14 dosya / 98 test geçti (geçici, izole `yapifin-test-postgres` konteyneri, port 55432 — mevcut `yapifin-postgres-1` geliştirme konteynerine dokunulmadı) |
| `npm run build` | ✅ Başarılı; `next build` sırasında `register()` **çalışmadığı** doğrulandı (bkz. 11.1) |
| Manuel: `next start` + placeholder `AUTH_SECRET` + üretim + SMTP yok | ✅ Beklenen davranış: süreç `register()` hatasıyla anında çöktü, sır sızdırmadı |
| Manuel: `next start` + geçerli üretim yapılandırması + auth'suz relay | ✅ Beklenen davranış: sunucu hatasız ayağa kalktı |

### 11.7 Bilinen eksikler / sonraki adaylar

- E-posta gönderim hataları için ayrı bir metrik/alarm (bkz. §8, R-8) hâlâ yok — yalnızca `console.error` ile loglanıyor.
- Şirket-içi/relay SMTP senaryosu (auth yok) kod düzeyinde desteklenir ama gerçek bir relay'e karşı manuel olarak test edilmemiştir (yalnızca nodemailer çağrı parametreleri birim testinde doğrulandı).
- `next`/`nodemailer` sürüm yükseltmeleri bu görev kapsamı dışıdır (YF-507/YF-508).

---

## 12. YF-507 — Next.js güvenlik/stabilite yükseltmesi (16.2.5 → 16.3.0)

### 12.1 Kapsam değişikliği (görev başında onaylandı)

Görev talimatı, atama anında "harici olarak doğrulanmış güncel sürüm 16.2.12, 16.3.0 ise preview/canary" varsayımıyla yazılmıştı ve yalnızca 16.2.x hattında bir patch yükseltmesi istiyordu. Görev başında zorunlu koşulan doğrulama adımı (`npm view next version`, `npm view next dist-tags --json`) bu varsayımın artık geçersiz olduğunu ortaya çıkardı:

| Kontrol | Sonuç |
|---|---|
| `npm view next version` | `16.3.0` |
| `npm view next dist-tags --json` → `latest` | `16.3.0` (canary/beta/rc/preview soneki **yok** — gerçek, npm'in kendi tanımladığı stabil etiket) |
| Ayrı `preview` etiketi | `16.3.0-preview.10` (16.3.0'ın kendisinden farklı, daha erken bir sürüm) |
| `16.3.0` yayın tarihi | 2026-08-03 (bu görevden 2 gün önce) |
| En yüksek `16.2.x` patch | `16.2.12` (2026-07-25) |

Yani `16.3.0`, görev atandıktan **önce** preview'dan mezun olup npm'in gerçek `latest` etiketine geçmiş. Görev talimatının kendisi açıkça şunu şart koşuyordu: *"Stop and report if the latest npm stable version changes to a new minor or major during execution."* Bu koşul tetiklendi; iş durdurulup bulgu kullanıcıya raporlandı. Kullanıcı, bunu kazara kapsam genişlemesi değil **bilinçli bir kapsam değişikliği** olarak onayladı: hedef `16.2.12` yerine `16.3.0` stabil sürümü oldu. Bu belgedeki ve YF-507 görev talimatındaki "yalnızca 16.2.x" ifadeleri, bu onaylanmış değişiklikle geçersiz kılınmıştır.

`next@16.3.0` `peerDependencies`'i (`npm view next@16.3.0 peerDependencies --json`) `react`/`react-dom` için `^19.0.0` istiyor; repo zaten `19.2.4` üzerinde olduğundan React/React DOM'da **hiçbir değişiklik gerekmedi**. `engines.node` gereksinimi `>=20.9.0`; yerel ortam `v24.18.0`, CI (`\.github/workflows/ci.yml`) `node-version: 22` — ikisi de uyumlu.

### 12.2 Uygulanan bağımlılık değişiklikleri

Yalnızca iki doğrudan bağımlılık değişti (`npm install next@16.3.0 eslint-config-next@16.3.0 --save-exact`, `package-lock.json` npm tarafından yeniden üretildi — elle düzenlenmedi):

| Paket | Önce | Sonra |
|---|---|---|
| `next` | `16.2.5` | `16.3.0` |
| `eslint-config-next` | `16.2.5` | `16.3.0` |
| `react` | `19.2.4` | `19.2.4` (değişmedi) |
| `react-dom` | `19.2.4` | `19.2.4` (değişmedi) |

`prisma`, `nodemailer`, `recharts`, `zod`, `tailwindcss`, `vitest` ve diğer transitive bağımlılıklar bilinçli olarak dokunulmadı (bkz. §4 önceliklendirmesi — bunlar ayrı görevler: nodemailer→YF-508, vitest ailesi ayrı bir dev-only görev).

### 12.3 `npm audit` öncesi/sonrası

| | Önce (16.2.5) | Sonra (16.3.0) |
|---|---|---|
| Kritik | 1 | 1 |
| Yüksek | 7 | 5 |
| Orta | 4 | 4 |
| **Toplam** | **12** | **10** |

`next` (yüksek) ve `sharp` (yüksek, `next`'in optional Image Optimization bağımlılığı) zafiyetleri bu yükseltmeyle kapandı. `postcss` (yüksek) artık `next` üzerinden değil, doğrudan `@tailwindcss/postcss`'in kendi `postcss` bağımlılığı üzerinden geliyor — kırıcı olmayan ayrı bir düzeltmesi var (`npm audit fix`) ama bu görevin "yalnızca next ekosistemi" kapsamı dışında bırakıldı.

**Kalan bulguların çoğu geliştirme ve build araç zincirindedir. Nodemailer bulgusu production runtime dependency olarak ayrıca sınıflandırılmış ve kırıcı major yükseltme gerektirdiği için YF-508 kapsamında ertelenmiştir.** Kalan 10 bulgunun tam sınıflandırması aşağıdadır (hepsi bu görevden önce de bilinen, §4'te detaylandırılmış bulgular — hiçbiri bu yükseltmeyle yeni ortaya çıkmadı; **her bulgunun dev-only olduğu iddia edilmiyor ve hiçbirinin tamamen çözüldüğü iddia edilmiyor**):

| Paket | Direct/Transitive | Prod/Dev | Üretim çalışma zamanında istismar edilebilir mi? | Durum |
|---|---|---|---|---|
| `nodemailer` | Direct | **Prod runtime** | Hayır şu an (`raw`/`envelope.size` kullanıcı girdisinden beslenmiyor) | Ertelendi — YF-508 (majör sürüm, ayrı test gerektirir) |
| `postcss` | Transitive (`@tailwindcss/postcss`) | Dev/build-time | Hayır (yalnızca kendi Tailwind CSS'ini derliyor) | Ertelendi — kırıcı olmayan `npm audit fix` ile ayrı görevde |
| `@tailwindcss/postcss` | Direct (dev) | Dev/build-time | Hayır | Ertelendi |
| `vitest`, `vite`, `vite-node`, `@vitest/mocker`, `esbuild` | Direct/Transitive | **Dev-only** (test runner) | Hayır (`--ui` modu bu projede kullanılmıyor) | Ertelendi — majör sürüm (v2→v4), ayrı görev |
| `brace-expansion` | Transitive (`eslint`) | Dev-only tooling | Hayır | Ertelendi — kırıcı olmayan `npm audit fix` |
| `js-yaml` | Transitive (`eslint`) | Dev-only tooling | Hayır | Ertelendi — kırıcı olmayan `npm audit fix` |

**Hiçbir zafiyet susturulmadı/gizlenmedi; hiçbiri "tamamen çözüldü" diye iddia edilmiyor.** Yukarıdaki tablo, kalan her bulgunun neden bu görevin kapsamı dışında bırakıldığını gerekçelendirir.

### 12.4 Uyumluluk incelemesi

Next.js 16.2.6–16.3.0 arası resmi sürüm notları (`vercel/next.js` GitHub releases) incelendi:

- **16.2.6:** 12 güvenlik danışmanlığını (middleware/proxy bypass, Server Component DoS, cache poisoning dahil) düzeltiyor. YapiFin `middleware.ts`/`proxy.ts` kullanmıyor, dolayısıyla bu CVE'lerin saldırı yüzeyi zaten sınırlıydı, ama yükseltme bu sınıfı tamamen kapatıyor.
- **16.3.0:** Server Actions/redirect davranışında düzeltmeler (middleware rewrite ile forwarding loop, Edge runtime body-limit hatası), `instrumentation` kancasıyla ilgili düzeltmeler (adapter'sız Node.js middleware için de çalışması), SSR/hydration düzeltmeleri (dev modunda HTTP cache'den sunulan sayfalarda hydration hatası, Firefox streaming refresh loop), Windows'a özel Turbopack düzeltmeleri (yol kanonikleştirme, tek-slash ayrıştırma, dizin fsync atlanması).
- **Kod tabanı etkisi:** `instrumentation.ts`'teki `register()` kancası, `next.config.ts`'teki `turbopack.root` ayarı ve `app/`'daki server action/route handler kullanımları herhangi bir API değişikliğine maruz kalmadı; hiçbir kaynak dosyası bu görevde değiştirilmedi (yalnızca `package.json`/`package-lock.json`).
- Kırık/deprecated olmayan bir API için "daha yeni bir desen var" gerekçesiyle hiçbir refactor yapılmadı (görev talimatına uygun).

### 12.5 Doğrulama sonuçları (bu görevde fiilen çalıştırıldı)

Worktree: `YapiFin-worktrees/next-stable-security-upgrade`, dal: `chore/yf-507-next-stable-security-upgrade`, taban: `origin/main` @ `e1ebb44180a5f651a8e812cc77da8633b923a320` (PR #6 / YF-506 sonrası).

| Komut | Sonuç |
|---|---|
| `npm ci` | ✅ Başarılı (478 paket) |
| `npm run lint` | ✅ Hatasız |
| `npm run typecheck` | ✅ Hatasız |
| `npm run test` | ✅ **16 dosya / 130 test geçti** (geçici, izole `yapifin-test-postgres-yf507` konteyneri, port 55432 — iş bitince kaldırıldı, mevcut `yapifin-postgres-1` geliştirme konteynerine dokunulmadı) |
| `npm run build` (`.next` temizlenmiş) | ✅ Başarılı — `▲ Next.js 16.3.0 (Turbopack)`, 24/24 sayfa üretildi |
| `next start` + üretimde eksik `SMTP_HOST` | ✅ Beklenen: `register()` hatasıyla ilk istekten önce çöktü, sır sızdırmadı (fail-closed davranışı 16.3.0'da korunuyor) |
| `next start` + geçerli üretim yapılandırması | ✅ Sunucu hatasız ayağa kalktı; `/`, `/login`, `/signup` → 200, `/dashboard` (oturumsuz) → 307 yönlendirme |

**Tarayıcı tabanlı UI duman testi (signup→dashboard, login/logout) bu görevde çalıştırılamadı** — Claude Chrome uzantısı bu ortamda bağlı değildi. Bunun yerine mevcut otomatik test paketindeki ilgili senaryolar (`tests/user-management.test.ts`, `tests/invitation.test.ts`, `tests/tenant-isolation.test.ts`, `tests/project-manager-scope.test.ts` ve env/mailer testleri — toplam 130 test) servis katmanında aynı akışları kapsıyor ve hepsi geçti; HTTP düzeyinde de kritik route'lar (`/`, `/login`, `/signup`, `/dashboard`) hem üretim hem geliştirme modunda 200/307 ile doğrulandı. Gerçek tarayıcı tabanlı bir duman testi hâlâ önerilir, bu görevin bilinen eksiği olarak not edildi.

### 12.6 Turbopack araştırması (Windows "TaskGuard" panic'i)

Önceden Next.js 16.2.5'te Windows'ta `npm run dev` sırasında Rust panic'i ("Every task must have a task type TaskGuard") gözlemlenmişti; geçici çözüm `npm run dev -- --webpack` idi. Bu görevde araştırıldı:

- Web araştırması, bu panic'in genellikle **bozuk/eski bir kalıcı Turbopack dev cache'i** (`turbopackFileSystemCacheForDev`) geri yüklenmeye çalışıldığında tetiklendiğini gösteriyor; bilinen geçici çözümler `.next` silmek veya bu cache özelliğini kapatmaktır.
- Next.js 16.3.0 sürüm notları, Windows'a özel birkaç Turbopack düzeltmesi listeliyor: yol kanonikleştirme (her zaman verbatim path kullan), tek-slash ayrıştırma düzeltmesi, kalıcılık katmanında Windows'ta dizin fsync'inin atlanması.
- **Bu görevde fiilen test edildi:** `.next` temizlenip `npm run dev` (Turbopack, varsayılan) üç ayrı senaryoda çalıştırıldı — (1) temiz `.next` ile ilk başlatma, (2) `/`, `/login`, `/signup`, `/dashboard`, `/projects`, `/accounts`, `/expenses`, `/income` route'larını art arda derletme, (3) `.next` **silinmeden** sunucuyu durdurup sıcak cache ile yeniden başlatma (panic'i en çok tetiklediği bildirilen senaryo). **Üç senaryoda da panic gözlenmedi**; tüm route'lar başarıyla derlenip 200/307 döndü. Yavaş dosya sistemi uyarısı (`⚠ Slow filesystem detected`) çıktı ama bu bir hata değil, yalnızca performans notu.
- **Sonuç: Turbopack, bu Windows ortamında artık panic vermiyor.** Ancak bu, tek bir geliştirme makinesinde yapılan sınırlı bir doğrulamadır (yukarı akış sorunu, tüm Windows/dosya sistemi kombinasyonlarında garanti edilemez); bu nedenle Webpack fallback'i kaldırılmadı (§12.7).

### 12.7 Webpack fallback durumu

`npm run dev -- --webpack` bu görevde de doğrulandı: sunucu `▲ Next.js 16.3.0 (webpack)` ile ayağa kalktı, `/`, `/login`, `/signup` (200) ve `/dashboard` (307, oturumsuz yönlendirme) hatasız derlendi/servis edildi. **Webpack fallback, talimata uygun olarak korunuyor ve dokümante edilmeye devam ediyor** — Turbopack panic'inin tüm ortamlarda çözüldüğü kanıtlanana kadar `package.json`'daki `dev` script'i Turbopack varsayılanında bırakıldı (Turbopack artık mandatory yapılmadı, Webpack de kaldırılmadı — talimatın her iki maddesine de uyulmuştur).

### 12.8 Geri alma (rollback) prosedürü

Bu değişiklik yalnızca `package.json` + `package-lock.json` dosyalarını etkiler; şema/migration/veri değişikliği yok, dolayısıyla geri alma tek bir commit revert'i kadar basittir:

```bash
git revert <bu-görevin-commit-sha'ları>
npm ci
```

veya elle:

```bash
npm install next@16.2.5 eslint-config-next@16.2.5 --save-exact
npm run build   # doğrulamak için
```

Prisma migration'ı, SMTP davranışı veya auth iş kuralı bu görevde değişmediğinden, geri alma sonrası ek bir veri/migration adımı gerekmez.

### 12.9 Bilinen eksikler / sonraki adaylar

- Tarayıcı tabanlı gerçek uçtan-uca duman testi (signup → dashboard yönlendirme → çerez → logout) bu ortamda çalıştırılamadı (§12.5); bir sonraki fırsatta Chrome uzantısı bağlıyken tekrarlanmalı.
- `postcss`/`@tailwindcss/postcss`, `brace-expansion`, `js-yaml` için kırıcı olmayan `npm audit fix` hâlâ ayrı, düşük riskli bir görev olarak bekliyor.
- `nodemailer@9.0.4` majör yükseltmesi YF-508 kapsamında.
- `vitest` ailesi v2→v4 majör yükseltmesi ayrı bir dev-only görev.
- Turbopack panic'inin çözüldüğü tek bir Windows makinesinde doğrulandı; ekipteki diğer Windows geliştirici makinelerinde de doğrulanması önerilir, bu yüzden Webpack fallback'i README/dokümantasyondan kaldırılmadı.

### 12.10 CLAUDE.md otomatik mutasyon düzeltmesi (`agentRules: false`)

Next.js 16.3.0, `next dev` çalıştırıldığında proje köküne bir "agent rules" bloğu yazan yeni bir özellik ekledi (log satırı: `✓ Generated CLAUDE.md for AI agents. Set agentRules: false in next.config to disable.`). Bu, YapiFin'in kendi `CLAUDE.md` yönetişim dosyasında istenmeyen, takip edilen bir değişikliğe yol açıyordu; ilk YF-507 turunda bu değişiklik `git checkout -- CLAUDE.md` ile geri alınmış ama kaynağı kalıcı olarak kapatılmamıştı.

Bu düzeltmede `next.config.ts`'e `agentRules: false` eklendi (kurulu 16.3.0 tipleri bu alanı `boolean` olarak tanıyor, `tsc --noEmit` hatasız geçti — tip zorlama/`as any` gerekmedi). Doğrulama: `.next` temizlendi, `git hash-object CLAUDE.md` taban değeriyle kaydedildi, hem Turbopack (`npm run dev`) hem Webpack (`npm run dev -- --webpack`) modunda sunucu ayağa kaldırılıp en az bir route (`/`) derletildi/200 alındı, sunucular temiz durduruldu; her iki çalıştırma sonrası da `git diff -- CLAUDE.md` boş ve `git hash-object CLAUDE.md` taban değeriyle aynı kaldı. `CLAUDE.md` elle düzenlenmedi, Next.js tarafından üretilmiş hiçbir içerik commit edilmedi.

---

## 13. YF-508 — Nodemailer production runtime dependency güvenlik yükseltmesi (6.9.16 → 9.0.4)

Worktree: `YapiFin-worktrees/yf-508-nodemailer-upgrade`, dal: `chore/yf-508-nodemailer-security-upgrade`, taban: `origin/main` @ `ac4334921e00bf460ede54320d394203abf0c61e` (PR #8 sonrası, YF-403/404 birleşmesi).

### 13.1 Kapsam doğrulama (görev başında zorunlu koşulan komutlar)

| Kontrol | Sonuç |
|---|---|
| `node --version` | `v24.18.0` |
| `npm --version` | `11.16.0` |
| `npm ls nodemailer` (yükseltmeden önce) | `nodemailer@6.10.1` (paketteki `^6.9.16` aralığının en yüksek çözümü; lockfile'da zaten `6.10.1` idi) |
| `npm view nodemailer version` | `9.0.4` |
| `npm view nodemailer dist-tags --json` → `latest` | `9.0.4` — beta/rc/canary/preview soneki **yok**; ayrı bir eski `beta: 2.4.0-beta.0` etiketi var ama bu `9.0.4`'ten çok daha düşük ve alakasız bir geçmiş sürüm, `latest` etiketiyle karışmıyor |
| `npm view nodemailer@latest engines --json` | `{"node": ">=6.0.0"}` — yerel (`v24.18.0`) ve CI (`node-version: 22`, `.github/workflows/ci.yml`) ikisi de rahatça karşılıyor |
| `npm view nodemailer@latest peerDependencies --json` | boş (peer dependency yok) |
| `npm view nodemailer@latest dependencies --json` | boş (nodemailer sıfır-bağımlılıklı bir pakettir — bu özelliği 9.x'te de korunuyor, tedarik zinciri riski artmadı) |
| `npm audit --json` (yükseltmeden önce) | 10 bulgu (1 kritik, 5 yüksek, 4 orta) — `nodemailer` (yüksek, `isDirect: true`, `fixAvailable: {name: "nodemailer", version: "9.0.4", isSemVerMajor: true}`) dahil; ayrıntı §13.6 |

`latest` stabil ve major bir sıçrama (6→9) gerektiriyordu; talimat gereği durup rapor etme koşulu ("latest bir prerelease/beta/rc/canary ise dur" veya "desteklenmeyen Node sürümü gerektiriyorsa dur") **tetiklenmedi** — sürüm hem stabil hem de mevcut Node çalışma zamanıyla uyumlu olduğundan yükseltmeye devam edildi.

### 13.2 Güvenlik danışmanlıkları ve düzeltme durumu

Yüklü `6.10.1` sürümünü etkileyen, `npm audit`'in listelediği tüm danışmanlıklar (`range` sütunu `6.10.1`'i kapsıyor):

| Danışmanlık | Önem | Açıklama | `9.0.4` ile düzeltildi mi? |
|---|---|---|---|
| [GHSA-mm7p-fcc7-pg87](https://github.com/advisories/GHSA-mm7p-fcc7-pg87) | Orta | Yorumlama çakışması nedeniyle e-postanın istenmeyen bir domaine gitmesi (`<7.0.7`) | ✅ Evet |
| [GHSA-c7w3-x93f-qmm8](https://github.com/advisories/GHSA-c7w3-x93f-qmm8) | Düşük | `envelope.size` üzerinden sanitize edilmemiş SMTP komut enjeksiyonu (`<8.0.4`) | ✅ Evet |
| [GHSA-vvjj-xcjg-gr5g](https://github.com/advisories/GHSA-vvjj-xcjg-gr5g) | Orta | Transport `name` seçeneğinde (EHLO/HELO) CRLF ile SMTP komut enjeksiyonu (`<=8.0.4`) | ✅ Evet |
| [GHSA-268h-hp4c-crq3](https://github.com/advisories/GHSA-268h-hp4c-crq3) | Orta | `List-*` başlık yorumlarında CRLF enjeksiyonu, keyfi başlık enjeksiyonu (`<=8.0.8`) | ✅ Evet |
| [GHSA-wqvq-jvpq-h66f](https://github.com/advisories/GHSA-wqvq-jvpq-h66f) | Orta | `jsonTransport`, mesaj normalizasyonu sırasında `disableFileAccess`/`disableUrlAccess`'i atlıyor (`<=8.0.8`) | ✅ Evet (uygulama `jsonTransport` kullanmıyor, ama sürüm zaten düzeltiyor) |
| [GHSA-r7g4-qg5f-qqm2](https://github.com/advisories/GHSA-r7g4-qg5f-qqm2) | Orta | OAuth2 token alımında hatalı TLS sertifika doğrulaması (`<=8.0.7`) | ✅ Evet (uygulama OAuth2 kullanmıyor, ama sürüm zaten düzeltiyor) |
| [GHSA-p6gq-j5cr-w38f](https://github.com/advisories/GHSA-p6gq-j5cr-w38f) | **Yüksek** | Mesaj düzeyinde `raw` seçeneği `disableFileAccess`/`disableUrlAccess`'i atlıyor → keyfi dosya okuma ve SSRF (`<=9.0.0`) | ✅ Evet — bu, `npm audit`'in en yüksek önemli bulgusuydu; `lib/email/mailer.ts` `raw`/`attachments`/`envelope.size` gibi kullanıcı girdisinden beslenen alanları hiç kullanmıyor, dolayısıyla önceki sürümde de doğrudan tetiklenemiyordu, ama artık kod seviyesinde de kapatıldı |
| [GHSA-rcmh-qjqh-p98v](https://github.com/advisories/GHSA-rcmh-qjqh-p98v) | **Yüksek** | `addressparser`'da özyinelemeli çağrılar nedeniyle DoS (`>=3.0.0 <=7.0.10`) | ✅ Evet |

Yükseltme sonrası `npm audit --json`'da `nodemailer` anahtarı **artık hiç yok** (bkz. §13.6 tam liste).

### 13.3 Uyumluluk incelemesi (6.x → 7.x → 8.x → 9.x)

Yüklü `nodemailer@9.0.4` paketinin `node_modules/nodemailer/lib/smtp-connection/index.js` kaynağı doğrudan okunarak (yayın notu özetine güvenmek yerine) aşağıdaki davranışlar kod düzeyinde doğrulandı:

- **`createTransport`/SMTP transport seçenekleri:** `host`/`port`/`secure`/`auth`/`connectionTimeout`/`greetingTimeout`/`socketTimeout` imzası değişmedi; `lib/email/mailer.ts`'deki mevcut çağrı şekli (`nodemailer.createTransport({...})`) hiçbir değişiklik gerektirmeden derlendi ve çalıştı.
- **`secure` / port 465 / STARTTLS (587):** `port === 465` iken `secure` açıkça `false` bırakılırsa bile kütüphane `secureConnection = true` varsayıyor (satır ~65-68); `port !== 465` iken STARTTLS varsayımı korunuyor. `lib/email/mailer.ts` zaten `secure: env.smtp.port === 465` ile bunu açıkça set ediyor — davranış değişmedi (test: "port 465 için secure:true kullanır", "port 587 için secure:false").
- **Auth atlama (güvenilir relay):** `auth: undefined` geçildiğinde kimlik doğrulama adımı hiç çalışmıyor — değişmedi (test: "güvenilir relay ... auth:undefined").
- **`sendMail` dönen meta veri:** `messageId`/`envelope`/`accepted`/`rejected`/`response` alanları değişmedi (yerel duman testinde doğrulandı, bkz. §13.7).
- **Bağlantı/karşılama/soket zaman aşımı:** `_setupConnectionHandlers` (bağlantı), soket `greeting` zamanlayıcısı ve `_socket.setTimeout` (soket inaktivitesi) mekanizması aynı; yalnızca v8'de bağlantı hatası yolu `_onConnectionError`'a taşınıp DNS fallback (alternatif çözümlenen adreslere otomatik geçiş) eklendi — tekli host yapılandırmamızda gözlemlenebilir bir davranış farkı yok, nihai hata yine aynı `code`/`command` ile yüzeye çıkıyor.
- **Hata sınıfları/kodları:** `EAUTH`, `ETIMEDOUT`, `ESOCKET`, `ECONNECTION`, `ETLS`, `EENVELOPE`, `EPROTOCOL` kodları ve `command`/`response`/`responseCode` alanları 6.x'ten 9.x'e **değişmeden** korunuyor (kaynak kodda doğrudan doğrulandı — bkz. §13.4). Görev talimatının referans aldığı "`NoAuth` → `ENOAUTH`" gibi bir yeniden adlandırma **bulunamadı**; bu iddia harici bir özetten geliyordu ve kaynak koduyla çapraz kontrol edilerek reddedildi.
- **TLS varsayılanları/sertifika doğrulama:** `9.0.0`'ın gerçek kırıcı değişikliği — ekli dosya (`attachments` `href`/`path`), OAuth2 token endpoint'i ve HTTP/HTTPS proxy `CONNECT` için yapılan **uzak içerik indirme** isteklerinde artık TLS sertifikası varsayılan olarak doğrulanıyor. `lib/email/mailer.ts` hiçbir zaman `attachments`, OAuth2 veya proxy kullanmadı (yalnızca `to`/`subject`/`html`/`text` düz alanları) — bu değişiklik **kod tabanını hiç etkilemiyor**. SMTP bağlantısının kendisi için sertifika doğrulaması zaten her zaman varsayılan olarak açıktı (`rejectUnauthorized` hiç `false` yapılmadı, bu görevde de yapılmadı).
- **ESM/CJS/dinamik import:** `node_modules/nodemailer/package.json`'da `"main": "lib/nodemailer.js"`, `exports` alanı yok, `types` alanı yok — paket 9.x'te de saf CJS; `lib/email/mailer.ts`'deki `const nodemailer = await import("nodemailer")` deseni (mailer'ı yalnızca gerçekten gönderim gerektiğinde, sunucu tarafında lazy-load etmek için) değişiklik gerektirmeden çalışmaya devam ediyor (doğrulama: `.next/static` içinde `nodemailer` dizesi **sıfır** eşleşme — bkz. §13.7).
- **TypeScript tipleri:** nodemailer kendi `.d.ts` dosyalarını yayınlamıyor; `@types/nodemailer` `^6.4.17` → `^8.0.1`'e (DefinitelyTyped'daki en güncel sürüm) yükseltildi. `tsc --noEmit` hatasız geçti (bkz. §13.7).
- **Node.js sürüm desteği:** `engines.node: ">=6.0.0"` — hem yerel (`v24.18.0`) hem CI (`node-version: 22`) rahatça karşılıyor.
- Farklı bir e-posta sağlayıcısına geçilmedi, TLS doğrulaması hiçbir yerde zayıflatılmadı, `rejectUnauthorized: false` **hiçbir yerde** kullanılmadı, kırık/deprecated olmayan bir API için gereksiz refactor yapılmadı.

### 13.4 Transport sertleştirme — zaman aşımları

nodemailer'ın varsayılanları (`node_modules/nodemailer/lib/smtp-connection/index.js` satır 14-17'de doğrudan okunarak doğrulandı: `CONNECTION_TIMEOUT = 120000`, `SOCKET_TIMEOUT = 600000`, `GREETING_TIMEOUT = 30000`) bir HTTP isteği (Next.js server action) gövdesinde çalışmak için fazla uzun — özellikle 10 dakikalık soket zaman aşımı, kopan bir SMTP bağlantısının isteği fiilen süresiz beklettiği anlamına gelir.

`lib/email/mailer.ts`'e şu sınırlı, dokümante edilmiş değerler eklendi:

| Seçenek | nodemailer varsayılanı | YapiFin değeri | Gerekçe |
|---|---|---|---|
| `connectionTimeout` | 120.000 ms (2 dk) | **10.000 ms** | TCP el sıkışması normalde saniyeler sürer; HTTP isteğinin 2 dakika bloklanmasını önler |
| `greetingTimeout` | 30.000 ms | **10.000 ms** | SMTP `220` karşılaması normalde bağlantı sonrası anında gelir |
| `socketTimeout` | 600.000 ms (10 dk) | **20.000 ms** | EHLO/AUTH/MAIL FROM/RCPT TO/DATA döngüsünün tamamı normal koşullarda birkaç saniyede biter; 20 saniye, yavaş ama çalışan sunucular için toleranslı kalırken isteğin süresiz asılı kalmasını engeller |

Değerler agresif değildir — gerçek SMTP sağlayıcılarının (kurumsal relay, Gmail SMTP, transactional e-posta sağlayıcıları) tipik yanıt sürelerinin oldukça üzerindedir; yalnızca "hiç yanıt gelmeyen" durumları isteğin ömrüyle sınırlar. Havuzlama (`pool`) **kasıtlı olarak eklenmedi** — nodemailer varsayılanı zaten `pool: false`; bağlantı yaşam döngüsü/temizlik testleri olmadan etkinleştirilmemesi gerektiği testle doğrulandı (`tests/mailer.test.ts` → "transport havuzlanmaz").

### 13.5 Hata sınıflandırması, loglama ve alıcı maskeleme

Yeni `lib/email/errors.ts` modülü, ham nodemailer hatalarını (`err.code`/`err.command`/`err.responseCode`/`err.message`) sabit bir kategoriye eşler. Eşleme, kütüphanenin gerçek kaynağı (`_formatError`, `_onError`, `_onConnectionError`, `_actionMAIL`/`_actionRCPT`/`_actionDATA`) doğrudan okunarak, varsayımla değil doğrulanarak yazıldı:

| Kategori | Ham nodemailer sinyali | `retryable` |
|---|---|---|
| `AUTHENTICATION` | `code === "EAUTH"` | Hayır |
| `CONNECTION_TIMEOUT` | `code === "ETIMEDOUT"` ve mesaj `"Connection timeout"` içeriyor | Evet |
| `GREETING_TIMEOUT` | `code === "ETIMEDOUT"` ve mesaj `"Greeting never received"` içeriyor | Evet |
| `SOCKET_TIMEOUT` | `code === "ETIMEDOUT"`, diğer tüm durumlar (genel soket inaktivitesi) | Evet |
| `TLS_CERTIFICATE` | `code === "ETLS"`, veya `code === "ESOCKET"` ile sertifika ile ilgili mesaj metni (ilk güvenli bağlantıda — port 465 — Node'un tls soketi hatayı `ESOCKET`'e sarar) | Hayır |
| `CONNECTION_REFUSED` | `code === "ESOCKET"`/`"ECONNECTION"`, `ECONNREFUSED` mesajı veya genel bağlantı kurulamaması | Evet |
| `RECIPIENT_REJECTED` | `code === "EENVELOPE"` ve `command === "RCPT TO"` (veya `err.recipient` set) | Hayır |
| `TEMPORARY_PROVIDER` | `code === "EENVELOPE"` (mesaj/zarf düzeyinde, örn. `DATA`) ve `responseCode` 4xx | Evet |
| `PERMANENT_PROVIDER` | `code === "EENVELOPE"` ve `responseCode` 5xx | Hayır |
| `CONFIGURATION` | `code === "ECONFIG"` (nodemailer'ın kendi doğrulaması) | Hayır |
| `UNKNOWN` | Eşleşmeyen her şey | Hayır (güvenli varsayım) |

`retryable` alanı **bu görevde otomatik yeniden deneme tetiklemez** — yalnızca gelecekteki bir kuyruk/retry mekanizması için sınıflandırma bilgisidir (bkz. §13.8 "Yeniden deneme sınırlamaları").

`lib/email/mailer.ts`'deki `sendMail()`, `transport.sendMail()` başarısız olduğunda tek bir güvenli, yapılandırılmış log satırı yazar (`console.error`, JSON):

```json
{"level":"error","event":"email.delivery_failed","environment":"production","subject":"YapiFin — E-posta adresinizi doğrulayın","category":"CONNECTION_TIMEOUT","retryable":true,"smtpStatusCode":null,"recipientHash":"f8d8ca7f334a2643","durationMs":42}
```

Loglanan alanlar kasıtlı olarak sınırlıdır: `event`, `environment`, `category`, `retryable`, `smtpStatusCode` (varsa, yalnızca sayısal SMTP kodu — ham yanıt metni değil), `recipientHash` (alıcı e-postasının SHA-256 özetinin ilk 16 hex karakteri — `lib/email/errors.ts` `maskRecipient()`, tersine çevrilemez), `durationMs`, `subject` (statik, kullanıcı girdisi içermeyen e-posta konusu — hassas değil). **Asla loglanmayan**: ham SMTP yanıtı (`err.response`), tam alıcı adresi, mesaj `html`/`text` içeriği, token, `SMTP_PASSWORD`, `AUTH_SECRET`. Bu, `tests/mailer.test.ts`'teki "güvenli hata logu ham SMTP yanıtını, tam alıcı adresini, mesaj HTML'ini veya token'ı içermez" testiyle doğrulandı.

Hata **değiştirilmeden çağırana yansıtılır** (`throw err`, sınıflandırma yalnızca loglama içindir) — bu, mevcut sözleşmeyi (§11.4, "e-posta gönderim hatası asla yutulmaz") ve ilgili testleri (`tests/mailer.test.ts` "SMTP gönderim hatası yutulmaz, çağırana yansır") bozmadan korur. Çağıran servislerdeki (`server/services/auth-service.ts`, `server/services/invitation-service.ts`, `server/services/organization-service.ts`) önceki `console.error("... failed", err.message)` çağrıları **kaldırıldı** — artık tek, güvenli loglama noktası `sendMail()`'dedir; önceden bu çağrılar ham nodemailer `err.message`'ını (bazı SMTP red yanıtlarında tam alıcı adresini içerebilen) loglama riskini taşıyordu.

### 13.6 `npm audit` öncesi/sonrası

| | Önce (`nodemailer@6.10.1`) | Sonra (`nodemailer@9.0.4`) |
|---|---|---|
| Kritik | 1 | 1 |
| Yüksek | 5 | 4 |
| Orta | 4 | 4 |
| Düşük | 0 | 0 |
| **Toplam** | **10** | **9** |
| **Üretim çalışma zamanı bulgusu** | **1** (`nodemailer`) | **0** |

`nodemailer` anahtarı yükseltme sonrası `npm audit --json` çıktısında **tamamen yok**. Kalan 9 bulgunun tümü bu görevden önce de vardı ve dev/build-time'dır — hiçbiri bu yükseltmeyle değişmedi, hiçbiri bu görevde düzeltilmedi (kapsam dışı, §4/§12.3'te zaten sınıflandırılmış):

| Paket | Prod/Dev | Üretim çalışma zamanında istismar edilebilir mi? |
|---|---|---|
| `vitest`, `vite`, `vite-node`, `@vitest/mocker`, `esbuild` | **Dev-only** (test runner) | Hayır |
| `@tailwindcss/postcss`, `postcss` | Dev/build-time (CSS derleme) | Hayır |
| `brace-expansion`, `js-yaml` | Dev-only tooling (`eslint`) | Hayır |

**Sonuç: bu görev sonunda üretim çalışma zamanı bağımlılıklarında bilinen hiçbir güvenlik bulgusu kalmadı** (`next`→YF-507'de, `nodemailer`→bu görevde çözüldü). Repository'nin **tamamen** zafiyetsiz olduğu iddia edilmiyor — kalan 9 bulgu gerçek ve dokümante edilmiştir, yalnızca üretim çalışma zamanını etkilemiyorlar.

### 13.7 Doğrulama sonuçları (bu görevde fiilen çalıştırıldı)

| Komut | Sonuç |
|---|---|
| `npm ci` | ✅ Başarılı (478 paket) |
| `npm install nodemailer@9.0.4 @types/nodemailer@8.0.1` | ✅ Başarılı, `package-lock.json` npm tarafından yeniden üretildi (elle düzenlenmedi) |
| `npm run lint` | ✅ Hatasız |
| `npm run typecheck` | ✅ Hatasız |
| `npm run test` | ✅ **18 dosya / 198 test geçti** (geçici, izole `yapifin-test-postgres-yf508` konteyneri, port 55432 — iş bitince kaldırıldı, mevcut `yapifin-postgres-1` geliştirme konteynerine dokunulmadı) |
| `npm run build` | ✅ Başarılı — `▲ Next.js 16.3.0`, 27/27 route üretildi |
| `.next/static` içinde `nodemailer` dizesi araması | ✅ **Sıfır** eşleşme — mailer istemci paketine sızmıyor |
| `next start` + üretimde eksik `SMTP_HOST`/geliştirme DB parolası | ✅ Beklenen: `register()` hatasıyla ilk istekten önce çöktü, sır sızdırmadı |
| `next start` + geçerli güvenilir-relay yapılandırması (port 25, auth yok) | ✅ Sunucu ayağa kalktı, `GET /login` → `200` |
| `next start` + geçerli kimlik doğrulamalı yapılandırma (port 465, `SMTP_USER`/`SMTP_PASSWORD`) | ✅ Sunucu ayağa kalktı, `GET /login` → `200`, konsolda `SMTP_PASSWORD` sızıntısı yok |
| `npm audit` (önce/sonra) | ✅ Çalıştı, §13.6'da işlendi |

**Yerel SMTP duman testi:** Gerçek dış e-posta gönderilmedi. Bunun yerine, yalnızca `127.0.0.1`'e bağlanan, geçici, gerçek kimlik bilgisi kullanmayan, saklı port (`2526`/`2527`) üzerinde minimal bir SMTP-yakalama sunucusu (pure Node `net`, proje bağımlılığı **değil** — `scratchpad`'de tek seferlik script) ayağa kaldırıldı ve yüklü **gerçek `nodemailer@9.0.4`** paketiyle (mock değil) hem **güvenilir relay** (auth yok) hem **kimlik doğrulamalı** (AUTH LOGIN) yol test edildi:

- Türkçe konu (`YapiFin — E-posta adresinizi doğrulayın`) ve gövde (`E-posta adresinizi doğrulamak için bağlantıya tıklayın: ...`) doğru MIME/UTF-8 kodlamasıyla (`=?UTF-8?Q?...?=` konu, `quoted-printable` gövde) sunucuya ulaştı ve doğrulandı.
- Gönderen (`MAIL FROM:<noreply@example.com>`) ve alıcı (`RCPT TO:<kullanici@example.com>`) doğru iletildi.
- Her iki yol da `accepted: ["kullanici@example.com"], rejected: []` ile başarıyla tamamlandı.
- Test sunucuları iş bitiminde durduruldu/kaldırıldı; hiçbir yakalanan e-posta commit edilmedi (yalnızca oturum `scratchpad`'inde, repository dışında).

**Tarayıcı tabanlı UI duman testi** (signup formundan gerçek doğrulama e-postası tetiklenmesi) bu görevde çalıştırılmadı — Claude Chrome uzantısı bu ortamda bağlı değildi; bunun yerine `tests/mailer.test.ts` (21 test) ve `tests/email-delivery-failure.test.ts` (5 test, gerçek PostgreSQL'e karşı) aynı akışları servis katmanında kapsıyor ve `next start` ile üç farklı üretim yapılandırması (SMTP yok / güvenilir relay / kimlik doğrulamalı) HTTP düzeyinde ayrıca doğrulandı.

### 13.8 Yeniden deneme (retry) sınırlamaları

Bu görevde **tam bir arka plan yeniden deneme kuyruğu uygulanmadı** (talimatla uyumlu — kasıtlı olarak kapsam dışı bırakıldı). Mevcut/korunan davranış:

- `sendMail()` başarısız SMTP göndermesini **otomatik olarak yeniden denemez** — tek deneme, hemen fırlatma. Bu, aynı istek içinde yinelenen teslimat riskini önler.
- `classifyMailError()`'ın `retryable` alanı yalnızca **gelecekteki** bir kuyruk/arka plan işi için sınıflandırma sağlar; bu görevde hiçbir otomatik yeniden deneme mekanizmasını tetiklemez.
- Kullanıcıya sunulan "tekrar deneyin" akışları (doğrulama e-postası yeniden gönder, davet yeniden gönder) zaten mevcuttu ve değişmedi — bunlar kullanıcı tarafından tetiklenen manuel yeniden denemelerdir, otomatik değil.
- **Dayanıklı (durable) bir e-posta kuyruğu hâlâ gelecekteki bir iş olarak kalıyor** (bkz. §8/R-8, R-9) — bu görev SMTP çağrısının kendisini ve hata sınıflandırmasını sertleştirdi, teslimat garantisini değiştirmedi.

### 13.9 Doğrulama transportu (`transport.verify()`)

Bu görevde **eklenmedi**. Gerekçe: uygulama başlangıcının (health check hariç) canlı bir dış SMTP bağlantısına bağımlı olmaması gerekiyor (talimat açıkça bunu yasaklıyor); mevcut `instrumentation.ts`/`getEnv()` zaten yapılandırma **şeklini** (host/port/from/auth çifti) başlangıçta doğruluyor, bu yeterli ve mevcut sözleşmeyle tutarlı. Ayrı bir `/api health` veya SMTP test uç noktası da eklenmedi — kimliksiz bir SMTP test uç noktası açmak talimatla açıkça yasaklanmıştı ve mevcut kapsamda (R-7, health-check endpoint'i) zaten ayrı, önceliklendirilmemiş bir öneri olarak duruyor. Gelecekte gerekirse `transport.verify()` yalnızca kimlik doğrulamalı bir yönetici/test aracı içinde, dışa kapalı biçimde eklenebilir.

### 13.10 Geri alma (rollback) prosedürü

Bu değişiklik `package.json`/`package-lock.json`, `lib/email/mailer.ts`, yeni `lib/email/errors.ts`, ve üç servis dosyasındaki (`auth-service.ts`, `invitation-service.ts`, `organization-service.ts`) yalnızca `console.error` satırlarını etkiler; Prisma şeması/migration, oturum mimarisi veya finansal hesaplama mantığı değişmedi:

```bash
git revert <bu-görevin-commit-sha'ları>
npm ci
```

veya elle:

```bash
npm install nodemailer@6.9.16 @types/nodemailer@6.4.17 --save-exact
git checkout <önceki-commit> -- lib/email/mailer.ts lib/email/errors.ts server/services/auth-service.ts server/services/invitation-service.ts server/services/organization-service.ts
rm lib/email/errors.ts  # 6.x'e dönülüyorsa yeni dosya gereksizdir
npm run build   # doğrulamak için
```

Geri alma sonrası ek bir veri/migration adımı **gerekmez** — hiçbir Prisma modeli veya kalıcı veri şekli değişmedi.

### 13.11 Bilinen eksikler / sonraki adaylar

- Tarayıcı tabanlı gerçek uçtan-uca duman testi (signup → gerçek SMTP → e-posta alma) bu ortamda çalıştırılamadı (§13.7); Chrome uzantısı bağlıyken veya gerçek bir SMTP/Ethereal hesabıyla tekrarlanması önerilir.
- Dayanıklı e-posta yeniden deneme/kuyruk mekanizması hâlâ ayrı bir gelecekteki görev (bkz. §13.8, §8 R-8/R-9) — bu görev yalnızca sınıflandırma altyapısını (`retryable` alanı) hazırladı, kuyruğu uygulamadı.
- E-posta teslim hataları için ayrı bir metrik/alarm entegrasyonu (Sentry vb.) hâlâ yok — yalnızca yapılandırılmış `console.error` JSON log satırı var (bkz. §13.5); bir log toplama/APM aracına bağlanması operasyonel bir sonraki adım.
- `vitest` ailesi v2→v4 majör yükseltmesi ayrı bir dev-only görev olarak bekliyor (§4/§12.3'te belirtildiği gibi, bu görevle ilgisiz).
- `postcss`/`@tailwindcss/postcss`, `brace-expansion`, `js-yaml` için kırıcı olmayan `npm audit fix` hâlâ ayrı, düşük riskli bir görev olarak bekliyor.
