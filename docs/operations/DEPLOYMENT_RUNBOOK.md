# Deployment Runbook

**Bağlı belgeler**: [README.md](./README.md) · [ROLLBACK_RUNBOOK.md](./ROLLBACK_RUNBOOK.md) · [BACKUP_RESTORE_RUNBOOK.md](./BACKUP_RESTORE_RUNBOOK.md) · [PRODUCTION_CHECKLIST.md](./PRODUCTION_CHECKLIST.md)
**Kaynak referanslar**: `package.json`, `next.config.ts`, `instrumentation.ts`, `lib/env.ts`, `.env.example`, `prisma/schema.prisma`, `docker-compose.yml`, `.github/workflows/ci.yml`

## Doğrulanmış mevcut deployment modeli

❌ **Repository'de tanımlı bir production deploy pipeline'ı yoktur.** `.github/workflows/ci.yml` yalnızca `lint → typecheck → prisma migrate deploy (CI DB'sine) → test → build` çalıştırır; bir deploy adımı içermez. `docker-compose.yml` yalnızca `postgres:16-alpine` servisini tanımlar (dev/CI amaçlı); Next.js uygulaması için Dockerfile veya imaj **yoktur**. `next.config.ts` içinde `output: "standalone"` **yoktur** — yani uygulama `node_modules` + `.next` + kaynak dizini ile `next start` üzerinden çalıştırılacak şekilde varsayılmıştır.

Bu runbook, bu doğrulanmış gerçek üzerine, **generic Node.js process olarak `next start` ile production dağıtımı** anlatır. Blue/green veya rolling deployment repository'de yoktur; bu runbook'ta yalnızca 💡 önerisi olarak, tek-instance/kısa kesintili (maintenance window) bir model esas alınmıştır.

## Ön koşullar

