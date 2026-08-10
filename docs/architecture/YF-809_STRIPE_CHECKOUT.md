# YF-809 — Stripe Checkout ve Plan Satın Alma Akışı

Bu doküman, YF-808'in Stripe faturalama temelinin üzerine eklenen **kendi
kendine (self-service) Stripe Checkout başlatma akışının** mimarisini
kaydeder. Kapsam bilinçli olarak checkout OLUŞTURMA ile sınırlıdır — abonelik
yaşam döngüsü, webhook işleme ve plan aktivasyonu bu görevin DIŞINDADIR (bkz.
§7, YF-810).

---

## 1. Değişmez mimari sözleşme (YF-808 ile AYNI)

> **Stripe bir ödeme/faturalama sağlayıcısıdır. Uygulama erişimi ve
> yeteneklerinin TEK yetkili kaynağı YapiFin'in kendi `Plan` modeli + YF-802
> entitlement servisidir.**

- Bir Stripe Checkout Session **oluşturmak** hiçbir yetenek/kota/erişim
  KAZANDIRMAZ ve `Organization.planId`'ye ASLA DOKUNMAZ.
- Tarayıcının Checkout'tan **başarılı** dönmesi (`success_url`) dahi
  entitlement'ı DEĞİŞTİRMEZ — bkz. §6.
- Stripe Checkout metadata'sı hiçbir çalışma zamanı yetkilendirme kararında
  OKUNMAZ; yalnızca YF-810'un webhook korelasyonu için hazırlanmıştır (§7).

## 2. Katmanlar ve dosyalar

| Katman | Dosya | Sorumluluk |
|---|---|---|
| Yapılandırma | `lib/billing/stripe-config.ts` | Aralık bazlı (`BillingInterval`) plan → Price eşlemesi, `resolveStripePriceForPlan(planCode, interval)` |
| Ortam doğrulama | `lib/env.ts` | `STRIPE_PRICE_{PLAN}_{MONTHLY,ANNUAL}` biçim doğrulaması (ENTERPRISE hariç, aralıktan bağımsız) |
| Sağlayıcı sınırı | `lib/billing/stripe-gateway.ts` | `createCheckoutSession()` — Stripe Checkout Session (subscription modu), korelasyon metadata'sı |
| Domain servisi | `server/services/billing/checkout-service.ts` | `createPlanCheckoutSession()` — yetki, kanonik doğrulama, fiyat çözümleme, müşteri, mükerrer/idempotency, audit |
| Doğrulama | `lib/validation/billing.ts` | `startCheckoutSchema` — form (client) ve server action'ın ORTAK Zod kaynağı |
| Server action | `app/actions/billing.ts` | `startCheckoutAction` — OWNER kontrolü, doğrulama, servis çağrısı, `redirect()` |
| UI | `components/app/plan-comparison-view.tsx` | Aylık/yıllık aralık seçici + gerçek satın alma CTA'sı (`useActionState` + `useFormStatus`) |
| Dönüş sayfaları | `app/(app)/settings/plan/checkout/{success,cancel}/page.tsx` | Hiçbir mutasyon YAPMAZ — yalnızca durum gösterir |
| Şema | `prisma/schema.prisma`, migration `20260810150000_yf809_stripe_checkout` | `BillingInterval` enum + `OrganizationCheckoutAttempt` tablosu |

