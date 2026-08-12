# YF-811 — Stripe Customer Portal (Faturalama Portalı) Self-Service

> Bu doküman, kullanıcıların ödeme yöntemi, fatura geçmişi, abonelik iptali
> ve (Stripe Dashboard yapılandırmasının izin verdiği ölçüde) plan
> değişikliğini Stripe'ın KENDİ barındırdığı Faturalama Portalı üzerinden
> yönetmesini sağlayan self-service girişini belgeler. YF-814, bu görevin
> gateway metodunu ve minimal bir "ödeme yöntemini güncelle" CTA'sını
> ÖNCEDEN inşa etmişti — YF-811 o TEK gateway çağrısının ÜZERİNE ikinci bir
> portal mimarisi İCAT ETMEDEN genel self-service giriş noktasını ekler.

## 1. Değişmez mimari sözleşme (YF-808/YF-809/YF-810/YF-814 ile AYNI)

- Stripe yalnızca **ödeme/faturalama sağlayıcısıdır**. Portal'da yapılan
  HİÇBİR işlem (iptal, plan değişikliği, ödeme yöntemi güncelleme) uygulama
  erişimini DOĞRUDAN mutasyona UĞRATMAZ — tek doğruluk kaynağı HÂLÂ YF-810
  webhook/mutabakat boru hattıdır (`server/services/billing/webhook-service.ts`
  `syncSubscriptionFromStripe`).
- Bu görev İKİNCİ bir mutabakat/webhook mimarisi EKLEMEZ. Portal, Stripe
  tarafında `customer.subscription.updated`/`customer.subscription.deleted`
  üretir — bunlar YF-810'un ZATEN dinlediği olay türleridir; ayrı bir kod
  yolu GEREKMEZ.
- İstemciden hiçbir Stripe müşteri kimliği veya dönüş URL'i kabul EDİLMEZ.
  Kimlik daima `actor → organizationId → OrganizationStripeCustomer` zinciri
  üzerinden sunucu tarafında çözülür (bkz. `stripe-customer-service.ts`
  `ensureOrganizationStripeCustomer`).

## 2. Katmanlar ve dosyalar

| Katman | Dosya | Sorumluluk |
|---|---|---|
| Gateway | `lib/billing/stripe-gateway.ts` `createBillingPortalSession` | Tek Stripe API çağrısı (`stripe.billingPortal.sessions.create`) |
| Domain servisi | `server/services/billing/billing-portal-service.ts` | OWNER yetki kontrolü, sunucu tarafı müşteri çözümlemesi, sabit dönüş URL'i, audit log |
| Server action | `app/actions/billing.ts` `openBillingPortalAction` | `requireRole(["OWNER"])` + servis çağrısı + `redirect()` |
| Paylaşılan UI CTA'sı | `components/app/manage-billing-button.tsx` | TEK form/buton bileşeni — hem daima-görünür kart HEM DE dunning banner'ı tarafından kullanılır |
| Daima görünür özet | `components/app/billing-subscription-card.tsx` | Mevcut plan, abonelik durumu, planlanmış iptal, genel "Faturalamayı yönet" CTA'sı |
| Acil kurtarma banner'ı | `components/app/billing-dunning-banner.tsx` (YF-814) | Yalnızca AKTİF bir ödeme sorunu varken görünür — sağlıklı durum artık `billing-subscription-card.tsx`'in görevidir |
| Sayfa | `app/(app)/settings/plan/page.tsx` | Her iki bileşeni de kompoze eder |

**Yeni tablo/migration YOK** — bu görev `OrganizationStripeSubscription` /
`OrganizationStripeCustomer`'ın ZATEN sakladığı verinin ÜZERİNE okur; yeni
bir kalıcı durum GEREKMEDİ.

## 3. Yetkilendirme modeli

`canManageOrganizationSettings(role) === (role === "OWNER")` — YF-808/809/
810/813/814/815 İLE AYNI, tek bir yetki fonksiyonu. Hem server action
(`requireRole(["OWNER"])`) HEM DE servis katmanı
(`canManageOrganizationSettings` + `forbidden()`) bağımsız olarak kontrol
eder — savunma derinliği (defense-in-depth), yalnızca UI görünürlüğüne
GÜVENİLMEZ.

## 4. Dönüş URL'i (open redirect koruması)

`buildPortalReturnUrl()` daima `NEXT_PUBLIC_APP_URL` + `/settings/plan`
üretir — sabit, sunucu tarafında hesaplanan bir değerdir. Fonksiyon
imzasında (`createOrganizationBillingPortalSession(actor: SessionUser)`)
istemciden alınan HİÇBİR parametre YOKTUR; bu nedenle bir open-redirect
sınıfı yapısal olarak İMKANSIZDIR (bkz. `tests/billing-dunning.test.ts`
"dönüş URL'i sunucu tarafında sabittir" testi).

## 5. İptal, yeniden aktifleştirme ve plan değişikliği

Portal'daki HER değişiklik YF-810'un ZATEN var olan yakınsama mantığından
geçer:

