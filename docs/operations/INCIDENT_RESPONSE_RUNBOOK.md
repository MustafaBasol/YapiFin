# Incident Response Runbook

**Bağlı belgeler**: [README.md](./README.md) · [MONITORING_RUNBOOK.md](./MONITORING_RUNBOOK.md) · [BACKUP_RESTORE_RUNBOOK.md](./BACKUP_RESTORE_RUNBOOK.md) · [ROLLBACK_RUNBOOK.md](./ROLLBACK_RUNBOOK.md)

## Genel ilkeler

- Bu belge her olay türü için **ilk müdahale** akışını tanımlar — kök neden analizi/post-mortem şablonu kapsam dışıdır.
- 🔧 **Karar yetkilisi/eskalasyon zinciri** bu belgede tanımlanmaz (kurum organizasyon yapısına bağlıdır); her bölümde "kime eskale edilir" için 🔧 işareti kullanılmıştır.
- ⚠️ **Cross-tenant veri erişimi şüphesi, bu üründeki en yüksek öncelikli güvenlik olayıdır** (bkz. [aşağıdaki bölüm](#olası-cross-tenant-erişim)) — multi-tenant bir finans ürününde bir organizasyonun verisinin başka bir organizasyona sızması, doğrudan mevzuat ve güven riski taşır.
- İncident logları/kayıtları **PII içermemelidir** — mevcut kod tabanı (`recipientHash`, `{name, message}` log paternleri) bu ilkeyi zaten kısmen uyguluyor; olay kayıtlarında da ham e-posta/parola/token/finansal tutar detayı yazılmamalıdır, bunun yerine ID/hash/kategori referans edilmelidir.

## Login/auth outage

**Belirti**: Kullanıcılar giriş yapamıyor veya mevcut oturumlar geçersiz görünüyor.

**Bağlam**: Oturum doğrulama JWT değil, her istekte DB'ye giden `Session.tokenHash` sorgusudur (`lib/auth/session.ts`) — bu nedenle bir DB sorunuyla auth sorunu aynı kökten gelebilir.

**İlk müdahale**:
1. Önce [Database outage](#database-outage) belirtisi olup olmadığını kontrol edin (DB bağlantı hatası genelde auth outage gibi görünür).
2. `next start` sürecinin ayakta olduğunu doğrulayın; stdout/stderr'de `Ortam değişkenleri geçersiz` gibi bir başlangıç hatası var mı bakın (`AUTH_SECRET` ile ilgili olabilir, bkz. [DEPLOYMENT_RUNBOOK.md — gerekli ortam değişkenleri](./DEPLOYMENT_RUNBOOK.md#gerekli-ortam-değişkenleri)).
3. Rate limiter'ın (`lib/auth/rate-limit.ts`) meşru kullanıcıları da bloke edip etmediğini kontrol edin — bkz. [MONITORING_RUNBOOK.md — authentication failure oranları](./MONITORING_RUNBOOK.md#3-authentication-failure-oranları).
4. Yakın zamanda bir deploy yapıldıysa [ROLLBACK_RUNBOOK.md — senaryo 1/4](./ROLLBACK_RUNBOOK.md#senaryo-1--yalnızca-uygulama-kodu-rollback) değerlendirin.
5. 🔧 Eskalasyon: 🔧.

## Database outage

**Belirti**: Uygulama DB'ye bağlanamıyor; tüm authenticated istekler ve finansal işlemler başarısız oluyor.

**İlk müdahale**:
1. PostgreSQL sürecinin/servisinin ayakta olduğunu doğrulayın (🔧 operatörün DB barındırma ortamına özgü kontrol).
2. Bağlantı havuzu doygunluğunu kontrol edin — bkz. [MONITORING_RUNBOOK.md — PostgreSQL bağlantı havuzu](./MONITORING_RUNBOOK.md#4-postgresql-bağlantı-havuzu) (❌ repoda `connection_limit`/PgBouncer yapılandırması yok, havuz tükenmesi olası bir kök nedendir).
3. Ağ/firewall/security-group değişikliği yakın zamanda yapıldı mı kontrol edin — ⚠️ production DB public internet'e açık bırakılmamalıdır, bu kontrol sırasında yanlışlıkla açılmadığından da emin olun.
4. DB fiilen kaybolduysa (donanım/instance arızası) [BACKUP_RESTORE_RUNBOOK.md](./BACKUP_RESTORE_RUNBOOK.md) prosedürüyle yeni bir instance'a restore gerekebilir — bu, karar yetkilisi onayı gerektiren büyük bir adımdır.
5. 🔧 Eskalasyon: 🔧.

## Migration failure

**Belirti**: `prisma migrate deploy` deploy sırasında hata ile sonlanıyor.

**İlk müdahale**:
1. Hata mesajını tam olarak kaydedin (hangi migration, hangi SQL ifadesi başarısız oldu).
2. Migration'ın **kısmen** uygulanıp uygulanmadığını `npx prisma migrate status` ile kontrol edin.
3. [ROLLBACK_RUNBOOK.md — senaryo 6: deploy sırasında kısmi başarı](./ROLLBACK_RUNBOOK.md#senaryo-6--deploy-sırasında-kısmi-başarı) akışına geçin.
4. Migration destructive nitelikteyse ve veri kaybı riski varsa, production'a herhangi bir düzeltici işlem uygulamadan önce mevcut durumu [BACKUP_RESTORE_RUNBOOK.md](./BACKUP_RESTORE_RUNBOOK.md#manuel-mantıksal-yedek-alma) ile yedekleyin (deploy öncesi backup zaten alınmış olmalıydı — bu, o backup'tan **sonraki** durumu yakalar).
5. 🔧 Eskalasyon: 🔧 (destructive migration şüphesi varsa karar yetkilisi zorunlu, bkz. [ROLLBACK_RUNBOOK.md — senaryo 3](./ROLLBACK_RUNBOOK.md#senaryo-3--destructive-veya-non-reversible-migration)).

## Veri bütünlüğü şüphesi

**Belirti**: Finansal tutarlar tutarsız görünüyor (ör. bir hesabın bakiyesi hareketlerle uyuşmuyor, bir tahsilat/ödeme sonrası kalan tutar yanlış hesaplanmış).

**İlk müdahale**:
1. **Hiçbir düzeltici yazma işlemi yapmadan önce**, şüpheli kayıtları salt-okunur olarak inceleyin ve zaman damgası/ilgili kullanıcı ile birlikte not edin.
2. Negatif bakiye/tutarsızlık kontrolü çalıştırın — bkz. [BACKUP_RESTORE_RUNBOOK.md — tenant ve finansal veri doğrulama örnekleri](./BACKUP_RESTORE_RUNBOOK.md#6-tenant-ve-finansal-veri-doğrulama-örnekleri) içindeki sorgu paterni (production'da salt-okunur olarak, yalnızca `SELECT`, çalıştırılabilir).
3. İlgili `AuditLog` kayıtlarını (`entityType`/`entityId` ile) inceleyerek hangi işlemin/kullanıcının/zaman diliminin şüpheli değişikliğe yol açtığını belirleyin.
4. Kök neden bir kod hatasıysa (ör. `ledger.ts`/`settlement-service.ts`/`transfer-service.ts` içindeki satır kilitleme mantığında bir regresyon), [ROLLBACK_RUNBOOK.md — senaryo 1](./ROLLBACK_RUNBOOK.md#senaryo-1--yalnızca-uygulama-kodu-rollback) değerlendirin.
5. ⚠️ Şüpheli kayıtları asla doğrudan `DELETE`/manuel `UPDATE` ile "düzeltmeyin" — bu, audit log ilkesini (finansal kayıtlar hard-delete edilmez, iptal/düzeltme kaydıyla yönetilir) ihlal eder ve adli inceleme izini bozar. Düzeltme, uygulamanın kendi iptal/düzeltme akışları üzerinden yapılmalıdır.
6. 🔧 Eskalasyon: 🔧 (etkilenen organizasyon(lar)ın bilgilendirilmesi gerekip gerekmediği 🔧 operatör/iş kararıdır).

## Olası cross-tenant erişim

⚠️ **YÜKSEK ÖNCELİKLİ GÜVENLİK OLAYI — bu bölüm, listedeki diğer tüm olay türlerinden daha yüksek önem derecesiyle ele alınmalıdır.**

**Belirti**: Bir kullanıcının, kendi `organizationId`'si dışındaki bir organizasyonun verisine (proje, işlem, kullanıcı listesi vb.) eriştiğine dair kanıt veya şüphe.

**Bağlam**: Tenant izolasyonu yalnızca servis katmanında uygulanır (DB seviyesinde row-level security yoktur — `docs/ARCHITECTURE.md` §3). Bu nedenle bir servis fonksiyonundaki org-scope kontrolü eksikliği, doğrudan cross-tenant veri sızıntısına yol açabilir. `tests/tenant-isolation.test.ts` (veya eşdeğeri) bu senaryoları CI'da test eder, ancak production'da canlı bir anomali tespiti **yoktur** (bkz. [MONITORING_RUNBOOK.md — tenant izolasyonu/güvenlik anomalileri](./MONITORING_RUNBOOK.md#14-tenant-izolasyonu--güvenlik-anomalileri)).

**İlk müdahale**:
1. **Derhal**: şüpheli erişimin kapsamını belirleyin — hangi kullanıcı, hangi organizasyon(lar)ın verisine, hangi endpoint/işlem üzerinden erişti. `AuditLog` (`ipAddress`, `userAgent`, `actorId`) ve uygulama loglarını inceleyin.
2. Eğer belirli bir endpoint/servis fonksiyonu kök nedense (ör. bir org-scope filtresi eksik), o endpoint'i **geçici olarak devre dışı bırakmayı** (feature flag yoksa, hızlı bir hotfix deploy'u ile) değerlendirin — bkz. [ROLLBACK_RUNBOOK.md — senaryo 1](./ROLLBACK_RUNBOOK.md#senaryo-1--yalnızca-uygulama-kodu-rollback).
3. Etkilenen organizasyon(lar)ı ve etkilenen veri kapsamını netleştirin (hangi kayıtlar görüntülendi/değiştirildi mi yoksa yalnızca görüntülendi mi).
4. 🔧 **Etkilenen tenant'lara bildirim gerekip gerekmediği ve mevzuat/sözleşme yükümlülükleri** (KVKK dahil) bu belgenin kapsamı dışındadır — hukuki/iş kararı gerektirir, derhal ilgili karar yetkilisine eskale edilmelidir.
5. Kök neden kod düzeltmesiyle kapatıldıktan sonra, aynı paternin başka bir yerde tekrarlanmadığını doğrulamak için ilgili servis dosyalarında (ör. tüm `*-service.ts` dosyalarında org-scope kontrolü) bir gözden geçirme yapılmalıdır.
6. 🔧 Eskalasyon: 🔧 — **bu olay türü, diğer tüm olay türlerinden farklı olarak, ilk tespit anında en üst düzey karar yetkilisine bildirilmelidir.**

## Secret sızıntısı

**Belirti**: Bir secret (`AUTH_SECRET`, `DATABASE_URL` içindeki DB parolası, SMTP kimlik bilgisi) yanlışlıkla bir yerde açığa çıktı (ör. commit edildi, loglara yazıldı, halka açık bir kanalda paylaşıldı).

**İlk müdahale**:
1. Sızıntının kapsamını belirleyin: hangi secret, nerede (git geçmişi, log, chat) açığa çıktı.
2. **Derhal rotasyon**: sızan secret'ı yeni bir değerle değiştirin.
   - `AUTH_SECRET` rotasyonu: yeni bir ≥32 karakter rastgele değer üretin (ör. `openssl rand -base64 32`), env'i güncelleyin, [ROLLBACK_RUNBOOK.md — senaryo 4](./ROLLBACK_RUNBOOK.md#senaryo-4--environmentconfig-rollback) prosedürüyle restart edin. Not: mevcut oturumlar `AUTH_SECRET`'a değil `Session.tokenHash`'e dayandığından (`lib/auth/session.ts`), bu rotasyon mevcut oturumları otomatik geçersiz kılmaz — kasıtlı bir toplu oturum sonlandırması gerekiyorsa `Session` tablosunun temizlenmesi ayrı bir 🔧 operatör kararıdır.
   - `DATABASE_URL` parolası: DB kullanıcısının parolasını PostgreSQL seviyesinde değiştirin, ardından env'i güncelleyip restart edin.
   - SMTP kimlik bilgisi: SMTP sağlayıcısında kimlik bilgisini rotasyona sokun, env'i güncelleyip restart edin.
3. Eğer secret bir git commit'inde açığa çıktıysa: yalnızca commit'i revert etmek **yeterli değildir** (secret git geçmişinde kalır) — rotasyon (adım 2) zorunludur; git geçmişinden temizleme (ör. `git filter-repo`) ayrı, dikkatli planlanması gereken bir işlemdir ve bu belgenin kapsamı dışındadır.
4. 🔧 Eskalasyon: 🔧.

## SMTP outage

**Belirti**: `email.delivery_failed` olaylarında artış (bkz. [MONITORING_RUNBOOK.md — SMTP delivery hataları](./MONITORING_RUNBOOK.md#7-smtp-delivery-hataları)); kullanıcılar doğrulama/şifre sıfırlama/davet e-postası alamıyor.

**İlk müdahale**:
1. `category` alanına bakın (`classifyMailError` çıktısı): `AUTHENTICATION`/`CONFIGURATION` ise yapılandırma sorunu (tüm gönderimler etkilenir); `CONNECTION_TIMEOUT`/`CONNECTION_REFUSED`/`GREETING_TIMEOUT`/`SOCKET_TIMEOUT` ise SMTP sağlayıcı tarafı erişilemez olabilir; `TLS_CERTIFICATE` ise sağlayıcının sertifikasında sorun olabilir; `RECIPIENT_REJECTED` tekil kullanıcı hatasıdır, outage değildir.
2. Yapılandırma sorunuysa: [ROLLBACK_RUNBOOK.md — senaryo 4](./ROLLBACK_RUNBOOK.md#senaryo-4--environmentconfig-rollback) ile önceki bilinen-çalışan SMTP değerlerine dönün.
3. Sağlayıcı tarafı sorunuysa: 🔧 SMTP sağlayıcısının durum sayfasını kontrol edin (sağlayıcı bu belgenin kapsamında değil).
4. ⚠️ `sendMail()` production'da SMTP yapılandırılmamışsa zaten hata fırlatır (fail-closed, sessizce yutmaz) — bu nedenle "e-posta gitmiyor ama hata da yok" durumu **beklenmez**; hata görünmüyorsa loglama/görünürlük katmanını kontrol edin.
5. Not: `forgotPasswordAction` SMTP hatasını **sessizce yutar** (anti-enumeration tasarımı, `docs/PRODUCTION_READINESS.md` §11.4) — yani şifre sıfırlama akışında kullanıcıya hata gösterilmez, bu olay türü için asıl sinyal kullanıcı şikayeti + `email.delivery_failed` logu olacaktır, kullanıcı arayüzü değil.
6. 🔧 Eskalasyon: 🔧.

## Export hatası

**Belirti**: Excel/PDF export route'larında (`app/api/exports/*`) hata oranı artışı veya sürelerde uzama.

**İlk müdahale**:
1. `export.unexpected_error` log satırlarını (`{name, message}`) inceleyin.
2. Belirli bir organizasyon/proje için mi (büyük veri seti → memory/latency baskısı) yoksa genel mi olduğunu belirleyin — bkz. [MONITORING_RUNBOOK.md — export hata ve süreleri](./MONITORING_RUNBOOK.md#9-export-hata-ve-süreleri).
3. Genel bir kod regresyonuysa [ROLLBACK_RUNBOOK.md — senaryo 7](./ROLLBACK_RUNBOOK.md#senaryo-7--export-veya-smtp-gibi-bağımlı-özelliklerin-rollbacki) uygulayın.
4. Belirli bir büyük veri setinden kaynaklanan memory baskısıysa, kısa vadede o organizasyona ait export'u geçici olarak (🔧 operatör kararıyla, kod değişikliği gerektirmeden) kısıtlamak bir seçenek olabilir; kalıcı çözüm (ör. sayfalama/streaming) bu görevin kapsamı dışındadır.
5. 🔧 Eskalasyon: 🔧.

## Disk dolması

**Belirti**: DB veya uygulama sunucusunda disk kullanımı kritik eşiğe ulaştı (bkz. [MONITORING_RUNBOOK.md — database disk ve büyüme](./MONITORING_RUNBOOK.md#5-database-disk-ve-büyüme)).

**İlk müdahale**:
1. Disk kullanımının DB verisi mi (`FinancialTransaction`/`AccountMovement`/`AuditLog` append-only büyüme), yoksa başka bir şey mi (log dosyaları, eski backup dosyaları) olduğunu belirleyin.
2. ⚠️ **Finansal/audit kayıtlarını disk açmak için silmeyin** — bu, "finansal kayıtlar hard delete edilmez" ilkesini ihlal eder ve mevzuata aykırı olabilir.
3. Güvenle temizlenebilecek adaylar: eski/doğrulanmış backup dosyalarının yerel kopyaları (off-site'a taşındıktan sonra), eski log dosyaları (retention politikasına göre 🔧).
4. Kısa vadede disk genişletme (🔧 operatörün altyapı sağlayıcısına özgü) en hızlı çözümdür.
5. 🔧 Eskalasyon: 🔧.

## Backup başarısızlığı

**Belirti**: Planlı backup alınamadı veya alınan backup doğrulamadan (checksum/yapısal kontrol) geçemedi (bkz. [MONITORING_RUNBOOK.md — backup başarısı ve backup yaşı](./MONITORING_RUNBOOK.md#13-backup-başarısı-ve-backup-yaşı)).

**İlk müdahale**:
1. Hata mesajını/nedenini belirleyin (disk alanı, DB erişim izni, ağ, script hatası — ❌ otomatik backup repoda olmadığından bu genelde manuel prosedürün atlanması/başarısız olması anlamına gelir).
2. **Derhal manuel bir backup denemesi** yapın — bkz. [BACKUP_RESTORE_RUNBOOK.md — manuel mantıksal yedek alma](./BACKUP_RESTORE_RUNBOOK.md#manuel-mantıksal-yedek-alma).
3. Manuel deneme de başarısız oluyorsa, sorun DB erişimi/disk/ağ seviyesinde olabilir — [Database outage](#database-outage) veya [Disk dolması](#disk-dolması) akışlarına bakın.
4. Ardışık backup başarısızlığı, bu süre zarfında bir restore ihtiyacı doğarsa **veri kaybı penceresinin büyüdüğü** anlamına gelir — bu risk açıkça not edilmeli ve backup mekanizması onarılana kadar artan sıklıkla (🔧 operatör kararıyla) manuel backup denenmelidir.
5. 🔧 Eskalasyon: 🔧.

## Güvenlik açığı bildirimi

**Belirti**: Bir bağımlılıkta (`npm audit`) veya uygulama kodunda bir güvenlik açığı bildirildi/tespit edildi.

**İlk müdahale**:
1. Açığın ciddiyetini belirleyin: `npm audit`/`npm audit --omit=dev` çıktısındaki severity (critical/high/moderate/low) veya bildirilen açığın (ör. sorumlu ifşa yoluyla gelen bir rapor) etki alanı.
2. Kritik/high ve **istismar edilebilir** (production'da fiilen kullanılan bir kod yolunda) ise: [ROLLBACK_RUNBOOK.md — senaryo 5: dependency rollback](./ROLLBACK_RUNBOOK.md#senaryo-5--dependency-veya-image-rollback) veya bir düzeltme sürümüne yükseltme değerlendirilir — geçmişte bu repo'da `exceljs`'in transitive `uuid` bağımlılığı için tam olarak bu yapılmış (`package.json` `overrides` — `docs/PRODUCTION_READINESS.md` §15).
3. Açık, uygulama kodunda bir mantık hatasıysa (ör. eksik yetkilendirme kontrolü), önce [Olası cross-tenant erişim](#olası-cross-tenant-erişim) veya genel bir yetkilendirme incelemesi tetiklenmeli.
4. Açık aktif olarak istismar ediliyor gibi görünüyorsa (production'da anormal erişim paternleri), etkilenen endpoint'in geçici olarak devre dışı bırakılması değerlendirilir.
5. 🔧 Eskalasyon: 🔧 — dışarıdan (sorumlu ifşa) gelen bir bildirimse, bildiren tarafa yanıt süreci 🔧 operatörün güvenlik politikasına bağlıdır (bu belge bir sorumlu ifşa programı tanımlamaz).

## Olay sonrası

Her olay için (bu belgenin kapsamı dışında ama referans olarak):

- Olayın zaman çizelgesi kayıt altına alınmalı (🔧 hangi sistemde, operatöre bağlı).
- Kök neden belirlendikten sonra [ROLLBACK_RUNBOOK.md](./ROLLBACK_RUNBOOK.md) veya standart bir düzeltme deploy'u ile kalıcı çözüm uygulanmalı.
- [MONITORING_RUNBOOK.md](./MONITORING_RUNBOOK.md) içindeki ilgili sinyal, bu olayı daha erken yakalayabilecek şekilde güncellenmeli mi değerlendirilmeli.