| Bileşen | Doğrulanmış gereksinim | Kaynak |
|---|---|---|
| Node.js | CI'da **Node 22** kullanılıyor (`actions/setup-node@v4`, `node-version: 22`); `package.json`'da `engines` alanı ❌ **tanımlı değil**. `next@16.3.0`'ın kendi `engines.node` gereksinimi `>=20.9.0`'dır. | `.github/workflows/ci.yml:37` |
| PostgreSQL | `docker-compose.yml`/CI'da **PostgreSQL 16** (`postgres:16-alpine`) kullanılıyor; `prisma/schema.prisma`'da `provider = "postgresql"` — sürüm alt sınırı şemada belirtilmemiş. | `docker-compose.yml`, `prisma/schema.prisma` |
| npm | `package-lock.json` mevcut; `npm ci` kullanılmalı (`package.json`'a install script olarak `postinstall: "prisma generate"` bağlı). | `package.json:16` |

💡 **Önerilen production standardı**: `package.json`'a `engines.node` (ör. `"node": ">=22"`) ve bir `.nvmrc` eklenerek Node sürümü tek kaynaktan sabitlenmeli — bu repoda şu an yok, ayrı bir takip görevi olarak işaretlenmiştir (bu görev kapsamında `package.json` değiştirilmez).

## Gerekli ortam değişkenleri

Kaynak: `lib/env.ts` (tek yetkili doğrulama noktası, `instrumentation.ts` → `register()` içinde `getEnv()` ile başlangıçta çağrılır). Next.js'te `register()` yalnızca `next start`/`next dev` sırasında çalışır — `next build` sırasında **çalışmaz**; yani eksik/geçersiz bir değişken **build'i değil, ilk süreç açılışını** (`next start`) çökertir.

| Değişken | Zorunlu mu (production) | Doğrulama kuralı |
|---|---|---|
| `NODE_ENV` | production değerine **operatör tarafından** ayarlanmalı | `development`/`production`/`test` enum, varsayılan `development` |
| `DATABASE_URL` | ✅ zorunlu | `postgres(ql)://...` biçimi; production'da `yapifin_dev_password` string'ini **içeremez** |
| `AUTH_SECRET` | ✅ zorunlu | production'da ≥32 karakter, placeholder değer listesine (`change-me`, `changeme`, `secret`, `password`, `test` vb.) giremez |
| `NEXT_PUBLIC_APP_URL` | ✅ zorunlu (varsayılan `http://localhost:3000`) | mutlak URL; production'da `localhost`/`127.0.0.1`/`::1` dışında **https:// zorunlu** |
| `NEXT_PUBLIC_APP_NAME` | opsiyonel | varsayılan `YapiFin` |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_FROM` | ✅ **production'da üçü de zorunlu** | eksikse `getEnv()` hata fırlatır — e-posta gönderimi olmadan production'a çıkılamaz şeklinde tasarlanmış |
| `SMTP_USER`, `SMTP_PASSWORD` | koşullu | ikisi birlikte set edilmeli veya ikisi de boş bırakılmalı (trusted-relay senaryosu) |

🔧 **Operatör tarafından doldurulacak değerler**: gerçek `DATABASE_URL` (host/kullanıcı/parola), gerçek `AUTH_SECRET` (rastgele ≥32 karakter — ör. `openssl rand -base64 32`), gerçek `NEXT_PUBLIC_APP_URL` (production domain), gerçek SMTP relay bilgileri.

❌ **Repository'de tanımlı ama kullanılmayan değişkenler** (yanıltıcı olmasın diye burada belirtilir, deploy sırasında set etmeye gerek yoktur): `AUTH_URL` (`.env.example`'da var, `lib/env.ts` şemasında ve kodda hiç referans yok), `S3_*` (dosya depolama, "sonraki faz" olarak işaretli, kod tabanında referans yok).

## Secret yönetimi

- Secret'lar **repository'ye asla commit edilmez**; `.env` dosyaları `.gitignore` kapsamındadır.
- 💡 Önerilen: secret'lar bir secret manager'da (ör. platformun kendi env/secret store'u, HashiCorp Vault, cloud provider secret manager) tutulur; CI/CD ortam değişkeni olarak enjekte edilir.
- `AUTH_SECRET` rotasyonu tüm aktif oturumları geçersiz kılmaz (oturumlar DB'de `tokenHash` ile saklanır, `AUTH_SECRET` kod tabanında fiilen okunmuyor — bkz. [PRODUCTION_READINESS.md §11](../PRODUCTION_READINESS.md)); yine de rotasyon sonrası bir restart gereklidir çünkü `getEnv()` sonucu process ömrü boyunca cache'lenir.
- 🔧 Secret erişim yetkisi (kim görebilir/değiştirebilir) operatörün organizasyonel politikasına bağlıdır — bu doküman bir politika dayatmaz.

## TLS / reverse proxy beklentisi

❌ Repository'de TLS sonlandırma veya reverse proxy konfigürasyonu **yoktur** (nginx/Caddy config dosyası vb. repoda yok). `next start` düz HTTP üzerinde dinler.

💡 **Önerilen production standardı**: Uygulamanın önünde TLS sonlandıran bir reverse proxy (nginx, Caddy, cloud load balancer) bulunmalı; `NEXT_PUBLIC_APP_URL` bu public https URL ile eşleşmeli (env doğrulaması bunu zorunlu kılar). Oturum çerezi zaten `secure: NODE_ENV === "production"` ile işaretlidir (`lib/auth/session.ts`) — yani proxy arkasında HTTPS olmadan production çerezleri tarayıcıya `Secure` bayrağıyla gönderilir ve düz HTTP üzerinden çalışmaz; bu nedenle TLS/proxy olmadan login akışı düzgün çalışmayabilir.

🔧 Gerçek domain adı, sertifika sağlayıcısı ve proxy konfigürasyonu operatör tarafından belirlenir — bu belge varsayımsal hostname üretmez.

## Deployment öncesi backup

**Zorunlu adım**: Her migration içeren deploy'dan önce [BACKUP_RESTORE_RUNBOOK.md](./BACKUP_RESTORE_RUNBOOK.md#manuel-mantıksal-yedek-alma) içindeki manuel mantıksal yedek prosedürü çalıştırılmalı ve yedeğin alındığı doğrulanmalıdır (checksum + boyut kontrolü). Otomatik/zamanlanmış backup repository'de yoktur (bkz. o belge).

## Bakım modu / trafik yönetimi

❌ Repository'de bir "maintenance mode" sayfası veya trafik yönlendirme mekanizması **yoktur**.

💡 **Önerilen production standardı**: Tek-instance deployment modelinde, migration + restart sırasında kısa bir kesinti (birkaç saniye–birkaç dakika) kaçınılmazdır. Kullanıcı etkisini azaltmak için: (1) düşük trafikli bir saatte deploy planlanmalı, (2) reverse proxy seviyesinde statik bir "bakımdayız" sayfası veya 503 yanıtı 💡 olarak eklenebilir (repoda yok), (3) deploy penceresi önceden ilgili paydaşlara bildirilmeli.

## Deployment adımları

Aşağıdaki adımlar, doğrulanmış `package.json` script'lerine dayanır. Placeholder değerler `<...>` ile gösterilmiştir; gerçek değerler 🔧 operatör tarafından doldurulur.

### 1. Alınacak commit SHA'sını doğrula

```bash
git fetch origin --prune
git rev-parse origin/main
```

Deploy edilecek SHA'yı deploy kaydına (bkz. [Başarılı deploy kanıt kaydı](#başarılı-deploy-kanıt-kaydı)) not edin. Eski/bilinmeyen bir SHA'yı asla baseline kabul etmeyin.

### 2. Kodu al

```bash
git clone https://github.com/MustafaBasol/YapiFin.git   # ilk kurulumda
cd YapiFin
git fetch origin --prune
git checkout <deploy-edilecek-sha-veya-tag>
```

### 3. Ortam değişkenlerini ayarla

`.env.example` içindeki değişken listesini referans alarak production `.env` dosyasını (veya platformun secret injection mekanizmasını) 🔧 operatör olarak doldurun. `NODE_ENV=production` ayarlandığından emin olun.

### 4. Bağımlılıkları kur

```bash
npm ci
```

`postinstall` script'i otomatik olarak `prisma generate` çalıştırır (`package.json:16`).

### 5. Prisma doğrulama ve migration

```bash
npx prisma validate
npx prisma migrate deploy
```

`prisma migrate deploy` production-safe komuttur (`prisma migrate dev` **kullanılmamalı** — interaktif olabilir ve shadow database gerektirebilir). `package.json`'da bu komut `prisma:migrate:deploy` script'i olarak da tanımlıdır: `npm run prisma:migrate:deploy`.

⚠️ **Migration çalıştırmadan önce [Deployment öncesi backup](#deployment-öncesi-backup) adımının tamamlandığından emin olun.** Prisma migration'ları otomatik olarak geri alınamaz (bkz. [ROLLBACK_RUNBOOK.md](./ROLLBACK_RUNBOOK.md)).

### 6. Build

```bash
npm run build
```

Bu `next build` çalıştırır. `output: "standalone"` olmadığından, çalıştırma zamanında tam kaynak ağacı + `node_modules` + `.next` dizini birlikte gereklidir — build çıktısı tek başına taşınabilir bir bundle değildir.

### 7. Process/container restart

❌ Repository'de bir process manager konfigürasyonu (systemd unit, PM2 ecosystem dosyası, Docker imajı) **yoktur**. 💡 Önerilen: `next start` bir process supervisor (systemd, PM2, veya container orchestrator) altında çalıştırılmalı ki crash sonrası otomatik yeniden başlasın.

```bash
npm run start   # next start — varsayılan port 3000, PORT env değişkeni ile değiştirilebilir
```

Restart sırasında `instrumentation.ts` → `register()` → `getEnv()` çalışır; env eksik/geçersizse süreç **ilk isteği karşılamadan** çöker (stdout/stderr'de `Ortam değişkenleri geçersiz: ...` mesajı görülür). Bu, geçersiz bir production env ile "yarı çalışır" bir deploy'un önüne geçen kasıtlı bir tasarımdır.

### 8. Health/readiness doğrulaması

❌ **Repository'de `/api/health`, `/api/ready` veya benzeri bir health-check endpoint'i yoktur** (`docs/PRODUCTION_READINESS.md` risk R-7). Bu, restart sonrası "uygulama gerçekten ayakta ve DB'ye bağlanabiliyor mu" sorusuna otomatik yanıt verecek bir mekanizmanın eksik olduğu anlamına gelir.

Bu runbook kapsamında operatör, aşağıdaki **manuel** doğrulamayı yapar (💡 gerçek health endpoint eklenene kadar geçici prosedür):

```bash
curl -i http://localhost:3000/login
```

Beklenen: `200 OK` ve login formunu içeren HTML. `500`/bağlantı hatası/timeout → deploy başarısız kabul edilir, bkz. [Deploy başarısızlığı çıkış kriterleri](#deploy-başarısızlığı-çıkış-kriterleri).

💡 **Takip görevi (bu görev kapsamı dışı)**: `GET /api/health` endpoint'i eklenmeli — en az `SELECT 1` ile DB bağlantısını doğrulayan, secret/PII içermeyen bir yanıt dönmeli. Eklendiğinde bu bölüm ve [MONITORING_RUNBOOK.md](./MONITORING_RUNBOOK.md#http-availability) güncellenmelidir.

### 9. Smoke testleri

[PRODUCTION_CHECKLIST.md](./PRODUCTION_CHECKLIST.md) içindeki non-destructive smoke test listesini uygulayın (login, proje listeleme, dashboard, export, vb.).

### 10. Migration sonrası veri doğrulaması

- `npx prisma migrate status` ile migration geçmişinin beklenen son migration'da olduğunu doğrulayın (repoda şu an `20260805125134_init` ve `20260805143103_faz3_financial_hardening` — yeni migration eklendiğinde bu liste güncellenmelidir).
- Kritik tablolarda satır sayısı sıçraması/kaybı olmadığını kontrol edin (ör. `Organization`, `User`, `FinancialTransaction` tablolarında migration öncesi/sonrası satır sayısı karşılaştırması — 🔧 operatör, migration'ın niteliğine göre karar verir).
- Multi-tenant izolasyonun bozulmadığını doğrulamak için [PRODUCTION_CHECKLIST.md](./PRODUCTION_CHECKLIST.md) içindeki tenant kontrolünü çalıştırın.

### Deploy başarısızlığı çıkış kriterleri

Aşağıdakilerden **herhangi biri** gerçekleşirse deploy başarısız kabul edilir ve [ROLLBACK_RUNBOOK.md](./ROLLBACK_RUNBOOK.md) devreye girer:

- `npm run build` hata ile sonlanır.
- `npx prisma migrate deploy` hata ile sonlanır (kısmi migration durumu — bkz. [ROLLBACK_RUNBOOK.md — deploy sırasında kısmi başarı](./ROLLBACK_RUNBOOK.md#deploy-sırasında-kısmi-başarı)).
- `next start` süreç açılışında çöküyor (`Ortam değişkenleri geçersiz` veya başka bir başlangıç hatası).
- Adım 8'deki manuel health doğrulaması 5 dakika içinde `200 OK` dönmüyor.
- Smoke testlerinde kritik bir akış (login, dashboard, proje listeleme) başarısız oluyor.

### Production log kontrolü

Deploy sonrası ilk birkaç dakikada `next start` sürecinin stdout/stderr çıktısı izlenmelidir. Bilinen yapılandırılmış log satırları:

- `email.delivery_failed` (`lib/email/mailer.ts`) — SMTP gönderim hatası, `category`/`retryable`/`smtpStatusCode`/`recipientHash` (ham e-posta adresi değil, hash) alanları içerir.
- `export.unexpected_error` (`server/exports/http.ts`) — export route'larında beklenmeyen hata, yalnızca `{name, message}` loglar (stack trace istemciye sızmaz).
- Prisma client production'da yalnızca `"error"` seviyesini loglar (`lib/db.ts`).

⚠️ Loglarda PII, token, parola veya finansal detay **olmamalıdır** — yukarıdaki noktalar bunun bilinçli tasarım olduğunu gösterir (ör. e-posta hash'lenir). Deploy sonrası log taramasında bu varsayımın bozulmadığını (ör. yeni eklenen bir log satırının ham e-posta/parola yazmadığını) gözden geçirin.

### Başarılı deploy kanıt kaydı

Her production deploy için aşağıdaki bilgiler kayıt altına alınmalıdır (🔧 operatör, kurumun kullandığı sistemde — ör. bir deploy log dosyası, issue tracker kaydı):

| Alan | Değer |
|---|---|
| Deploy tarihi/saati | 🔧 |
| Deploy edilen commit SHA | 🔧 |
| Deploy'u yapan operatör | 🔧 |
| Migration uygulandı mı, hangi migration'lar | 🔧 |
| Backup alındı mı, backup dosya referansı | 🔧 |
| Health doğrulama sonucu | 🔧 |
| Smoke test sonucu | 🔧 |
| Bilinen/gözlenen sorunlar | 🔧 |
