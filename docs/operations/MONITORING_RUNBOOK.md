# Monitoring Runbook

**Bağlı belgeler**: [README.md](./README.md) · [INCIDENT_RESPONSE_RUNBOOK.md](./INCIDENT_RESPONSE_RUNBOOK.md) · [BACKUP_RESTORE_RUNBOOK.md](./BACKUP_RESTORE_RUNBOOK.md)

## Mevcut durum

✅ **YF-512 — `@sentry/node` ile hata izleme/APM entegrasyonu eklendi** (bkz. [aşağıdaki bölüm](#sentry-entegrasyonu-yf-512), `docs/PRODUCTION_READINESS.md` risk R-8 çözüldü). Öncesinde yapılandırılmış loglama sınırlıydı: `console.error`/`console.log` ile bazı yerlerde elle yazılmış JSON satırları (`lib/email/mailer.ts`, `server/exports/http.ts`) — bu satırlar hâlâ birincil, her-zaman-yazılan yerel log kaynağıdır; Sentry bunun üzerine, örneklemeli/agregeli bir uzak katman olarak eklenmiştir (bkz. aşağıdaki "Örnekleme" bölümü — amaç yerel logu değiştirmek değil, tamamlamaktır). Request correlation ID **hâlâ yoktur** (`docs/ARCHITECTURE.md` §9'da hedef olarak listelenmiş, bu görevin kapsamı dışında — henüz uygulanmamış).

Bu belgede önerilen tüm eşik değerleri **başlangıç önerisidir**, repository'den ölçülmüş/kanıtlanmış bir SLO değildir — 💡 olarak işaretlenmiştir. Gerçek eşikler, production trafiği gözlemlendikten sonra operatör tarafından kalibre edilmelidir.

⚠️ **Genel kural**: Hiçbir monitoring/log sinyali PII (e-posta, ad-soyad, IP dışında kişisel veri), token, parola veya finansal tutar/detay içermemelidir. Mevcut kod tabanında bu ilke kısmen uygulanıyor (ör. `recipientHash` — SHA-256 kısaltılmış hash, ham e-posta değil); yeni eklenecek her log/metrik bu ilkeye uymalıdır.

## Sentry entegrasyonu (YF-512)

### Sağlayıcı kararı ve gerekçesi

**Seçim**: [`@sentry/node`](https://www.npmjs.com/package/@sentry/node) — `@sentry/nextjs` DEĞİL.

- Repository'de daha önce hiçbir APM/error-tracking bağımlılığı yoktu (yukarıdaki "Mevcut durum" ve `docs/PRODUCTION_READINESS.md` R-8 ile doğrulanmış); bu nedenle yeni bir entegrasyon eklenmiştir, mevcut bir çözüm genişletilmemiştir.
- Bu görevin kapsamındaki tüm sinyaller (app/server hataları, SMTP, rate-limit, failed login, DB) **yalnızca sunucu tarafında** (nodejs runtime) çalışır — istemci/tarayıcı hata izleme kapsam dışıdır. `@sentry/node`, `@sentry/nextjs`'in tam kapsamına (istemci SDK'sı, Turbopack/webpack build eklentisi, kaynak harita yükleme, `sentry.server.config.ts`/`sentry.edge.config.ts`/`instrumentation-client.ts`/`global-error.tsx` dosya kuralları) ihtiyaç duymadan aynı sunucu tarafı `captureException`/`captureMessage` API'sini sağlar.
- `next.config.ts`'yi `withSentryConfig` ile sarmalamak (kaynak harita yükleme için `SENTRY_AUTH_TOKEN` gerektirir, henüz olgunlaşmamış Turbopack entegrasyonu ile ek risk taşır) bilinçli olarak **yapılmamıştır** — bu, "keep scope realistic" ilkesiyle uyumlu, production build'i kırma riskini ortadan kaldıran bir karardır. İleride istemci tarafı hata izleme gerekirse `@sentry/nextjs`'e geçiş ayrı bir görev olarak değerlendirilmelidir.
- Sentry'nin varsayılan otomatik entegrasyonları (http/request-data — istek header'larını/URL'lerini breadcrumb olarak yakalayabilir) **kasıtlı olarak devre dışıdır** (`integrations: []`, bkz. `lib/monitoring/adapter.ts`); yalnızca elle yapılan, redaction'dan geçirilmiş `captureException`/`captureMessage` çağrıları kullanılır.

### Mimari

```
lib/monitoring/
  redact.ts            — merkezi, fail-safe redaction (anahtar + değer örüntüsü)
  config.ts             — env → çalışma zamanı davranışı (enabled/dsn/environment/tracesSampleRate)
  adapter.ts             — MonitoringAdapter arayüzü + no-op ve Sentry implementasyonları
  sampler.ts             — sabit-pencereli sayaç (uzak iletim örneklemesi)
  security-events.ts     — tipli olay üreticileri (rate-limit/failed-login/smtp/db)
  index.ts                — tek genel API: initMonitoring/captureException/captureRequestError/
                             captureSecurityEvent/flushMonitoring/setMonitoringAdapterForTests
```

- `instrumentation.ts` → `register()`: nodejs runtime'da `initMonitoring()` çağrılır (env doğrulamasıyla aynı yerde, YF-511'den beri var olan desen).
- `instrumentation.ts` → `onRequestError(error, request, context)`: Next.js'in merkezi sunucu hata yakalama kancası — App Router render/route/action/middleware hatalarının **çoğunu** tek noktadan yakalar (bkz. görev talimatı "framework'ün merkezi mekanizmasını kullan, onlarca fonksiyonu elle sarmalama").
- `lib/action-error.ts` → `toActionError()`: server action'lardaki bilinmeyen (ServiceError olmayan) istisnalar için **tek, merkezi enjeksiyon noktası** — bu satır zaten `docs/PRODUCTION_READINESS.md §8`'de "iyi bir enjeksiyon noktası" olarak işaretlenmişti. Bu proje neredeyse tüm server action'larını kendi `try/catch`'i içinde `ActionState`'e çevirdiği için (yani hata action sınırını aşıp `onRequestError`'a ulaşmaz), bu tek satır tüm action'ları kapsar — onlarca ayrı `try/catch` eklemek yerine.
- `lib/rate-limit/policy.ts` → `recordOutcome()`: mevcut yerel log satırının hemen yanına `recordRateLimitSecurityEvent` eklendi.
- `lib/email/mailer.ts` → `logMailFailure()`: mevcut yerel log satırının hemen yanına `recordSmtpFailureSecurityEvent` eklendi.
- `lib/health/db-check.ts` → `checkDatabase()`: daha önce DB hatası **hiç loglanmıyordu** (ham hata sessizce yutuluyordu) — artık `classifyDbError()` ile sır içermeyen bir kategoriye (yalnızca `err.code`/kendi sentinel'imiz karşılaştırılır, `err.message` asla okunmaz) çevrilip güvenli biçimde loglanır ve `recordDatabaseFailureSecurityEvent` çağrılır.
- `app/actions/auth.ts` → `loginAction()`: başarısız login denemesi, rate-limit'ten **ayrı bir kapsamda** (`hashIdentifier("login-failed", ...)`) HMAC özetiyle loglanır ve `recordFailedLoginSecurityEvent` çağrılır.

### Ortam değişkenleri

| Değişken | Zorunlu mu | Açıklama |
|---|---|---|
| `SENTRY_DSN` | ❌ Hiçbir ortamda zorunlu değil | Boşsa monitoring no-op adapter'a düşer — süreç **çökmez**. Production'da boşsa bir kerelik `monitoring.not_configured` uyarısı loglanır (sır içermez). |
| `SENTRY_ENVIRONMENT` | ❌ Opsiyonel | Belirtilmezse `NODE_ENV` kullanılır. |
| `SENTRY_TRACES_SAMPLE_RATE` | ❌ Opsiyonel | `[0,1]`; belirtilmezse `0`. Yalnızca production'da dikkate alınır — development/test'te her zaman `0` (agresif olmayan varsayılan, bkz. görev talimatı "Do not choose aggressive tracing defaults"). |

Bkz. `.env.example` ve [DEPLOYMENT_RUNBOOK.md — gerekli ortam değişkenleri](./DEPLOYMENT_RUNBOOK.md#gerekli-ortam-değişkenleri).

### Redaction politikası

`lib/monitoring/redact.ts`, her `captureException`/`captureSecurityEvent` çağrısına eklenen `context`/`extra` verisine VE Sentry SDK'sının kendi `beforeSend`/`beforeBreadcrumb` kancalarına (giden HER olay için, çağrı sitesinden bağımsız son bir güvenlik ağı olarak) uygulanır. İki katman:

1. **Anahtar tabanlı** (büyük/küçük harf duyarsız düzenli ifade): `password`, `passwordHash`, `token`, `sessionToken`, `authorization`, `cookie`, `smtpUser`/`smtpPassword`, `apiKey`, `databaseUrl`, `connectionString` ve türevleri → `"[redacted]"`.
2. **Değer örüntüsü tabanlı** (serbest metin içinde bile): `postgres(ql)://…`, `redis(s)://…`, `smtp(s)://…` bağlantı dizeleri maskelenir. `Authorization: Bearer <token>` başlığındaki token değeri de aynı şekilde redakte edilir — ham token asla uzak sisteme iletilmez, yalnızca `Bearer [redacted]` biçiminde kalır.

Ayrıca: `sendDefaultPii: false` (Sentry SDK seviyesinde IP/kullanıcı bilgisi otomatik eklenmez), `integrations: []` (otomatik http/request-data yakalama yok), hiçbir yerde ham HTTP request body/headers Sentry'ye iletilmez (`onRequestError` yalnızca `path`/`method`/`routePath` iletir — `request.headers` KASITLI OLARAK atlanır).

### Örnekleme (sampling)

- **Traces**: development/test'te her zaman `0`; production'da `SENTRY_TRACES_SAMPLE_RATE` (varsayılan `0`) — 💡 başlangıçta düşük tutulması önerilir (ör. `0.05`).
- **Güvenlik olayları (rate-limit/failed-login/smtp/db)**: yerel yapılandırılmış log **her olayda** yazılır (değişmedi); yalnızca **uzak** Sentry iletimi `lib/monitoring/sampler.ts` ile sınırlanır — sabit pencereli sayaç, aynı anahtar (ör. `rate_limit:login:blocked`) için pencere başına en fazla N olayı iletir, kalanları düşürür. Başlangıç 💡 bütçeleri (`lib/monitoring/security-events.ts`):

  | Tür | Pencere | Pencere başına maksimum uzak iletim |
  |---|---|---|
  | `rate_limit` (blocked / store_unavailable) | 5 dk | 5 |
  | `failed_login` | 5 dk (subjectHash başına) | 5 |
  | `smtp_failure` | 5 dk (kategori başına) | 5 |
  | `db_failure` | 60 sn (kaynak+kategori başına) | 1 |

  Bu, görev talimatındaki "her normal istekte bir uzak APM olayı gönderme" ve "`/api/health`'i başarılı trafikte gürültülü yapma" kısıtlarını karşılar — health endpoint'i zaten yalnızca **hata** durumunda (başarıda asla) bir log/olay üretir, hata durumunda da dakikada en fazla 1 uzak olay iletilir.

### Alert politikası (başlangıç önerisi, 💡)

**CRITICAL** (anında insan müdahalesi):
- Uygulama erişilemez / tekrarlayan sunucu hataları (bkz. [#1 HTTP availability](#1-http-availability), [#10 Application restart/crash](#10-application-restartcrash)).
- DB erişilemez (`db_failure` olayları sürekli/pencere başına maksimuma ulaşıyor) — bkz. [#4](#4-postgresql-bağlantı-havuzu), [Incident Response — Database outage](./INCIDENT_RESPONSE_RUNBOOK.md#database-outage).
- Sürdürülebilir kimlik doğrulama/güvenlik anomalisi: `failed_login` veya `rate_limit.blocked` olaylarının aynı `subjectHash`/politika için sürekli pencere tavanına çarpması (credential-stuffing paterni).

**HIGH**:
- Tekrarlayan SMTP hatası — bkz. [#7](#7-smtp-delivery-hataları); özellikle `category: AUTHENTICATION`/`CONFIGURATION` (tüm gönderimler etkilenir).
- Sürdürülebilir rate-limit/güvenlik anomalileri (izole tek bir `blocked` olayı değil, sürekli tekrar).
- Yükselen uygulama hata oranı (`toActionError`/`onRequestError` üzerinden gelen `captureException` hacmi anormal artış gösteriyor).

İzole, zararsız 4xx/tekil `ServiceError` olayları (ör. tek bir kullanıcı formu yanlış doldurdu) için alarm **kurulmamalıdır** — bunlar zaten kullanıcıya Türkçe hata mesajı olarak döner ve `toActionError`'ın bilinen-hata dalına (raw `captureException` YOK) düşer.

### Devre dışı/yapılandırılmamış davranış

`SENTRY_DSN` boşsa (development/test'in normali, production'da da izin verilir): tüm `captureException`/`captureMessage` çağrıları no-op adapter'a düşer, hiçbir ağ çağrısı yapılmaz, süreç **asla çökmez**. Production'da bu durum bir kerelik (`monitoring.not_configured`) uyarı logu ile gözlemlenebilir kılınır — sır içermez. Finansal işlemler (transaction/settlement/transfer) monitoring'in varlığına **bağımlı değildir**; monitoring çağrıları hiçbir zaman `await`/hata fırlatma yoluyla iş akışını bloke etmez (bkz. `lib/monitoring/adapter.ts` — `captureException`/`captureMessage` senkron ve best-effort'tur).

### Kontrollü test olayı

Production'da erişilebilir, kimlik doğrulamasız bir "hata tetikleme" endpoint'i **bilinçli olarak eklenmemiştir** (görev talimatı bunu açıkça yasaklar). Bunun yerine:

```bash
# DSN yokken: yalnızca no-op adapter'ın çöküşe yol açmadan çalıştığını doğrular.
npm run monitoring:test-event

# Gerçek bir Sentry projesine karşı uçtan uca doğrulama (development/test dışı Sentry ortamı önerilir):
SENTRY_DSN="https://<key>@oXXXX.ingest.sentry.io/<project>" npm run monitoring:test-event
```

`scripts/trigger-test-monitoring-event.ts`, `NODE_ENV=production` iken **çalışmayı reddeder** (fail-closed) ve hiçbir HTTP sunucusu açmaz — yalnızca bu süreç içinde bir `captureException` + bir `captureSecurityEvent` tetikleyip `flushMonitoring()` ile gönderimin tamamlanmasını bekler. Otomatik regresyon koruması için ayrıca `tests/monitoring.test.ts` (mock adapter ile) ve `tests/health.test.ts`'e eklenen DB-hatası testi çalıştırılır (bkz. [TESTS — Doğrulama](#doğrulama)).

## Sinyaller

Her sinyal için: ne ölçülür, neden önemli, önerilen warning/critical yaklaşımı, yanlış pozitif riski, ilk müdahale.

### 1. HTTP availability

- **Ne ölçülür**: Uygulamanın temel bir sayfaya (ör. `/login`) HTTP yanıtı verip vermediği.
- **Neden önemli**: En temel "uygulama ayakta mı" sinyali; tüm kullanıcı erişimini etkiler.
- **Önerilen yaklaşım (💡 başlangıç)**: Dış bir uptime checker'dan 1-2 dakikada bir `GET /api/health` isteği (✅ artık mevcut, bkz. [DEPLOYMENT_RUNBOOK.md](./DEPLOYMENT_RUNBOOK.md#healthreadiness-doğrulaması) ve [SECURITY_HEADERS.md](./SECURITY_HEADERS.md#health-endpoint)); **warning** = 1 ardışık başarısızlık, **critical** = 3 ardışık başarısızlık veya 5 dakika kesinti. `/login` yerine tercih edilir çünkü kimlik doğrulaması gerektirmez ve DB erişilebilirliğini de kapsar.
- **Yanlış pozitif riski**: Deploy sırasındaki kısa restart penceresi (bakım modu yoksa) yanlış alarm üretebilir — deploy penceresi ile alarm susturma senkronize edilmeli.
- **İlk müdahale**: Süreç ayakta mı kontrol et (`next start` process/container durumu), stdout/stderr'de başlangıç hatası var mı bak (`Ortam değişkenleri geçersiz` gibi), gerekirse [INCIDENT_RESPONSE_RUNBOOK.md — login/auth outage](./INCIDENT_RESPONSE_RUNBOOK.md#loginauth-outage) akışına geç.

### 2. Latency ve error rate

- **Ne ölçülür**: HTTP yanıt süresi dağılımı (p50/p95/p99) ve 5xx oranı.
- **Neden önemli**: Kullanıcı deneyimini ve altta yatan DB/kaynak sorunlarını erken gösterir.
- **Önerilen yaklaşım (💡 başlangıç)**: reverse proxy erişim logundan türetilir (repoda proxy config yok, bkz. [DEPLOYMENT_RUNBOOK.md](./DEPLOYMENT_RUNBOOK.md#tls--reverse-proxy-beklentisi)). Başlangıç önerisi: **warning** p95 > 2s veya 5xx oranı > %1 (5 dk pencere); **critical** p95 > 5s veya 5xx oranı > %5.
- **Yanlış pozitif riski**: Export endpoint'leri (Excel/PDF) doğası gereği daha yavaştır (`server/exports/*` — büyük veri setlerinde bellekte buffer oluşturur); genel latency alarmından ayrı değerlendirilmeli, yoksa export trafiği false-positive üretir.
- **İlk müdahale**: Hangi route'ların yavaşladığını/hata verdiğini belirle; DB bağlantı havuzu ve CPU/memory sinyallerine bak (aşağıda #4, #11); export route'larıysa [Export hata ve süreleri](#9-export-hata-ve-süreleri) bölümüne geç.

### 3. Authentication failure oranları

- **Ne ölçülür**: Başarısız login denemesi sayısı (IP/e-posta bazında).
- **Neden önemli**: Brute-force/credential-stuffing saldırısının erken göstergesi.
- **Mevcut durum**: ✅ `lib/rate-limit/policy.ts` (Redis birincil, süreç-içi yedek — YF-509) `login` politikasıyla aktif (15 dakikada 10 deneme). Her `blocked`/`store_unavailable` olayı yerel yapılandırılmış logla **her zaman** yazılır VE (YF-512) örneklemeli olarak Sentry'ye iletilir — bkz. [Sentry entegrasyonu — Örnekleme](#örnekleme-sampling). Ayrıca (YF-512) bireysel başarısız login denemeleri (rate-limit eşiğinin altında kalanlar dahil) `auth.failed_login` olarak ayrı bir HMAC-özetli kapsamda gözlemlenebilir.
- **Önerilen yaklaşım (💡 başlangıç)**: Rate-limit tetiklenme sayısını logla ve izle; **warning** 5 dk içinde aynı IP'den >20 tetiklenme, **critical** >100 veya çok sayıda farklı e-posta hedeflenmesi (credential-stuffing paterni).
- **Yanlış pozitif riski**: Paylaşımlı kurumsal IP (NAT arkasında çok kullanıcı) yanlışlıkla yüksek başarısızlık oranı üretebilir.
- **İlk müdahale**: Hedeflenen hesapları geçici olarak izlemeye al; şüpheli IP'yi proxy/firewall seviyesinde 🔧 operatör kararıyla sınırla; `forgotPasswordAction`, `resendVerificationAction`, davet create/resend gibi **rate-limit'siz** endpoint'lerin de kötüye kullanılıp kullanılmadığını kontrol et (bunlar `docs/PRODUCTION_READINESS.md` §3'te sınırsız olarak işaretli).

### 4. PostgreSQL bağlantı havuzu

- **Ne ölçülür**: Aktif/boşta Prisma bağlantı sayısı, havuz doygunluğu.
- **Neden önemli**: Oturum doğrulama **her istekte** DB'ye gider (`lib/auth/session.ts` — JWT değil, `Session.tokenHash` sorgusu); havuz tükenirse tüm authenticated trafik (yeni login'ler dahil, mevcut oturumlar dahil) etkilenir.
- **Mevcut durum**: ❌ `DATABASE_URL`'de `connection_limit` veya PgBouncer/Prisma Accelerate gibi bir havuz yönetimi **yapılandırılmamış** (`docs/PRODUCTION_READINESS.md` §5/§9'da flag edilmiş).
- **Önerilen yaklaşım (💡 başlangıç)**: PostgreSQL `pg_stat_activity` üzerinden aktif bağlantı sayısını izle; **warning** `max_connections`'ın %70'i, **critical** %90'ı.
- **Yanlış pozitif riski**: Kısa süreli spike'lar (ör. deploy sonrası ilk trafik dalgası) normal olabilir; sürekli yüksek seviye asıl sorun.
- **İlk müdahale**: [INCIDENT_RESPONSE_RUNBOOK.md — database outage](./INCIDENT_RESPONSE_RUNBOOK.md#database-outage) akışına bak; uzun vadede `connection_limit` ayarı veya PgBouncer eklenmesi 💡 önerilir (bu görev kapsamında uygulanmaz).

### 5. Database disk ve büyüme

- **Ne ölçülür**: PostgreSQL veri dizini disk kullanımı ve büyüme trendi.
- **Neden önemli**: Finansal veriler (`FinancialTransaction`, `AccountMovement`, `AuditLog`) append-only/iptal-ile-yönetilir modelde tutuluyor (soft-delete yok, hard-delete yok) — veri sürekli büyür, asla küçülmez.
- **Önerilen yaklaşım (💡 başlangıç)**: Günlük disk kullanım yüzdesi; **warning** %75, **critical** %90.
- **Yanlış pozitif riski**: Toplu import/migration sonrası tek seferlik sıçrama normal olabilir.
- **İlk müdahale**: [INCIDENT_RESPONSE_RUNBOOK.md — disk dolması](./INCIDENT_RESPONSE_RUNBOOK.md#disk-dolması) akışına geç; acil değilse disk büyütme/arşivleme planı 🔧 operatör kararıdır.

### 6. Prisma/migration hataları

- **Ne ölçülür**: `prisma migrate deploy` başarısı/başarısızlığı, runtime'da Prisma client hata oranı.
- **Neden önemli**: Migration hatası deploy'u durdurmalı; runtime Prisma hataları şema/veri tutarsızlığına işaret edebilir.
- **Önerilen yaklaşım (💡 başlangıç)**: Deploy pipeline'ında `prisma migrate deploy` exit code'u **critical** olarak ele alınmalı (0 dışı → deploy durur). Runtime'da Prisma client `"error"` seviyeli loglar (`lib/db.ts`) izlenmeli; **warning** saatte >10 hata.
- **YF-512 kapsam notu**: `prisma migrate deploy` uygulama sürecinin **dışında**, deploy zamanında (CI/CD veya operatör tarafından elle) çalışır — bu görev kapsamında sahte bir "runtime capture" eklenmemiştir (bkz. görev talimatı, "If migration runs outside the application process, do not fake runtime capture"). Bunun yerine: CI/CD pipeline'ı `prisma migrate deploy`'un **exit code**'unu deploy'u durduran bir adım olarak ele almalıdır (`0` dışı → deploy FAIL); bu zaten `.github/workflows/ci.yml`'de CI DB'sine karşı çalıştırılıyor ancak **production deploy pipeline'ı repoda yok** (bkz. [DEPLOYMENT_RUNBOOK.md — doğrulanmış mevcut deployment modeli](./DEPLOYMENT_RUNBOOK.md#doğrulanmış-mevcut-deployment-modeli)), bu yüzden bu kontrol 🔧 operatörün kuracağı deploy scriptine/CI job'una eklenmelidir. 💡 Öneri: deploy scripti `prisma migrate deploy` başarısız olursa (exit code ≠ 0) süreci durdursun VE (varsa) bir webhook/Sentry CLI çağrısıyla ("release oluşturma başarısız" gibi) ayrı bir sinyal göndersin — bu adım şu an repoda yoktur, gerçekleştirilmesi operatörün CI/CD altyapısına bağlıdır.
- **Yanlış pozitif riski**: Beklenen constraint ihlalleri (ör. `SELECT ... FOR UPDATE` çakışması, kullanıcı hatası nedeniyle unique constraint) uygulama katmanında zaten `ServiceError`'a çevrilip yakalanıyor olabilir — ham Prisma hata sayacı bunları ayırt etmeyebilir.
- **İlk müdahale**: [ROLLBACK_RUNBOOK.md — deploy sırasında kısmi başarı](./ROLLBACK_RUNBOOK.md#deploy-sırasında-kısmi-başarı) veya [INCIDENT_RESPONSE_RUNBOOK.md — migration failure](./INCIDENT_RESPONSE_RUNBOOK.md#migration-failure).

### 7. SMTP delivery hataları

- **Ne ölçülür**: `email.delivery_failed` olay sayısı, kategori dağılımı.
- **Neden önemli**: Doğrulama e-postası, şifre sıfırlama, davet gönderimi SMTP'ye bağımlı; production'da SMTP zorunlu (`lib/env.ts`).
- **Mevcut durum**: ✅ `lib/email/mailer.ts` her gönderim hatasında yapılandırılmış bir JSON log satırı üretir: `event: "email.delivery_failed"`, `category` (`classifyMailError` — AUTHENTICATION/CONNECTION_TIMEOUT/GREETING_TIMEOUT/SOCKET_TIMEOUT/TLS_CERTIFICATE/CONNECTION_REFUSED/RECIPIENT_REJECTED/TEMPORARY_PROVIDER/PERMANENT_PROVIDER/CONFIGURATION/UNKNOWN), `retryable`, `smtpStatusCode`, `recipientHash` (SHA-256, ham adres değil), `durationMs`. Bu satır bir log toplama sistemine yönlendirilip alarm kaynağı yapılabilir (💡 log toplama repoda yok). ✅ (YF-512) Aynı olay, örneklemeli olarak `security.smtp_failure` adıyla Sentry'ye de iletilir (bkz. [Sentry entegrasyonu — Örnekleme](#örnekleme-sampling)) — e-posta gövdesi, SMTP parolası/auth header'ı veya token asla iletilmez.
- **Önerilen yaklaşım (💡 başlangıç)**: **warning** 15 dk içinde >5 `email.delivery_failed`, **critical** `category: AUTHENTICATION` veya `CONFIGURATION` (yapılandırma hatası — tüm gönderimler etkilenir) veya >20/15dk.
- **Yanlış pozitif riski**: `RECIPIENT_REJECTED` (geçersiz alıcı adresi) kullanıcı hatasıdır, sistemsel sorun değildir — kategoriye göre ayrı ele alınmalı.
- **İlk müdahale**: [INCIDENT_RESPONSE_RUNBOOK.md — SMTP outage](./INCIDENT_RESPONSE_RUNBOOK.md#smtp-outage).

### 8. Background job durumu

❌ **Repository'de bir background job/queue sistemi yoktur.** Tüm işlemler (export, e-posta gönderimi) senkron HTTP request/Server Action içinde çalışır — ayrı bir worker/job runner yok. Bu nedenle bu sinyal **bu repository için uygulanamaz**; ileride bir job sistemi eklenirse (ör. export'ların arka plana alınması) bu bölüm güncellenmelidir.

### 9. Export hata ve süreleri

- **Ne ölçülür**: `app/api/exports/*` route'larının hata oranı ve süresi (Excel/PDF üretimi).
- **Neden önemli**: Export'lar bellekte büyük buffer oluşturur (`ExcelJS.Workbook.xlsx.writeBuffer()`, pdfmake stream → Buffer); büyük veri setlerinde memory/latency riski taşır (`docs/PRODUCTION_READINESS.md` §14 — "ölçekte yük testi yapılmadı" notu).
- **Mevcut durum**: ✅ `server/exports/http.ts`'deki `errorToResponse()` beklenmeyen hataları `export.unexpected_error` olarak `{name, message}` loglar (stack trace/PII sızdırmaz).
- **Önerilen yaklaşım (💡 başlangıç)**: **warning** export süresi p95 > 10s, **critical** > 30s veya export route'larında 5xx oranı > %5.
- **Yanlış pozitif riski**: Çok büyük proje/organizasyon verisi olan tek bir tenant'ın export'u doğal olarak uzun sürebilir — genel alarmı bozmaması için tenant bazlı outlier ayrımı 💡 önerilir.
- **İlk müdahale**: [INCIDENT_RESPONSE_RUNBOOK.md — export hatası](./INCIDENT_RESPONSE_RUNBOOK.md#export-hatası); route'lar `runtime = "nodejs"` ile çalışır (Edge değil) — süreç memory/CPU sinyaline bak (#11).

### 10. Application restart/crash

- **Ne ölçülür**: `next start` sürecinin beklenmeyen şekilde sonlanma/yeniden başlama sayısı.
- **Neden önemli**: Env doğrulama hatası, unhandled exception veya OOM nedeniyle süreç çökebilir; process supervisor yoksa (bkz. [DEPLOYMENT_RUNBOOK.md](./DEPLOYMENT_RUNBOOK.md#7-processcontainer-restart)) uygulama tamamen erişilemez kalır.
- **Önerilen yaklaşım (💡 başlangıç)**: Process supervisor/orchestrator seviyesinde restart sayacı; **warning** saatte >1 restart, **critical** kısa döngüde tekrarlayan crash-loop (ör. 10 dk içinde >3 restart).
- **Yanlış pozitif riski**: Planlı deploy restart'ları bu sayaca dahil olmamalı — deploy penceresiyle korele edilmeli.
- **İlk müdahale**: stdout/stderr'de son çökme mesajını incele (env hatası mı, unhandled exception mı); env hatasıysa [DEPLOYMENT_RUNBOOK.md](./DEPLOYMENT_RUNBOOK.md#gerekli-ortam-değişkenleri) ile karşılaştır; gerekirse [ROLLBACK_RUNBOOK.md](./ROLLBACK_RUNBOOK.md).

### 11. CPU, memory, disk

- **Ne ölçülür**: Uygulama sürecinin ve DB sunucusunun CPU/memory/disk kullanımı.
- **Neden önemli**: Export işlemleri bellekte buffer oluşturduğundan (yukarıda #9) memory baskısı export yoğunluğuyla ilişkili olabilir; DB tarafında disk büyümesi #5'te ayrıca ele alınır.
- **Önerilen yaklaşım (💡 başlangıç)**: **warning** CPU/memory sürekli >%70 (5 dk ortalama), **critical** >%90 veya OOM kill.
- **Yanlış pozitif riski**: Build/deploy sırasındaki kısa CPU spike'ları (npm ci, next build) production trafiğiyle karıştırılmamalı — build genelde ayrı bir CI/build makinesinde çalışır, ancak aynı host'ta yapılıyorsa alarm penceresi ayrılmalı.
- **İlk müdahale**: Hangi sürecin (app mi DB mi) baskı yarattığını belirle; export trafiği yoğunsa #9'a bak; kalıcıysa kapasite artırımı 🔧 operatör kararıdır.

### 12. TLS sertifika bitişi

❌ Repository'de TLS sonlandırma yapılandırması yok (bkz. [DEPLOYMENT_RUNBOOK.md](./DEPLOYMENT_RUNBOOK.md#tls--reverse-proxy-beklentisi)); sertifika reverse proxy/load balancer seviyesinde yönetilir.

- **Ne ölçülür**: Production domain sertifikasının kalan geçerlilik süresi.
- **Neden önemli**: Süresi dolan sertifika tüm HTTPS erişimini keser; oturum çerezi `secure` bayraklı olduğundan login akışı da etkilenir.
- **Önerilen yaklaşım (💡 başlangıç)**: **warning** 14 gün kala, **critical** 3 gün kala. Otomatik yenileme (ör. Let's Encrypt/ACME) kullanılıyorsa yenileme başarısızlığı ayrıca izlenmeli.
- **Yanlış pozitif riski**: Otomatik yenileme aracı zaten erken yeniliyorsa (ör. 30 gün kala) warning eşiği gereksiz gürültü üretebilir — yenileme mekanizmasının döngüsüne göre kalibre edilmeli.
- **İlk müdahale**: 🔧 Sertifika yenileme prosedürü operatörün TLS/proxy altyapısına bağlıdır, bu görev kapsamında tanımlanmaz.

### 13. Backup başarısı ve backup yaşı

- **Ne ölçülür**: Son başarılı backup'ın zamanı ve boyutu.
- **Neden önemli**: [BACKUP_RESTORE_RUNBOOK.md](./BACKUP_RESTORE_RUNBOOK.md) içinde tanımlanan yedekleme sürecinin fiilen çalıştığının kanıtı; ❌ repository'de otomatik backup yoktur, bu nedenle bu sinyal manuel prosedürün takip edildiğini doğrulamak için kritik önemdedir.
- **Önerilen yaklaşım (💡 başlangıç)**: **warning** son başarılı backup >26 saat önce (günlük backup varsayımıyla), **critical** >48 saat önce veya son backup checksum doğrulamasından geçmemiş.
- **Yanlış pozitif riski**: Backup penceresi ile kontrol zamanlaması çakışırsa (ör. backup gece yarısı çalışıyor, kontrol sabah 06:00'da) yanlışlıkla "gecikmiş" görünebilir — pencere hizalanmalı.
- **İlk müdahale**: [INCIDENT_RESPONSE_RUNBOOK.md — backup başarısızlığı](./INCIDENT_RESPONSE_RUNBOOK.md#backup-başarısızlığı).

### 14. Tenant izolasyonu / güvenlik anomalileri

- **Ne ölçülür**: `AuditLog` üzerinden anormal erişim paternleri (ör. bir kullanıcının kendi `organizationId`'si dışında bir kayda erişim denemesi — kod seviyesinde zaten engellenir, ama denemenin kendisi izlenmelidir).
- **Neden önemli**: Cross-tenant erişim, bu ürün için en yüksek önem düzeyinde güvenlik olayıdır (bkz. [INCIDENT_RESPONSE_RUNBOOK.md — olası cross-tenant erişim](./INCIDENT_RESPONSE_RUNBOOK.md#olası-cross-tenant-erişim)).
- **Mevcut durum**: ✅ `AuditLog` modeli (`organizationId`, `actorId`, `action`, `entityType`, `entityId`, `beforeJson`/`afterJson`, `ipAddress`, `userAgent`) mevcut; `tests/tenant-isolation.test.ts` (veya eşdeğeri) ile org-scope testleri repoda var (`docs/ARCHITECTURE.md` §3, `docs/PRODUCTION_READINESS.md` §6). ❌ Ancak **gerçek zamanlı bir anomali tespiti/alarm mekanizması yoktur** — mevcut testler yalnızca CI'da regresyonu yakalar, production'da canlı bir sinyal üretmez.
- **Önerilen yaklaşım (💡 başlangıç)**: Servis katmanında org-scope ihlali denemesi (ör. bir `ServiceError`'ın "yetkisiz erişim" kategorisiyle fırlatılması) ayrı bir güvenlik log kanalına (ör. `event: "security.cross_org_attempt"`) yazılmalı — bu **repoda henüz yok**, 💡 takip görevi olarak işaretlenmiştir. Eklendiğinde: **critical** — herhangi bir tetiklenme insan incelemesi gerektirir (sıfır tolerans, "normal" sayı yoktur).
- **Yanlış pozitif riski**: Kullanıcının birden fazla organizasyona üye olduğu meşru senaryolarda (ürün bunu destekliyorsa) org geçişleri yanlış pozitif üretebilir — 🔧 ürünün çoklu-org üyelik modeli netleştirilmeli (bu belge kapsamında doğrulanmadı, `docs/DATA_MODEL.md`/`docs/ARCHITECTURE.md`'ye bakılmalı).
- **İlk müdahale**: [INCIDENT_RESPONSE_RUNBOOK.md — olası cross-tenant erişim](./INCIDENT_RESPONSE_RUNBOOK.md#olası-cross-tenant-erişim) — **yüksek öncelikli güvenlik olayı** olarak ele alınır.

## PII/secret loglamama ilkesi — uygulama örnekleri

Mevcut kod tabanından doğrulanmış iyi örnekler (yeni eklenen sinyaller bu standardı korumalı):

- `recipientHash` (`lib/email/mailer.ts`) — ham e-posta adresi yerine SHA-256 kısaltılmış hash.
- `server/exports/http.ts` — beklenmeyen hatalarda yalnızca `{name, message}`, stack trace veya istek gövdesi loglanmaz.
- Export HTTP yanıtları `Cache-Control: private, no-store` ile işaretli — export dosyaları sunucu diskinde kalıcı tutulmaz (bkz. [BACKUP_RESTORE_RUNBOOK.md](./BACKUP_RESTORE_RUNBOOK.md) kapsam dışı notu).

## Bilinen eksikler (takip görevleri)

| Eksik | Etki | Önerilen takip |
|---|---|---|
| ~~APM/error-tracking entegrasyonu yok~~ | ✅ Çözüldü (YF-512) — `@sentry/node`, bkz. [Sentry entegrasyonu](#sentry-entegrasyonu-yf-512) | — |
| ~~`/api/health` yok~~ | ✅ Çözüldü (YF-511) — bkz. [DEPLOYMENT_RUNBOOK.md](./DEPLOYMENT_RUNBOOK.md#healthreadiness-doğrulaması) | — |
| ~~DB health-check hatası hiç loglanmıyordu~~ | ✅ Çözüldü (YF-512) — `lib/health/db-check.ts` artık sınıflandırılmış, sır içermeyen bir kategori loglar ve örneklemeli olarak Sentry'ye iletir | — |
| Request correlation ID yok | Hata/log korelasyonu zor | `docs/ARCHITECTURE.md` §9'da hedef, henüz uygulanmadı (YF-512 kapsamı dışı) |
| Cross-tenant erişim denemesi için ayrı güvenlik log kanalı yok | Anomali tespiti manuel/test-only | Servis katmanına güvenlik event logu eklenmesi (YF-512 kapsamı yalnızca rate-limit/failed-login/SMTP/DB'yi kapsar — bu kalem hâlâ ayrı bir görev) |
| Redis tabanlı dağıtık rate limiting desteği mevcut; production yapılandırması gerekli | `REDIS_URL` veya `TRUSTED_PROXY_COUNT` eksikse dağıtık koruma etkin olmaz; Redis kesintisinde koruma instance-local fallback seviyesine düşer | Production env değerlerini doğrula; `rate_limit.blocked` ve `store_unavailable` olayları artık örneklemeli olarak Sentry'ye de iletiliyor (YF-512) |
| Migration/deploy hatası için ayrı bir CI/CD sinyali (webhook/Sentry release) yok | `prisma migrate deploy` başarısızlığı yalnızca deploy scriptinin exit code'una bağlı — repoda production deploy pipeline'ı zaten yok | 🔧 Operatörün kuracağı deploy scriptine exit-code kontrolü + isteğe bağlı webhook eklenmesi (bkz. [#6 Prisma/migration hataları](#6-prismamigration-hataları)) |
