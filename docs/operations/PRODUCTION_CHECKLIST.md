# Production Checklist — Deploy Sonrası Smoke Test

**Bağlı belgeler**: [README.md](./README.md) · [DEPLOYMENT_RUNBOOK.md](./DEPLOYMENT_RUNBOOK.md) · [MONITORING_RUNBOOK.md](./MONITORING_RUNBOOK.md)

Bu liste, [DEPLOYMENT_RUNBOOK.md](./DEPLOYMENT_RUNBOOK.md) adım 9'da referans edilen **non-destructive** smoke test kontrolleridir. Hiçbir kontrol production finansal verisini oluşturmaz, değiştirmez veya silmez — yalnızca okuma/görüntüleme ve kontrollü bir test hesabıyla kimlik doğrulama içerir.

⚠️ Cross-tenant erişim testi **yalnızca kontrollü staging/test ortamında** yapılır, production'da asla denenmez (aşağıya bakın).

## Ön koşul

🔧 Bu listeyi uygulamak için bir **test/demo organizasyonu ve test kullanıcı hesabı** gereklidir — gerçek müşteri organizasyonu/verisi kullanılmamalıdır. Bu belge test hesabı kimlik bilgisi üretmez/varsaymaz; operatör kendi test tenant'ını önceden hazırlamalıdır.

## Kontrol listesi

- [ ] **Ana sayfa/login erişimi**: `GET /login` → `200 OK`, login formu render ediliyor.
- [ ] **Yetkisiz endpoint davranışı**: Oturum çerezi olmadan korumalı bir sayfaya (ör. dashboard) veya `app/api/exports/*` route'larından birine istek atıldığında beklenen davranış gerçekleşiyor — export route'ları `getSessionUser()` ile 401 döner (`server/exports/*` route handler'ları), sayfa route'ları login'e yönlendirir. Beklenmeyen bir `200`/veri sızıntısı görülürse **derhal** [INCIDENT_RESPONSE_RUNBOOK.md — olası cross-tenant erişim](./INCIDENT_RESPONSE_RUNBOOK.md#olası-cross-tenant-erişim) akışına geçin (yetkisiz erişim, tenant izolasyonuyla aynı ciddiyette ele alınır).
- [ ] **Test tenant ile giriş**: Test hesabıyla login → başarılı, dashboard'a yönlendiriliyor.
- [ ] **Proje listeleme**: Test organizasyonunun proje listesi doğru görüntüleniyor; listelenen projelerin `organizationId`'sinin test organizasyonuyla eşleştiği (başka bir organizasyonun projesi görünmüyor) doğrulanıyor.
- [ ] **Gelir/gider read-only kontrolü**: Bir projenin finansal işlem listesi (gelir/gider) görüntüleniyor; **hiçbir yeni kayıt oluşturulmuyor/değiştirilmiyor**.
- [ ] **Dashboard**: Ana dashboard sayfası hatasız yükleniyor, grafikler/özet kartlar render ediliyor.
- [ ] **Excel/PDF export**: `app/api/exports/*` route'larından en az biri (ör. dashboard export) tetikleniyor, dönen dosya açılabiliyor (bozuk değil), `Content-Disposition` ile doğru dosya adı geliyor. Yanıt başlıklarında `Cache-Control: private, no-store` olduğu doğrulanıyor (export dosyası önbelleğe alınmamalı).
- [ ] **SMTP testi**: Güvenli bir **test e-posta hesabıyla** (gerçek müşteri e-postası değil) bir e-posta tetikleyen akış (ör. davet gönderimi veya doğrulama e-postası yeniden gönderimi) çalıştırılıyor; e-postanın test kutusuna ulaştığı doğrulanıyor. ⚠️ Gerçek kullanıcıların e-posta kutusuna test amaçlı e-posta göndermeyin.
- [ ] **Cross-tenant testinin yalnızca kontrollü staging/test ortamında yapılması**: İki ayrı test organizasyonu ve kullanıcısıyla, birinin diğerinin verisine (proje/işlem/kullanıcı listesi) erişemediği doğrulanır. ⚠️ **Bu test production'da hiçbir zaman gerçek organizasyon verisiyle yapılmaz** — yalnızca staging/test ortamında, birbirinden izole iki test organizasyonuyla yapılır.
- [ ] **Health/readiness**: [DEPLOYMENT_RUNBOOK.md — health/readiness doğrulaması](./DEPLOYMENT_RUNBOOK.md#healthreadiness-doğrulaması) adımındaki manuel `curl` kontrolü (❌ otomatik `/api/health` endpoint'i henüz yok) tekrar çalıştırılır.
- [ ] **Loglarda secret/PII bulunmadığının örnek kontrolü**: Deploy sonrası üretilen son birkaç dakikalık log çıktısı gözden geçirilir; aşağıdakilerden **hiçbiri** ham haliyle görünmemeli:
  - Ham e-posta adresi (yalnızca `recipientHash` gibi hash'lenmiş hali görünmeli — `lib/email/mailer.ts`)
  - Parola (hash'li dahi olsa `passwordHash` log'a yazılmamalı)
  - Oturum token'ı (ham token veya `tokenHash`)
  - `AUTH_SECRET`, `DATABASE_URL`, `SMTP_PASSWORD` değerleri
  - Finansal işlem tutarları/detayları (hata logları yalnızca `{name, message}` gibi genel bilgi içermeli — `server/exports/http.ts`'deki `errorToResponse()` paterni)

## Değiştirilmeyecek/yapılmayacak testler

Bu görev talimatı gereği, aşağıdaki testler **bu listeye dahil edilmemiştir** çünkü production finansal verisini değiştirir:

- Yeni bir tahsilat/ödeme/transfer oluşturma testi
- Bir işlemi iptal etme testi
- Bir kullanıcı davet etme/rol değiştirme testi (gerçek organizasyon üzerinde)

Bu tür testler yalnızca staging/test ortamında, gerçek entegrasyon test paketi (`npm run test`, `npm run test:report-export-integration`) üzerinden yapılmalıdır — bu checklist'in kapsamı değildir.

## Deploy onay kaydı

Yukarıdaki tüm kontroller geçtiğinde, [DEPLOYMENT_RUNBOOK.md — başarılı deploy kanıt kaydı](./DEPLOYMENT_RUNBOOK.md#başarılı-deploy-kanıt-kaydı) tablosuna bu checklist'in sonucu (hepsi geçti / hangi madde başarısız oldu) eklenmelidir.
