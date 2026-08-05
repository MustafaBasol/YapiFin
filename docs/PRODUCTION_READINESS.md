# Üretime Hazırlık Değerlendirmesi

Bu belge, YapiFin repository'sinin mevcut hâlinin (Faz 0/1 — kimlik doğrulama, organizasyon, davet, proje iskeleti) üretime alınmadan önce taşıdığı riskleri belgeler. Kapsam salt inceleme ve dokümantasyondur; uygulama kodu, Prisma şeması, migration, servis, action, UI bileşeni veya test dosyası **değiştirilmemiştir**.

- **İncelenen dal:** `docs/production-readiness-review` (worktree: `YapiFin-worktrees/production-review`)
- **Referans commit:** `7499012` (`main`, PR #1 sonrası)
- **Yöntem:** `CLAUDE.md` ve `docs/` altındaki ilgili belgeler okunduktan sonra yalnızca ortam/güvenlik/dağıtım ile ilgili kaynak kökleri hedeflendi: `lib/env.ts`, `lib/auth/*`, `lib/email/mailer.ts`, `lib/db.ts`, `server/services/auth-service.ts`, `server/services/invitation-service.ts`, `server/services/organization-service.ts`, `app/actions/*.ts`, `prisma/schema.prisma`, `.github/workflows/ci.yml`, `next.config.ts`, `docker-compose.yml`, `.env.example`. Geniş, tüm-repo taraması yapılmadı; bu belgedeki bulgular yukarıdaki dosyaların doğrudan okunmasına dayanır.
- **Doğrulama:** `npm audit`, `npm run lint`, `npm run typecheck`, `npm run test`, `npm run build` bu incelemede fiilen çalıştırıldı (bkz. §4 ve rapor sonu).

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
| R-4 | Bilinen CVE'li doğrudan bağımlılıklar (`next`, `nodemailer`, `vitest`) | Yüksek (next, nodemailer runtime) / Kritik ama dev-only (vitest) | §4'te detaylı | `next`/`nodemailer` güncel değilse bilinen istismar tekniklerine (kısmen) açık yüzey taşır | `next@16.3.0`'a kırıcı olmayan yükseltme (öncelik 1); `nodemailer` majör yükseltmesini ayrı PR'da test ederek uygula | `next` yükseltmesi olmadan **evet** (üretim runtime CVE'si); `vitest` yükseltmesi hayır |
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

## Sonraki mantıklı görev

`getEnv()`'i uygulama başlangıcına bağlamak ve `SMTP_HOST` için üretim zorunluluğu eklemek (R-1 + R-2), tek bir küçük, test edilebilir PR olarak ele alınabilir ve bu belgedeki en yüksek etkili/en düşük riskli düzeltmedir.
