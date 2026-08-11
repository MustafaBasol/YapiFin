# YF-813 — Stripe add-on, AI/OCR kredi ve usage billing entegrasyonu

Bu doküman, YF-803 (kullanım/kota + add-on mimarisi) ve YF-810 (Stripe
abonelik yaşam döngüsü + webhook senkronizasyonu) üzerine eklenen **Stripe
üzerinden tek seferlik kullanım/ek-kota (add-on/top-up) satın alma**
akışını belgeler.

## 1. Değişmez mimari sözleşme (YF-808/YF-809/YF-810 ile AYNI)

> Stripe yalnızca **ödeme sağlayıcısıdır**. Bağışlanacak kota miktarı/kaynağı
> HER ZAMAN YapiFin'in kendi kataloğundan (`lib/billing/addon-catalog.ts`)
> gelir — Stripe'ın Price/Product/metadata'sı hiçbir çalışma zamanı bağış
> kararında TEK BAŞINA okunmaz. Kullanım/kota doğruluğunun TEK kaynağı
> `lib/entitlements/entitlement-service.ts` + `UsageAddonGrant` olmaya devam
> eder (YF-803 DEĞİŞMEDİ).

Bir Checkout Session **oluşturmak** hiçbir kota KAZANDIRMAZ. Tarayıcının
Checkout'tan başarılı dönmesi (`success_url`) dahi kota mutasyonu
TETİKLEMEZ — gerçek bağış her zaman webhook onayını (veya onun manuel
mutabakat karşılığını) bekler.

## 2. Yeniden kullanılan mevcut mimari (İCAT EDİLMEYENLER)

- **İkinci bir webhook uç noktası** — `app/api/billing/stripe/webhook/route.ts`
  (YF-810) AYNEN kullanılır; add-on onayı bu route'un çağırdığı
  `processStripeWebhookEvent`'in İÇİNDE, aynı imza doğrulama/idempotency
  zarfı altında işlenir.
- **İkinci bir Stripe müşteri eşlemesi** — `OrganizationStripeCustomer`
  (YF-808) AYNEN kullanılır (`ensureOrganizationStripeCustomer`).
- **İkinci bir kullanım defteri (ledger)** — yok; `UsageAddonGrant` bir ARZ
  (supply) kaydıdır, tüketim AI/OCR'ın KENDİ ledger'larında kalır (YF-803
  ile AYNI).
- **İkinci bir entitlement sistemi** — yok; `resolveEffectiveLimitMax`
  (`included + addon`) DEĞİŞMEDİ, add-on tarafı yalnızca yeni bir
  `UsageAddonGrant` SATIRI ekler.
- **İkinci bir add-on grant tablosu** — yok; `grantUsageAddon` (YF-803)
  AYNEN çağrılır.
- **Paralel AI/OCR kota mantığı** — yok; AI/OCR servisleri hâlâ yalnızca
  `checkLimit`/`assertWithinLimitAtomic` çağırır, Stripe'ı hiç BİLMEZ.

## 3. Yeni parçalar

| Katman | Dosya | Sorumluluk |
|---|---|---|
| Katalog | `lib/billing/addon-catalog.ts` | `addonKey` → `resource`(`LimitId`)/`amount`/Stripe Price ID çözümlemesi (iki yönlü) |
| Ortam | `lib/env.ts` | `STRIPE_PRICE_ADDON_AI_CREDITS`, `STRIPE_PRICE_ADDON_OCR_DOCS` biçim doğrulaması |
| Sağlayıcı sınırı | `lib/billing/stripe-gateway.ts` | `createAddonCheckoutSession()` (mode: `payment`), `retrieveCheckoutSessionForAddon()`, `checkout.session.async_payment_succeeded` olay projeksiyonu |
| Checkout servisi | `server/services/billing/addon-checkout-service.ts` | `createAddonCheckoutSession(actor, {addonKey})` — yetki, katalog çözümleme, idempotent Session oluşturma |
| Onay/bağış servisi | `server/services/billing/addon-grant-service.ts` | `confirmAddonCheckoutSession()` (webhook + mutabakat ORTAK çekirdeği), `reconcileAddonPurchase()`, `getAddonPurchaseStatus()` |
| Webhook entegrasyonu | `server/services/billing/webhook-service.ts` | `CHECKOUT_SESSION` dalı, `subscriptionId` YOKSA add-on onay yoluna yönlendirir |
| Doğrulama | `lib/validation/billing.ts` | `purchaseAddonSchema` (yalnızca `addonKey`), `reconcileAddonPurchaseSchema` |
| Server action | `app/actions/billing.ts` | `purchaseAddonAction`, `reconcileAddonPurchaseAction` |
| UI | `app/(app)/settings/plan/addons/**`, `components/app/addon-purchase-view.tsx`, `components/app/reconcile-addon-button.tsx` | Satın alma kartları, success/cancel/pending durumları |

