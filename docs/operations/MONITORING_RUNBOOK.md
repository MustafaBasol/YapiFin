# Monitoring Runbook

**Bağlı belgeler**: [README.md](./README.md) · [INCIDENT_RESPONSE_RUNBOOK.md](./INCIDENT_RESPONSE_RUNBOOK.md) · [BACKUP_RESTORE_RUNBOOK.md](./BACKUP_RESTORE_RUNBOOK.md)

## Mevcut durum

❌ **Repository'de herhangi bir monitoring/APM/error-tracking entegrasyonu yoktur** (`docs/PRODUCTION_READINESS.md` risk R-8: Sentry veya benzeri bir hata izleme aracı entegre değil). Yapılandırılmış loglama sınırlıdır: `console.error`/`console.log` ile bazı yerlerde elle yazılmış JSON satırları (`lib/email/mailer.ts`, `server/exports/http.ts`), `lib/db.ts`'de Prisma client'ın production'da yalnızca `"error"` seviyesini loglaması. Request correlation ID **yoktur** (`docs/ARCHITECTURE.md` §9'da hedef olarak listelenmiş, henüz uygulanmamış).

Bu belgede önerilen tüm eşik değerleri **başlangıç önerisidir**, repository'den ölçülmüş/kanıtlanmış bir SLO değildir — 💡 olarak işaretlenmiştir. Gerçek eşikler, production trafiği gözlemlendikten sonra operatör tarafından kalibre edilmelidir.

⚠️ **Genel kural**: Hiçbir monitoring/log sinyali PII (e-posta, ad-soyad, IP dışında kişisel veri), token, parola veya finansal tutar/detay içermemelidir. Mevcut kod tabanında bu ilke kısmen uygulanıyor (ör. `recipientHash` — SHA-256 kısaltılmış hash, ham e-posta değil); yeni eklenecek her log/metrik bu ilkeye uymalıdır.

## Sinyaller

Her sinyal için: ne ölçülür, neden önemli, önerilen warning/critical yaklaşımı, yanlış pozitif riski, ilk müdahale.

### 1. HTTP availability

- **Ne ölçülür**: Uygulamanın temel bir sayfaya (ör. `/login`) HTTP yanıtı verip vermediği.
- **Neden önemli**: En temel "uygulama ayakta mı" sinyali; tüm kullanıcı erişimini etkiler.
- **Önerilen yaklaşım (💡 başlangıç)**: Dış bir uptime checker'dan 1-2 dakikada bir `GET /login` (veya eklendiğinde `/api/health`, bkz. [DEPLOYMENT_RUNBOOK.md](./DEPLOYMENT_RUNBOOK.md#healthreadiness-doğrulaması)) isteği; **warning** = 1 ardışık başarısızlık, **critical** = 3 ardışık başarısızlık veya 5 dakika kesinti.
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
- **Mevcut durum**: `lib/auth/rate-limit.ts` içinde **in-memory `Map`** tabanlı, tek-instance rate limiter login'de aktif (`login:${ip}:${email}`, 15 dakikada 10 deneme — `docs/PRODUCTION_READINESS.md` §3). Bu limit aşıldığında uygulama zaten isteği reddeder; ancak **bu olaylar için ayrı bir metrik/log/alarm yoktur** ve limiter yatay ölçeklendirmede (birden fazla instance) güvenli değildir.
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
- **Yanlış pozitif riski**: Beklenen constraint ihlalleri (ör. `SELECT ... FOR UPDATE` çakışması, kullanıcı hatası nedeniyle unique constraint) uygulama katmanında zaten `ServiceError`'a çevrilip yakalanıyor olabilir — ham Prisma hata sayacı bunları ayırt etmeyebilir.
- **İlk müdahale**: [ROLLBACK_RUNBOOK.md — deploy sırasında kısmi başarı](./ROLLBACK_RUNBOOK.md#deploy-sırasında-kısmi-başarı) veya [INCIDENT_RESPONSE_RUNBOOK.md — migration failure](./INCIDENT_RESPONSE_RUNBOOK.md#migration-failure).

### 7. SMTP delivery hataları

- **Ne ölçülür**: `email.delivery_failed` olay sayısı, kategori dağılımı.
- **Neden önemli**: Doğrulama e-postası, şifre sıfırlama, davet gönderimi SMTP'ye bağımlı; production'da SMTP zorunlu (`lib/env.ts`).
- **Mevcut durum**: ✅ `lib/email/mailer.ts` her gönderim hatasında yapılandırılmış bir JSON log satırı üretir: `event: "email.delivery_failed"`, `category` (`classifyMailError` — AUTHENTICATION/CONNECTION_TIMEOUT/GREETING_TIMEOUT/SOCKET_TIMEOUT/TLS_CERTIFICATE/CONNECTION_REFUSED/RECIPIENT_REJECTED/TEMPORARY_PROVIDER/PERMANENT_PROVIDER/CONFIGURATION/UNKNOWN), `retryable`, `smtpStatusCode`, `recipientHash` (SHA-256, ham adres değil), `durationMs`. Bu satır bir log toplama sistemine yönlendirilip alarm kaynağı yapılabilir (💡 log toplama repoda yok).
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
| APM/error-tracking entegrasyonu yok | Runtime hataları yalnızca stdout/stderr'de, merkezi görünürlük yok | Sentry veya benzeri bir araç entegrasyonu — ayrı görev |
| `/api/health` yok | Otomatik health check yapılamıyor, manuel `curl` gerekiyor | bkz. [DEPLOYMENT_RUNBOOK.md](./DEPLOYMENT_RUNBOOK.md#healthreadiness-doğrulaması) |
| Request correlation ID yok | Hata/log korelasyonu zor | `docs/ARCHITECTURE.md` §9'da hedef, henüz uygulanmadı |
| Cross-tenant erişim denemesi için ayrı güvenlik log kanalı yok | Anomali tespiti manuel/test-only | Servis katmanına güvenlik event logu eklenmesi |
| Dağıtık rate limiting yok (in-memory `Map`) | Çoklu instance'ta rate limit güvenilmez | Redis tabanlı rate limiter (kapsam dışı — proje talimatında Redis implementasyonu bu göreve dahil değil) |
