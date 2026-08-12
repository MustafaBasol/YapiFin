# YF-821 — Dunning Ödeme Bildirimleri ve Faturalama Kurtarma E-posta Akışı

> Bu doküman, YF-814 (dunning/grace period durum makinesi) üzerine inşa
> edilen müşteri e-posta bildirimlerini belgeler. YF-811 (Customer Portal
> CTA) ve YF-815 (dispute kompozisyonu) ile AYNI kompozisyon/erişim
> disiplinini kullanır; YENİ bir e-posta platformu, zamanlayıcı veya
> çoklu-dil altyapısı İCAT EDİLMEZ.

## 1. Değişmez mimari sözleşme

- `lib/email/mailer.ts` mevcut SMTP altyapısı AYNEN yeniden kullanılır — yeni
  bir kuyruk/queue/retry platformu İNŞA EDİLMEZ.
- Uygulama YALNIZCA Türkçe'dir (proje `CLAUDE.md`) — bu görevde çoklu-dil
  altyapısı İCAT EDİLMEDİ; e-posta içerikleri `sendVerificationEmail`/
  `sendInvitationEmail` İLE AYNI desende (düz metin + basit HTML, TEK dil).
- Bu kod tabanında (proje geneli tarandı) HİÇBİR gömülü zamanlayıcı/kuyruk
  YOKTUR — mevcut mutabakat (`reconcilePendingOrganizationRefunds`,
  `reconcileOpenOrganizationDisputes`) BİLİNÇLİ OLARAK OWNER-tetiklemeli el
  ile çalışır ("yeni bir cron İCAT EDİLMEZ" notu, YF-815). Grace-yaklaşıyor
  hatırlatması ve "webhook hiç gelmeden grace süresi doldu" durumu TANIM
  GEREĞİ zamana bağlıdır — bu YÜZDEN (ve SADECE bu ikisi için) ince, harici
  bir zamanlayıcı tarafından tetiklenen bir sweep uç noktası eklendi (bkz.
  §5). Bu, mevcut "cron İCAT ETME" ilkesini ÇİĞNEMEZ: hiçbir süreç bu
  uygulamanın İÇİNDE başlatılmaz, yalnızca dışarıdan periyodik olarak
  ÇAĞRILMASI beklenen tek bir uç nokta sağlanır.
- `Organization.planId`/entitlement kararlarına YENİ bir mutasyon noktası
  EKLENMEZ — bu görev SALT bildirim/e-posta katmanıdır.

## 2. Katmanlar ve dosyalar

| Katman | Dosya | Sorumluluk |
|---|---|---|
| Şema/defter | `prisma/schema.prisma` `BillingNotification` | Kalıcı idempotency defteri — `@@unique([organizationId, type, episodeKey])` |
| Politika | `lib/billing/notification-policy.ts` | Hatırlatma penceresi sabiti (`GRACE_REMINDER_HOURS_BEFORE_EXPIRY`), `isWithinGraceReminderWindow`, alıcı çözümlemesi (`resolveBillingNotificationRecipients`), sweep sırrı çözümü |
| E-posta içeriği | `lib/email/billing-notification-mailer.ts` | 4 bildirim türü için Türkçe şablonlar; `sendMail` ÜZERİNE ince bir katman |
| Orkestrasyon | `server/services/billing/billing-notification-service.ts` | `scheduleBillingNotification` (transactional, idempotent PLANLAMA), `dispatchPendingBillingNotifications` (commit SONRASI gönderim + durum makinesi) |
| Webhook entegrasyonu | `server/services/billing/webhook-service.ts` `reconcileDunningState`/`syncSubscriptionFromStripe` | GERÇEK durum geçişlerinde PLANLAMA (transactional) + commit sonrası en-iyi-çaba gönderim |
| Zaman-bazlı sweep | `server/services/billing/billing-notification-sweep-service.ts` | Grace-yaklaşıyor hatırlatması + webhooksuz grace-doldu tespiti + `FAILED` yeniden deneme |
| Harici tetikleyici | `app/api/internal/billing/dunning-sweep/route.ts` | Paylaşımlı sırla korunan, harici zamanlayıcının çağırdığı ince POST uç noktası |
| Ortam | `lib/env.ts` `BILLING_SWEEP_SECRET` | Fail-closed, opsiyonel (yalnızca route çağrıldığında değerlendirilir) |