**Şema/migration değişikliği YOKTUR** — `UsageAddonGrant`, `StripeWebhookEvent`,
`OrganizationStripeCustomer` mevcut haliyle yeterlidir.

## 4. Add-on kataloğu ve girdi güveni

İstemciden **yalnızca** `addonKey` kabul edilir (YF-809 §3 ile AYNI ilke).
Aşağıdakilerin HİÇBİRİ istemciden alınmaz: Stripe Price ID, tutar/para
birimi, bağış miktarı, `resource`, `organizationId`, geçerlilik penceresi —
tamamı `lib/billing/addon-catalog.ts`'ten (yalnızca `addonKey` anahtarıyla)
sunucu tarafında çözümlenir.

Bugün iki paket tanımlıdır (bkz. dosya başı yorumu — büyüklükler PROFESSIONAL
planının aylık dahil kotasının yarısı, `lib/entitlements/plan-defaults.ts`
DEFAULT_PLANS ile AYNI gerekçeyle GEÇİCİ/seed değerlerdir, gerçek ticari
paket boyutu/fiyatı docs/product/YF-807-plan-unit-economics.md §8'in
"top-up ekonomisi ÇÖZÜLMEMİŞTİR" notuyla AYNI, ayrı bir fiyatlandırma
kararıdır):

| `addonKey` | `resource` | `amount` | Ortam değişkeni |
|---|---|---|---|
| `ai_credits_pack` | `ai.monthly_quota` | 250 | `STRIPE_PRICE_ADDON_AI_CREDITS` |
| `ocr_documents_pack` | `ocr.monthly_quota` | 25 | `STRIPE_PRICE_ADDON_OCR_DOCS` |

Genişletme (SMS/WhatsApp/e-belge top-up, YF-803 §"Genişleme noktası" ile
AYNI): `ADDON_CATALOG`'a yeni bir girdi + ilgili `STRIPE_PRICE_ADDON_*`
ortam değişkeni — `UsageAddonGrant` şemasına DOKUNULMAZ.

## 5. Checkout tasarımı (tek seferlik `payment` modu)

`createAddonCheckoutSession` (OWNER-only, `canManageOrganizationSettings`):

1. `resolveAddonPrice(addonKey)` — fail-closed (bilinmeyen anahtar veya
   yapılandırılmamış fiyat → `BillingConfigError`).
2. `ensureOrganizationStripeCustomer(actor)` — mevcut müşteri yeniden
   kullanılır (YF-808).
3. `gateway.createAddonCheckoutSession()` — `mode: "payment"`, TEK satır
   kalemi (`price` + `quantity: 1`), korelasyon metadata'sı
   (`yapifin_addon_key`, `yapifin_organization_id`, `yapifin_stripe_environment`)
   hem Session hem de Payment Intent'e yazılır.
4. Sabit sunucu tarafı `success_url`/`cancel_url`
   (`/settings/plan/addons/checkout/{success,cancel}`), istemciden dönüş
   URL'i ASLA kabul edilmez.

### Idempotency — YF-809'dan KASITLI olarak FARKLI

Plan aboneliği Checkout'u (`OrganizationCheckoutAttempt`, YF-809) "organizasyonun
aynı anda TEK açık denemesi olabilir" modeline uyar. Bu, add-on'lar için
YANLIŞ modeldir: bir organizasyon aynı anda FARKLI paketler (AI + OCR) VE
AYNI paketten TEKRAR satın alabilmelidir. Bu yüzden yeni bir rezervasyon
tablosu İCAT EDİLMEDİ; bunun yerine Stripe idempotency anahtarı KISA bir
zaman penceresine (`ADDON_CHECKOUT_IDEMPOTENCY_WINDOW_MS` = 60 sn) göre
bucket'lanır — aynı pencuredeki tekrar/çift tıklama Stripe'ta AYNI Session'a
düşer, pencere sonrası bir istek YENİ (meşru) bir satın almadır.