```
Portal'da işlem → Stripe olayı (customer.subscription.updated/.deleted)
  → webhook route → syncSubscriptionFromStripe (Stripe'tan YENİDEN ÇEKER)
    → upsertSubscriptionRow (status/cancelAtPeriodEnd/currentPeriodEnd)
    → applyGrant / applyRevoke (yalnızca GERÇEK durum GEÇİŞİNDE)
    → reconcileDunningState (YF-814)
```

- **cancel_at_period_end**: `cancelAtPeriodEnd: true` + mevcut
  `currentPeriodEnd` yazılır; `applyGrant`/`applyRevoke` TETİKLENMEZ (durum
  hâlâ `ACTIVE`) — erişim, dönem sonuna kadar KORUNUR. UI bunu
  `billing-subscription-card.tsx`'te "İptal planlandı: GG.AA.YYYY" olarak
  gösterir.
- **Anında iptal / dönem sonu geldiğinde**: durum `CANCELED`'a döner →
  `ENTITLEMENT_REVOKING_STATUSES` → `applyRevoke` (YF-810'un mevcut "revoke
  güvenlik koruması" İLE AYNI: yalnızca satır HÂLÂ bu aboneliğe işaret
  ediyorsa uygulanır).
- **Yeniden aktifleştirme**: Stripe tarafında abonelik yeniden `ACTIVE`'e
  dönerse `applyGrant` yeniden çalışır — İKİNCİ bir "reactivation" kod yolu
  GEREKMEZ, `syncSubscriptionFromStripe` durumdan-bağımsızdır (idempotent).
- **Kullanıcı webhook'tan ÖNCE döner**: `/settings/plan` sayfası her zaman
  `OrganizationStripeSubscription`'daki (henüz eski olabilecek) satırı
  gösterir — hiçbir iyimser (optimistic) durum İDDİA EDİLMEZ. Kullanıcı
  mevcut `reconcileBillingAction` (YF-810, "Durumu şimdi kontrol et"
  butonu) ile HEMEN mutabakatı manuel tetikleyebilir.

## 6. YF-813 add-on ayrımı

YF-813 ek kullanım paketleri Stripe'ta **tek seferlik (one-time) Checkout**
ile satın alınır — bir abonelik kalemi DEĞİLDİR ve Stripe Customer Portal
abonelik listesinde GÖRÜNMEZ. Bu görev Portal Configuration'da
`subscription_update`'i YALNIZCA kanonik abonelik Price ID'lerine
(`lib/billing/stripe-config.ts` `STRIPE_PRICE_*`) kısıtlamayı önerir (bkz.
§8) — add-on Price ID'leri o listede HİÇ YER ALMAZ, bu yüzden Portal'ın
kendisi yapısal olarak add-on grantlarını asla mutasyona uğratamaz.

## 7. YF-815 uyuşmazlık (dispute) etkileşimi

Portal açılması/kullanılması `hasActiveDisputeRestriction` kısıtlamasını
TEK BAŞINA temizlemez — bu kısıtlama YALNIZCA YF-815'in kendi webhook/
mutabakat akışı (uyuşmazlığın Stripe tarafında `lost` DIŞINDA bir sonuca
ulaşması) ile kapanır. `tests/billing-dunning.test.ts` "LOST uyuşmazlık
kısıtlaması AKTİFKEN portal AÇILABİLİR" testi bunu doğrular.

## 8. Stripe Dashboard yapılandırma gereksinimleri (uygulama kodu DIŞINDA)

`createBillingPortalSession` bir `configuration` kimliği GEÇMEZ — hesabın
**varsayılan** Faturalama Portalı yapılandırması kullanılır. Bu, ops/
deployment sorumluluğundadır (kod DEĞİL) ve HER Stripe ortamında (test/
live, `lib/billing/stripe-config.ts` `StripeEnvironment` ile AYNI ayrım)
ayrı ayrı yapılmalıdır:

**Stripe Dashboard → Settings → Billing → Customer portal** (veya test
modunda `https://dashboard.stripe.com/test/settings/billing/portal`):

1. **Customer information**: yalnızca e-posta/adres güncellemeye izin
   verin — vergi kimliği gibi alanlar YapiFin'in KENDİ organizasyon
   ayarlarında yönetilir, Portal'da İKİNCİ bir kaynak OLUŞTURULMAZ.
2. **Payment methods**: "Allow customers to update their payment methods"
   AÇIK.
3. **Invoices**: "Allow customers to view their invoice history" AÇIK.
4. **Cancellations**: AÇIK; mod olarak **"Cancel at end of billing
   period"** seçin ("Cancel immediately" DEĞİL) — bu, §5'teki
   `cancelAtPeriodEnd` yakınsama davranışıyla UYUMLUDUR ve kullanıcının
   ödediği dönemi kaybetmesini ÖNLER.