**Yeni tablo:** `BillingNotification` — mevcut `AuditLog`, bir teslimat durumu
makinesinin (SCHEDULED→SENT/FAILED, yeniden deneme sayısı) taşıyacağı
semantiği VERMEZ; bu yüzden AuditLog'u bir teslimat defteri olarak KULLANMAK
YERİNE minimum, amaca özel yeni bir tablo eklendi (görev talimatı "Do not
abuse AuditLog as an unreliable email-delivery ledger"). İlgili
`billing.notification.sent`/`billing.notification.failed` AuditLog kayıtları
HÂLÂ yazılır — ikisi TAMAMLAYICIDIR, biri diğerinin YERİNE geçmez.

## 3. Bildirim türleri ve tetikleyicileri

| Tür | Tetikleyici | Ne zaman |
|---|---|---|
| `PAYMENT_FAILED_GRACE_STARTED` | Webhook (`reconcileDunningState`) | Yeni bir dunning bölümü açıldığında (GERÇEK geçiş, idempotent no-op DEĞİL) |
| `GRACE_EXPIRING_REMINDER` | Sweep (zaman-bazlı) | `gracePeriodEndsAt`e `GRACE_REMINDER_HOURS_BEFORE_EXPIRY` (varsayılan **48 saat**) veya daha az kaldığında, HENÜZ dolmamışken |
| `GRACE_EXPIRED_RESTRICTED` | Sweep (zaman-bazlı) | `computePaymentFailureState` `RESTRICTED` döndüğünde — webhook GEREKMEZ |
| `PAYMENT_RECOVERED` | Webhook (`reconcileDunningState`) | Açık bir bölüm kapandığında (GERÇEK geçiş) |

`GRACE_EXPIRING_REMINDER`/`GRACE_EXPIRED_RESTRICTED` BİLİNÇLİ OLARAK yalnızca
sweep'ten planlanır — webhook'ta modellenen bir "durum geçişi" DEĞİLLERDİR
(hiçbir Stripe olayı "grace süresi bitmek üzere" DEMEZ). `PAYMENT_FAILED_GRACE_STARTED`/
`PAYMENT_RECOVERED` İSE `lib/billing/dunning-policy.ts` `openDunningEpisode`/
`clearDunningEpisode`in DÖNDÜRDÜĞÜ boş-olmayan yama İLE BİREBİR aynı anda
planlanır — YF-814'ün ZATEN sahip olduğu idempotent no-op koruması (yeniden
deneme AYNI bölümde grace'i asla uzatmaz) bu bildirimler için de ÜCRETSİZ
miras alınır.

## 4. İdempotency — episode-anahtarlı kalıcı defter

`episodeKey` = dunning bölümünü tanımlayan donmuş `delinquentSince`
(`toISOString()`). `lib/billing/dunning-policy.ts`in KENDİSİ bu alanı bir
bölüm boyunca SABİT tutar (tekrarlanan başarısızlıklar ASLA ileri taşımaz,
kurtarma `null`a döndürür) — bu YÜZDEN kararlı, doğal bir anahtardır.

`@@unique([organizationId, type, episodeKey])` TEK doğruluk kaynağıdır:

- **Webhook tekrarı (replay):** `claimEvent` (YF-810) zaten olay-düzeyinde
  engeller; `reconcileDunningState`in KENDİ idempotent no-op'u (`action`
  `null` kalır) İKİNCİ bir savunma katmanıdır; DB `@@unique` ÜÇÜNCÜ/son
  savunma katmanıdır (P2002 yakalanır, `{isNew: false}` döner, hiçbir hata
  fırlatılmaz).
- **Eşzamanlı webhook işleme:** iki eşzamanlı transaction AYNI satırı
  YAZMAYA çalışırsa, veritabanı YARIŞI çözer — kaybeden P2002 alır.
- **Sweep ile webhook arasındaki yarış:** aynı mekanizma (aynı fonksiyon,
  `scheduleBillingNotification`, HER İKİ çağıran tarafından da kullanılır).
- **Mutabakatın zaten-bildirilmiş durumu keşfetmesi:** gereksiz yeniden
  gönderim YOKTUR — satır zaten `SENT` ise `dispatchPendingBillingNotifications`
  onu sorgusuna DAHİL ETMEZ (yalnızca `SCHEDULED`/`FAILED` okunur).

## 5. Grace-yaklaşıyor zamanlaması — sweep + harici tetikleyici

`GRACE_REMINDER_HOURS_BEFORE_EXPIRY = 48` — `lib/billing/notification-policy.ts`
içinde TEK, açıkça belgelenmiş bir ürün politikası sabiti (YF-814'ün
`GRACE_PERIOD_DURATION_DAYS = 7` İLE AYNI ilke: mevcut bir iş kuralı
bulunmadığından makul bir varsayılan seçildi; değiştirilmesi gerekirse TEK
değişiklik noktası budur).