## 6. Authoritative ödeme onayı ve bağış (webhook)

`lib/billing/stripe-gateway.ts` `projectWebhookEvent`, mevcut
`checkout.session.completed`'e ek olarak `checkout.session.async_payment_succeeded`'i
de `CHECKOUT_SESSION` olarak projekte eder (gecikmeli bildirimli ödeme
yöntemleri için — Stripe'ın resmi "fulfill orders" rehberiyle AYNI desen:
asıl karar olay TÜRÜNE değil, YENİDEN ÇEKİLEN `payment_status`'a bakar).

`webhook-service.ts` `processStripeWebhookEvent`, `CHECKOUT_SESSION`
olayında `subscriptionId` YOKSA (plan-abonelik Checkout'undan ayırt eder)
`confirmAddonCheckoutSession`'a delege eder — AYNI `claimEvent` idempotency
zarfı (`StripeWebhookEvent.stripeEventId` `@unique`) İÇİNDE, ikinci bir
webhook işleme yolu OLMADAN.

`confirmAddonCheckoutSession` (`server/services/billing/addon-grant-service.ts`)
sıralı, hepsi fail-closed doğrulama zinciri:

1. **Refetch-on-write** — `gateway.retrieveCheckoutSessionForAddon()` ile
   Session Stripe'tan YENİDEN ÇEKİLİR (YF-810 `retrieveSubscription` ile
   AYNI strateji) — hangi olay/manuel tetikleyici ÖNEMLİ DEĞİLDİR.
2. **Mod kontrolü** — `session.mode !== "payment"` → yok sayılır.
3. **Tenant çapraz doğrulama** — `session.customerId`, çağıranın kanonik
   `OrganizationStripeCustomer` eşlemesinden çözdüğü BEKLENEN müşteri
   kimliğiyle eşleşmelidir (YF-810 `syncSubscriptionFromStripe` ile AYNI
   desen) — uyuşmazlıkta fail-closed, HİÇBİR yazma yapılmaz.
4. **Ödeme durumu** — yalnızca `payment_status === "paid"` bir bağışı
   TETİKLER.
5. **Katalog + fiyat çapraz doğrulaması** — `session.metadata.yapifin_addon_key`
   yalnızca hangi katalog girdisinin DENENECEĞİNİ işaret eder (ikincil
   korelasyon, TEK doğruluk kaynağı DEĞİLDİR — görev talimatı "metadata may
   assist correlation but must not be the trust anchor"). Gerçek bağış
   YALNIZCA Stripe'ın session'da FİİLEN faturaladığı Price ID'si, o
   `addonKey` için kataloğun beklediği Price ID'siyle BİREBİR eşleşirse
   verilir — uydurma/düşük fiyatlı bir Price'a karşılık yüksek miktarlı kota
   bağışı elde etmek yapısal olarak İMKÂNSIZDIR.

Tüm doğrulamalar geçerse `grantUsageAddon` (YF-803, DEĞİŞTİRİLMEDİ)
çağrılır — `resource`/`amount` HER ZAMAN kataloğun kendisinden gelir,
Stripe'tan ASLA.

## 7. Idempotency (bağış)

Bağış idempotency anahtarı Checkout Session'ın KENDİ Stripe kimliğinden
türetilir: `buildAddonGrantIdempotencyKey(environment, checkoutSessionId)`.
`checkout.session.completed` VE `checkout.session.async_payment_succeeded`
AYNI session için ikisi de ateşlense, webhook YENİDEN TESLİM edilse veya
`confirmAddonCheckoutSession` eşzamanlı çağrılsa dahi `grantUsageAddon`'un
`(organizationId, idempotencyKey)` benzersizliği (P2002 yarış çözümü, YF-803)
TAM OLARAK BİR `UsageAddonGrant` garanti eder.

## 8. Mutabakat (reconciliation)

`reconcileAddonPurchase(actor, checkoutSessionId)` (OWNER-only) — YF-810
`reconcileOrganizationStripeSubscription` ile AYNI ilke, ama ARAÇ olarak
`confirmAddonCheckoutSession`'ı ÇAĞIRIR (ikinci bir doğrulama/bağış mantığı
İCAT EDİLMEZ). `checkoutSessionId`, kullanıcının kendi Checkout dönüşünün
`session_id` parametresinden gelir; `organizationId` her zaman OTURUMDAN
türetilir — pasted/tahmin edilmiş bir sessionId BAŞKA bir organizasyona
aitse `confirmAddonCheckoutSession`'ın tenant çapraz doğrulaması (§6 madde
3) fail-closed reddeder, hiçbir kaynağın VARLIĞI sızdırılmaz.
Doğası gereği idempotenttir (`grantUsageAddon` üzerinden) — tekrar tekrar
çağrılması mükerrer bağış ÜRETMEZ.