5. **Subscriptions (plan değişikliği)**: yalnızca `.env`'deki
   `STRIPE_PRICE_*` değişkenleriyle EŞLEŞEN, kanonik plan/aralık
   kombinasyonlarının Price ID'lerini "Products" listesine ekleyin.
   **Enterprise'ı (CONTACT_SALES) EKLEMEYİN** — o plan kendi-kendine satın
   alınamaz (bkz. `stripe-config.ts` `CONTACT_SALES_SENTINEL`). Add-on
   Price ID'lerini (YF-813) KESİNLİKLE eklemeyin (bkz. §6).
   - Eğer bu liste doğru yapılandırılamıyorsa (ör. henüz tüm Price ID'ler
     Stripe panelinde YOKSA), plan değişikliğini Portal'da GEÇİCİ olarak
     KAPALI bırakmak GÜVENLİDİR — kullanıcılar plan değişikliği için HÂLÂ
     `/settings/plan` üzerindeki mevcut Checkout akışını (YF-809)
     kullanabilir. Bu, "Stripe Price ID'lerine istemciden GÜVENME" ilkesini
     BOZMAZ: her iki yol da webhook'ta `resolvePlanForStripePrice` ile AYNI
     kanonik kataloğa karşı doğrulanır.
6. **Business information**: opsiyonel, marka/logo — hassas veri İÇERMEZ.

Bu adımlar KOD DEĞİLDİR ve bu PR'da uygulanamaz (Stripe kimlik bilgisi bu
ortamda mevcut değil) — bir sonraki "TEST MODE doğrulama" adımı olarak
manuel yapılmalıdır (bkz. §9).

## 9. Manuel Stripe TEST MODE doğrulama adımları

Stripe TEST MODE kimlik bilgileri bu geliştirme ortamında mevcut
DEĞİLDİR; aşağıdaki adımlar bir mühendisin gerçek `sk_test_...` anahtarı
ile YAPMASI gereken doğrulamadır:

1. `.env`'e test modu değerlerini girin: `STRIPE_SECRET_KEY=sk_test_...`,
   `STRIPE_WEBHOOK_SECRET=whsec_...` (bkz. `stripe listen --forward-to
   localhost:3000/api/billing/stripe/webhook`), `STRIPE_PRICE_*` test modu
   Price ID'leri.
2. §8'deki Dashboard yapılandırmasını **test modunda** tamamlayın.
3. Bir test organizasyonu oluşturun, YF-809 Checkout ile bir test kartıyla
   (`4242 4242 4242 4242`) bir plana abone olun; webhook'un
   `Organization.planId`'yi grantladığını doğrulayın.
4. `/settings/plan` sayfasını açın → `billing-subscription-card.tsx`
   kartının plan adı + "Aktif" rozetini gösterdiğini doğrulayın.
5. "Faturalamayı yönet" butonuna tıklayın → Stripe'ın barındırmalı
   Portalına yönlendirildiğinizi doğrulayın (URL `billing.stripe.com`
   içerir).
6. Portal'da ödeme yöntemini başka bir test kartıyla güncelleyin → geri
   dönün → `/settings/plan`'ın DEĞİŞMEDİĞİNİ (iyimser bir durum
   GÖSTERMEDİĞİNİ) doğrulayın, ardından "Durumu şimdi kontrol et"
   (`reconcileBillingAction`) ile mutabakatı tetikleyin.
7. Portal'da "Cancel at end of billing period" seçeneğiyle iptal edin →
   webhook'un (veya manuel mutabakatın) `cancelAtPeriodEnd: true`
   yazdığını ve kartın "İptal planlandı: GG.AA.YYYY" mesajını
   gösterdiğini doğrulayın → erişimin HÂLÂ TAM olduğunu doğrulayın (yeni
   proje/davet oluşturarak).
8. Stripe CLI ile `stripe trigger customer.subscription.deleted` (veya
   dönem sonuna kadar bekleyip gerçek olayı) tetikleyin → planın
   REVOKE edildiğini, `hasActiveBillingRestriction`'ın artık `true`
   döndüğünü doğrulayın.
9. Test kartını `4000 0000 0000 0341` (başarısız ödeme) ile değiştirip bir
   sonraki fatura denemesini başarısız kılın → dunning banner'ının
   (YF-814) göründüğünü, Portal'ın grace period SIRASINDA HÂLÂ erişilebilir
   olduğunu (§9.5 ile AYNI adım) doğrulayın.
10. Tüm adımlar boyunca `db.financialTransaction.count()` ve
    `db.settlement.count()`'un SIFIR kaldığını doğrulayın (bkz.
    `tests/billing-dunning.test.ts` "finansal sınır" testleri — bu manuel
    adım, o testin canlı Stripe karşılığıdır).

## 10. Finansal sınır kanıtı

Bu görev kapsamındaki HİÇBİR kod yolu `db.financialTransaction`,
`db.settlement` veya proje bütçe/nakit-akışı tablolarına YAZMAZ —
`createOrganizationBillingPortalSession` yalnızca TEK bir Stripe API
çağrısı + TEK bir `AuditLog` satırı yazar; Portal dönüşü sonrası
mutabakat da (YF-810/814/815) AYNI ilkeyi zaten kanıtlanmış biçimde takip
eder (bkz. `tests/billing-dunning.test.ts` "finansal sınır" describe
bloğu).