`sweepBillingNotifications(now)` (`billing-notification-sweep-service.ts`):

1. `delinquentSince IS NOT NULL` olan TÜM `OrganizationStripeSubscription`
   satırlarını tarar (`@@index([gracePeriodEndsAt])` — YF-814'ten beri zaten
   bu desen İÇİN mevcuttu).
2. `GRACE_PERIOD` + hatırlatma penceresi İÇİNDE → `GRACE_EXPIRING_REMINDER`
   PLANLAR.
3. `RESTRICTED` → `GRACE_EXPIRED_RESTRICTED` PLANLAR (webhook OLMADAN grace
   süresinin dolduğu durum BURADA yakalanır).
4. `SCHEDULED` VEYA `FAILED` durumundaki HER organizasyon için
   `dispatchPendingBillingNotifications` çağrılır — bu, webhook'un en-iyi-
   çaba gönderiminin BAŞARISIZ olduğu (geçici SMTP hatası) HER TÜRÜ de
   kapsar; sweep TEK yeniden deneme kaynağıdır.

`app/api/internal/billing/dunning-sweep/route.ts`, bu fonksiyonu tetikleyen
TEK, ince POST uç noktasıdır. Kullanıcı oturumu YOKTUR — harici bir
zamanlayıcının sunması gereken paylaşımlı bir sırla (`BILLING_SWEEP_SECRET`,
`Authorization: Bearer ...`, sabit-zamanlı karşılaştırma) korunur. Sır
tanımlı değilse İSTEK İŞLENMEZ (500, fail-closed — `STRIPE_WEBHOOK_SECRET`
İLE AYNI felsefe).

**İşletimsel gereksinim:** üretim dağıtımında bu uç noktayı periyodik (önerilen:
saatlik) çağıracak harici bir mekanizma (işletim sistemi cron'u, barındırma
platformunun kendi zamanlayıcısı — Vercel Cron, GitHub Actions scheduled
workflow, vb.) YAPILANDIRILMALIDIR; bu doküman ve `.env.example` bunu açıkça
işaretler. Barındırma platformu bu görevin kapsamında SEÇİLMEDİ (proje henüz
platformdan bağımsız) — bu YÜZDEN platforma özgü bir cron yapılandırması
(ör. `vercel.json` crons) İCAT EDİLMEDİ, taşınabilir bir HTTP+sır sözleşmesi
tercih edildi.

## 6. Gönderim modeli — planlama (transactional) vs. gönderim (transaction dışı)

`scheduleBillingNotification` YALNIZCA çağıranın (webhook veya sweep) KENDİ
transaction'ı içinde satırı YAZAR — hiçbir SMTP G/Ç'si YAPMAZ (bir DB
transaction'ının içinde ağ çağrısı tutmak, mevcut kod tabanının hiçbir
yerinde YAPILMAYAN bir anti-desendir). Gerçek gönderim
`dispatchPendingBillingNotifications` ile commit SONRASI yapılır:

- Webhook yolu: `syncSubscriptionFromStripe`, transaction commit olduktan
  SONRA en-iyi-çaba (best-effort) bir gerçek-zamanlı gönderim DENER; buradaki
  HERHANGİ bir hata YUTULUR ve loglanır — webhook'un kendi başarı/başarısızlık
  durumunu (`claimEvent`/`markEventOutcome`) ETKİLEMEZ.
- Sweep yolu: periyodik, kalıcı yeniden deneme kaynağı (bkz. §5).

İkisi de AYNI `dispatchPendingBillingNotifications` fonksiyonunu çağırır —
yeniden deneme mantığı TEK bir yerde yaşar.

## 7. Teslimat durumu ayrımı

`BillingNotificationStatus`: `SCHEDULED` → `SENT` VEYA `FAILED`.
`lib/email/mailer.ts` `sendMail` başarıyla DÖNDÜĞÜNDE (nodemailer'ın kendi
SMTP kabul onayı) `SENT` yazılır — "planlandı" ile "gerçekten teslim edildi"
KARIŞTIRILMAZ. Hata durumunda `lib/email/errors.ts` `classifyMailError` İLE
sınıflandırılmış, güvenli bir kategori `lastError`a yazılır (ham SMTP yanıtı/
alıcı adresi/mesaj gövdesi ASLA — `logMailFailure` İLE AYNI disiplin);
`attemptCount` artırılır. Geçici bir SMTP hatası ASLA "kalıcı teslim edildi"
OLARAK yanlış işaretlenmez — satır `FAILED` kalır ve bir SONRAKİ webhook/sweep
turunda yeniden denenir (bkz. §6).