`getAddonPurchaseStatus(actor, checkoutSessionId)` — success sayfası için
SALT OKUNUR, Stripe'a GİTMEYEN bir DB kontrolüdür (idempotency anahtarını
`checkoutSessionId`'den türetip `UsageAddonGrant`'ı arar) — bir bağışın
webhook tarafından ZATEN işlenip işlenmediğini gösterir, ASLA bağış
OLUŞTURMAZ.

## 9. Refund/dispute sınırı (YF-815'e devir)

Bu görev kapsamı **tam clawback (negatif kota / consumed geçmişini
düzeltme) UYGULAMAZ** — görev talimatı madde 7 "if full clawback belongs to
YF-815, implement only the minimum safe state/hook needed". Bugünkü güvenli
davranış:

- **Bağış idempotenttir ve satır SİLİNMEZ** (`UsageAddonGrant`, YF-803 "hard
  delete yok" ilkesi) — bir refund/dispute webhook'u (`charge.refunded`,
  `charge.dispute.created` vb.) bu görevde EKLENMEZ (kapsam dışı), ama
  eklendiğinde çağıracağı doğal uç nokta `expireUsageAddonGrant` (YF-803,
  ZATEN mevcut — `validUntil`'i şimdiye çeker, negatif kota OLUŞTURMAZ,
  tüketim geçmişini BOZMAZ) olacaktır.
- **Bilinçli olarak yapılmayan**: otomatik refund→kota geri alma webhook
  entegrasyonu, kısmi kullanım sonrası orantısal geri alma hesaplaması. Bu
  ürün kararı (tam mı orantılı mı, hangi Stripe olayı tetikleyici) YF-815'in
  kapsamıdır.
- **El ile devir**: bir OWNER/destek ekibi, bir refund'ı Stripe panelinde
  gördüğünde `expireUsageAddonGrant(db, organizationId, grantId)`'i (bugün
  yalnızca kod/servis katmanından çağrılabilir, bir UI/action EKLENMEDİ —
  kapsam dışı) çağırarak ilgili bağışı GÜVENLE iptal edebilir; tüketilmiş
  kullanım asla negatife DÜŞMEZ (mevcut `resolveEffectiveLimitMax`
  `max(effectiveMax - used, 0)` formülü, YF-803, zaten koruma sağlar).

## 10. Platform faturalaması ile proje muhasebesi ayrımı

YF-810 §8 ile AYNI: bir add-on satın alması `FinancialTransaction`/proje
gelir-gider kaydı ÜRETMEZ. Yalnızca audit log (`billing.addon_checkout.create`,
`billing.addon.granted`) + `UsageAddonGrant.metadata` (Checkout Session ID,
Payment Intent ID, `addonKey` — sır/PII İÇERMEZ) provenance sağlar.

## 11. Güvenlik özeti

- Fail-closed tenant izolasyonu (§6 madde 3), fail-closed fiyat çapraz
  doğrulaması (§6 madde 5).
- Sunucu-only sırlar — `stripe` paketi hâlâ yalnızca `lib/billing/stripe-gateway.ts`
  içinden import edilir.
- PII-ağır loglama YOK — yalnızca kısa, sır İÇERMEYEN korelasyon alanları.
- İstemciden ASLA kabul edilmeyenler: Stripe Price/Product ID, tutar,
  bağış miktarı, `resource`, `organizationId`, dönüş URL'i (§4/§5 ile AYNI).
- Cross-tenant erişim kaynağın VARLIĞINI sızdırmaz (§8).