**Kural (YF-808'den DEVAM):** `stripe` paketi yalnızca
`lib/billing/stripe-gateway.ts` içinden import edilir.

## 3. Girdi güveni — istemci yalnızca `planCode` + `billingInterval` gönderir

İstemciden **yalnızca** kanonik plan kodu ve faturalama aralığı kabul edilir
(`lib/validation/billing.ts` → `app/actions/billing.ts` → `checkout-service.ts`
— üç katmanda da AYNI allowlist, `CANONICAL_BILLING_PLAN_CODES`/
`BILLING_INTERVALS`'tan türetilir, ikinci bir liste İCAT EDİLMEZ).

Aşağıdakilerin HİÇBİRİ istemciden alınmaz/güvenilmez:

- Stripe Price ID — `resolveStripePriceForPlan()` ile sunucu tarafında
  kanonik katalogdan çözülür.
- Tutar/para birimi — Stripe Price'ın kendisinden gelir, hiçbir yerde
  parametre olarak taşınmaz.
- Stripe Customer ID / `organizationId` — `actor: SessionUser`'dan (oturum)
  türetilir; `ensureOrganizationStripeCustomer()` (YF-808) yeniden kullanılır.
- Başarı/iptal dönüş URL'leri — `buildSuccessUrl()`/`buildCancelUrl()` ile
  `NEXT_PUBLIC_APP_URL`'den sabit olarak üretilir.

`createPlanCheckoutSession.length === 2` (`actor`, `input`) — yapısal kanıt
(bkz. tests/billing-checkout.test.ts).

## 4. Aralık bazlı fiyat çözümleme (aylık/yıllık)

- STARTER/PROFESSIONAL/BUSINESS: `STRIPE_PRICE_{PLAN}_MONTHLY` /
  `STRIPE_PRICE_{PLAN}_ANNUAL` — birbirinden BAĞIMSIZ, ayrı Stripe Price ID'leri.
  Aylık her zaman çalışabilir durumda kurulabilir; **yıllık henüz
  yapılandırılmamışsa Checkout fail-closed reddedilir** (`BillingConfigError`)
  — aylık fiyattan bir çarpanla TÜRETİLMEZ, uydurma bir ID ASLA üretilmez.
- ENTERPRISE: tek bir `STRIPE_PRICE_ENTERPRISE` değişkeni (aralıktan
  bağımsız, her zaman `CONTACT_SALES` sentinel'i) — kendi kendine ödeme HİÇBİR
  aralıkta AÇILMAZ (`price.kind === "CONTACT_SALES"` kontrolü checkout-service.ts'te).

## 5. Yetki

- Yalnızca **OWNER** (`canManageOrganizationSettings`) — YF-808'in Stripe
  müşterisi oluşturma yetki sınırıyla AYNI. Kontrol İKİ katmanda uygulanır:
  `app/actions/billing.ts` (`requireRole(["OWNER"])`, sayfa/redirect düzeyi) VE
  `checkout-service.ts` (servis düzeyi, gerçek yetki kaynağı).
- Cross-tenant kimlik KULLANILAMAZ: `organizationId` yalnızca oturumdan gelir;
  `OrganizationCheckoutAttempt.organizationId` birincil anahtar olduğundan bir
  organizasyonun başka bir organizasyonun denemesini okuması/etkilemesi
  yapısal olarak imkânsızdır.

## 6. Checkout modu, dönüş akışı ve entitlement etkisizliği

- Mod: `subscription` (yinelenen SaaS planları için) — `line_items` tek bir
  `price` + `quantity: 1`.
- Deneme süresi (`trial_period_days`) **kasıtlı olarak AYARLANMAZ** — merkezi
  bir deneme politikası yok, uydurma bir süre İCAT EDİLMEZ. Genişletme noktası
  `lib/billing/stripe-gateway.ts` `createCheckoutSession()` içinde
  `subscription_data` yorumunda işaretlidir.
- Promosyon kodları: `allowPromotionCodes` parametresi HAZIRDIR ama
  `checkout-service.ts` her zaman `false` geçer — mevcut ürün politikasında
  indirim kararı yok, uydurma kupon İCAT EDİLMEZ.
- Başarı/iptal URL'leri sunucu tarafında sabit üretilir
  (`/settings/plan/checkout/success|cancel`), istemciden hiçbir dönüş URL'i
  kabul edilmez.
- **`app/(app)/settings/plan/checkout/success/page.tsx` hiçbir Stripe/DB
  sorgusu ÇALIŞTIRMAZ ve hiçbir mutasyon YAPMAZ** — yalnızca "ödeme adımı
  tamamlandı, abonelik onayı bekleniyor" durumunu gösterir. Gerçek aktivasyon
  YF-810 webhook senkronizasyonunu bekler. `tests/billing-checkout.test.ts`
  ("Checkout başlatmak hiçbir plan/entitlement mutasyonu YAPMAZ") bunu servis
  düzeyinde kanıtlar: `createPlanCheckoutSession()` çağrısından önce/sonra
  `Organization.planId` ve `getEffectivePlan()` sonucu birebir aynıdır.

## 7. YF-810 için hazırlanan korelasyon (webhook henüz YOK)

Stripe Checkout Session hem `metadata` hem `subscription_data.metadata`
alanlarında şunları taşır (sır/PII İÇERMEZ):

- `yapifin_organization_id`
- `yapifin_plan_code`
- `yapifin_billing_interval`
- `yapifin_stripe_environment`

`client_reference_id` da `organizationId`'ye ayarlanır (Stripe'ın önerdiği
ikincil korelasyon deseni). Bu, YF-810'un `checkout.session.completed` VEYA
`customer.subscription.*` olaylarından organizasyon/plan/aralığı güvenle
okuyabilmesi içindir — bugün hiçbir yerde OKUNMAZ.

Bu görevde **uygulanmamıştır**: webhook imza doğrulama, olay işleme, abonelik
yaşam döngüsü (`Subscription` oluşturma/güncelleme/iptal), plan aktivasyonu,
Customer Portal, dunning, iade/itiraz akışları, kullanım bazlı faturalama,
Stripe Tax.

## 8. Mükerrer deneme koruması, idempotency ve eşzamanlılık (YF-809 hotfix)

`OrganizationCheckoutAttempt` tablosu — **abonelik/lifecycle kaydı DEĞİLDİR**,
yalnızca "bu organizasyonun şu an açık bir self-servis denemesi var mı"
sorusuna cevap veren minimal, dayanıklı bir durumdur.

- **Şema:** `organizationId` BİRİNCİL ANAHTARDIR (cuid `id` yerine) — bir
  organizasyonun aynı anda yalnızca TEK açık denemesi olabileceği PostgreSQL
  tarafından yapısal olarak garanti edilir; filtrelenmiş (partial) bir unique
  index İCAT EDİLMEZ. `status` (`RESERVED`/`COMPLETED`) + `attemptCount` +
  `reservationExpiresAt` satırın yaşam döngüsünü taşır (bkz. aşağıda).
- **Organizasyon satır kilidi (atomik, Stripe'a gidilmeden ÖNCE):**
  `reserveCheckoutAttempt` (`server/services/billing/checkout-service.ts`),
  `lockOrganizationForEntitlement` ile AYNI `SELECT ... FOR UPDATE` desenini
  kullanır (bkz. `server/services/ai-usage-reporting-service.ts` checkQuota
  — AYNI desen) ve BU KİLİT ALTINDA satırı `RESERVED` durumuna yazar. Bir
  organizasyon için TÜM eşzamanlı çağrılar bu kilitte SIRAYLA işlenir; karar
  her zaman en güncel, tutarlı DB durumuna göre verilir — check-then-insert
  yarışı yapısal olarak YOKTUR (P2002 yakalamaya gerek kalmaz). FARKLI bir
  plan/aralık için hâlâ aktif bir deneme varsa istek burada, **Stripe'a HİÇ
  gidilmeden** `ServiceError(CONFLICT)` ile reddedilir.
- **Stripe tarafı idempotency:** deterministik anahtar
  `yapifin:{test|live}:checkout:{organizationId}:{planCode}:{interval}`
  (`buildCheckoutIdempotencyKey`, YF-808'in `buildCustomerIdempotencyKey`'i ile
  AYNI desen). Zaman bileşeni TAŞIMAZ — bu kasıtlıdır: Stripe'ın idempotency
  önbelleği VE Checkout Session'ın kendi `expires_at`'i her ikisi de ~24
  saatte dolar, bu yüzden satır bizim tarafımızda BAYATLADIĞINDA aynı anahtar
  Stripe'ta güvenle YENİ bir oturum üretir. AYNI niyetli eşzamanlı istekler
  (hızlı çift tıklama) rezervasyonu devralır ve gateway'e AYNI anahtarla
  gider — Stripe tarafında tek bir Session'a düşer.
- **Commit/release "fencing" (Stripe yanıtından SONRA):** gateway çağrısı
  transaction DIŞINDA (kilit tutulmadan) yapılır — dış sağlayıcı çağrısı asla
  bir DB kilidi/transaction'ı boyunca tutulmaz. Dönüşte `commitCheckoutAttempt`
  (başarı) veya `releaseCheckoutAttempt` (sağlayıcı hatası), rezervasyonu HÂLÂ
  kendisinin sahip olduğunu `attemptCount` eşleşmesiyle doğrular (`AiUsageLedger`
  row-identity guard AYNI deseni) — geç kalan bir yanıt, o sırada devralınmış
  YENİ bir rezervasyonu asla ezmez/silmez.
- **Sağlayıcı hatası kurtarma:** `createCheckoutSession` başarısız olursa
  rezervasyon HEMEN silinir (`releaseCheckoutAttempt`) — organizasyon kalıcı
  olarak engellenmez, bir sonraki istek (AYNI veya FARKLI plan) hemen serbest
  bir satırla karşılaşır.
- **Çökme kurtarma (bounded TTL):** süreç, rezervasyon ile Stripe yanıtı
  arasında ÇÖKERSE satır `RESERVED` kalır; `reservationExpiresAt`
  (`CHECKOUT_RESERVATION_TTL_MS` = 2 dakika — tipik Stripe çağrı süresine
  bolca pay bırakır ama sonsuza dek açık bırakmaz) bu andan sonra satırı bayat
  sayar; bir SONRAKİ istek (AYNI veya FARKLI plan/aralık için) satırı
  `reserveCheckoutAttempt` içinde güvenle devralır.

Deterministik eşzamanlılık testleri (sleep KULLANMAZ; gerçek `Promise.all` +
ertelenmiş/bloklayan sahte gateway `tests/helpers.ts`
`createDeferredStripeGateway`): `tests/billing-checkout.test.ts` "hızlı çift
tıklama", "aynı organizasyon FARKLI bir plan için açık deneme varken
CONFLICT" ve "YF-809 hotfix — eşzamanlılık" bölümündeki rezervasyon/serbest
bırakma/bayat-devralma senaryoları.

## 9. Güvenlik

- Stripe gizli anahtarı, ham checkout payload'ı veya ham Stripe hatası hiçbir
  zaman loglanmaz/istemciye taşınmaz — `toBillingProviderError` (YF-808) AYNI
  şekilde yeniden kullanılır.
- Tüm plan/aralık girdileri kanonik allowlist'e karşı doğrulanır
  (`CANONICAL_BILLING_PLAN_CODES`, `BILLING_INTERVALS`) — üç katmanda
  (Zod şeması, server action, servis) TUTARLI.
- Uydurma fiyat/müşteri/tutar enjeksiyonu yapısal olarak İMKÂNSIZDIR (bkz.
  §3) — `tests/billing-checkout.test.ts` "istemciden gelen fazladan alanlar…
  Checkout'u ETKİLEMEZ" testi tip sözleşmesini kurcalayan bir çağrıyla bunu
  kanıtlar.

## 10. Migration

`prisma/migrations/20260810150000_yf809_stripe_checkout` — additive (PR henüz
merge edilmediği için eşzamanlılık hotfix'i AYNI migration'da düzenlendi,
ayrı bir ALTER migration'ı EKLENMEDİ):

- `CREATE TYPE "BillingInterval" AS ENUM ('MONTHLY', 'ANNUAL')`
- `CREATE TYPE "CheckoutAttemptStatus" AS ENUM ('RESERVED', 'COMPLETED')`
- `CREATE TABLE "OrganizationCheckoutAttempt"` (`organizationId` PK, FK YOK —
  `OrganizationStripeCustomer` ile AYNI ilke: blast radius minimize edilir).
  `status` varsayılan `RESERVED`, `attemptCount` varsayılan `1`;
  `stripeCheckoutSessionId` ve `expiresAt` NULLABLE (yalnızca `COMPLETED`
  iken doldurulur).
- 3 index (`stripeCheckoutSessionId` unique, `idempotencyKey` unique,
  `expiresAt` btree)

Mevcut hiçbir tabloya/sütuna dokunulmaz; geri alınabilir (`DROP TABLE` +
`DROP TYPE`).