## 8. Alıcı çözümlemesi

`resolveBillingNotificationRecipients` — SUNUCU tarafında, organizasyondan
çözülür (istemciden hiçbir e-posta adresi ASLA kabul edilmez). Politika:
yalnızca **AKTİF OWNER** rolündeki kullanıcılar. Bu, mevcut mimarinin TÜM
faturalama mutasyonları (`lib/permissions.ts` `canManageOrganizationSettings`
— Customer Portal oturumu açma, abonelik/faturalama mutabakatı) için ZATEN
kullandığı yetki sınırıyla BİREBİR aynı hizadadır; ayrı bir "faturalama
yetkilisi" ADMIN rolü İCAT EDİLMEDİ (mevcut mimari bunu DESTEKLEMİYOR). Aynı
adres büyük/küçük harf duyarsız TEKİLLEŞTİRİLİR.

## 9. Customer Portal CTA (YF-811 yeniden kullanımı)

E-postalardaki CTA her zaman YapiFin'in KENDİ kimlik doğrulamalı faturalama
sayfasına (`/settings/plan`) yönlendirir — bu sayfa (`ManageBillingButton`/
`UpdatePaymentMethodButton`, YF-811) HER ziyarette TAZE bir Stripe Customer
Portal oturumu oluşturur (`createOrganizationBillingPortalSession`). Kısa
ömürlü bir Stripe Portal URL'i veya HERHANGİ bir Stripe iç kimliği (abonelik/
fatura/müşteri ID'si, ham durum dizesi) DOĞRUDAN e-posta içeriğine ASLA
GÖMÜLMEZ — ikinci bir Portal mimarisi İCAT EDİLMEDİ.

## 10. Dunning + dispute kompozisyonu (YF-815)

`PAYMENT_RECOVERED` e-postası, `lib/billing/billing-restriction-policy.ts`in
KENDİ kompozisyon ilkesini (dunning ve dispute BAĞIMSIZ sinyallerdir, biri
diğerini ZAYIFLATMAZ) YANSITIR: gönderim ANINDA `hasActiveDisputeRestriction`
CANLI okunur (planlama anında DONDURULMAZ — bkz. §11 "neden bazı alanlar
CANLI okunur" notu). Çözülmemiş bir dispute VARSA, e-posta erişimin TAMAMEN
normale döndüğünü ASLA İDDİA ETMEZ; bunun yerine hesabın hâlâ kısmen kısıtlı
olduğunu AÇIKÇA belirtir.

## 11. Neden bazı alanlar dondurulur, bazıları CANLI okunur

`BillingNotification.gracePeriodEndsAt` PLANLAMA anında DONDURULUR (bir
e-posta "son tarih X" dediğinde, bu TARİHSEL bir OLGUDUR — gönderim
tekrar denendiğinde bölüm ARADA kurtarılıp canlı `gracePeriodEndsAt` `null`a
dönmüş OLSA BİLE içerik DOĞRU kalmalıdır). Buna KARŞIN dispute-kompozisyon
metni (§10) BİLİNÇLİ OLARAK CANLI okunur — çünkü "hesabınız hâlâ kısıtlı mı"
bir KARARDIR, `lib/billing/billing-restriction-policy.ts`in "hiçbir erişim
kararı önbelleğe alınmaz" ilkesiyle AYNI disiplin bir bildirim içeriği için
de geçerlidir.

## 12. Finansal sınır

Bildirim yaşam döngüsünün (planlama → gönderim → durum güncellemesi) HİÇBİR
adımı `FinancialTransaction`/`Settlement`/`AccountMovement`/`AccountTransfer`/
proje bütçe kaydı OLUŞTURMAZ — YF-814 §7 İLE AYNI sınır, testlerle
KANITLANMIŞTIR (`tests/billing-notification.test.ts` "finansal sınır").

## 13. Denetlenebilirlik

`BillingNotification` satırının kendisi (tür, episode anahtarı, durum,
zaman damgaları, `triggeredByEventId`) BİR operatörün "hangi olay tetikledi /
hangi bölüm / hangi tür / gönderim durumu" sorularını YANITLAMASI için
yeterlidir. Tamamlayıcı olarak `billing.notification.sent`/
`billing.notification.failed` AuditLog kayıtları da yazılır — hiçbir sır, ham
Stripe payload'ı veya gereksiz PII (yalnızca sınıflandırılmış hata kategorisi
ve alıcı SAYISI, tek tek adresler DEĞİL) İÇERMEZ.
