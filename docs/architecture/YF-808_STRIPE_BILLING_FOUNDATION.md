# YF-808 — Stripe Faturalama Temeli (foundation)

Bu doküman, YapiFin'e eklenen **ödeme sağlayıcısı (Stripe) sınırının** mimarisini
kaydeder. Kapsam bilinçli olarak **yalnızca temeldir**: checkout akışı, abonelik
yaşam döngüsü ve webhook işleme bu görevin DIŞINDADIR (bkz. §7).

---

## 1. Değişmez mimari sözleşme

> **Stripe bir ödeme/faturalama sağlayıcısıdır. Uygulama erişimi ve yeteneklerinin
> TEK yetkili kaynağı YapiFin'in kendi `Plan` modeli + YF-802 entitlement
> servisidir.**

- Stripe Product/Price/Customer **metadata'sı hiçbir çalışma zamanı
  yetkilendirme kararında okunmaz.**
- `OrganizationStripeCustomer` tablosunda bilinçli olarak plan/price/ürün alanı
  **yoktur** — Stripe tarafındaki bir değişikliğin entitlement sonucunu
  etkilemesi yapısal olarak imkânsızdır.
- Bağımlılık yönü tek yönlüdür: `lib/billing/*` → (hiçbir şey).
  `lib/entitlements/*` Stripe/billing modüllerini **import etmez** (test ile
  doğrulanır: `tests/billing-stripe-customer.test.ts`).
- Bu görev `Organization.planId`'ye dokunmaz; hiçbir plan yükseltme/düşürme
  yolu eklemez. YF-805'teki yükseltme CTA'ları kasıtlı olarak **işlevsiz**
  kalır.

## 2. Katmanlar ve dosyalar

| Katman | Dosya | Sorumluluk |
|---|---|---|
| Hata sözleşmesi | `lib/billing/errors.ts` | `BillingConfigError`, `BillingProviderError`, kategori kümesi, sır redaksiyonu |
| Yapılandırma | `lib/billing/stripe-config.ts` | Gizli anahtar/ortam çözümlemesi, plan → Price eşlemesi, fail-closed kararlar |
| Sağlayıcı sınırı | `lib/billing/stripe-gateway.ts` | **`stripe` SDK'sının TEK import noktası**; `StripeGateway` arayüzü, hata çevirisi, test override kaydı |
| Domain servisi | `server/services/billing/stripe-customer-service.ts` | Organizasyon ↔ Stripe Customer eşlemesi (oluştur-veya-yeniden-kullan), yetki, audit |
| Ortam doğrulama | `lib/env.ts` | `STRIPE_*` değişkenlerinin **biçim** doğrulaması (her ortamda opsiyonel) |
| Şema | `prisma/schema.prisma`, `prisma/migrations/20260810120110_yf808_stripe_billing_foundation` | `StripeEnvironment` enum + `OrganizationStripeCustomer` tablosu |

**Kural:** `stripe` paketi `lib/billing/stripe-gateway.ts` dışında hiçbir route,
server action veya domain servisinden import edilmez.

## 3. Fail-closed yapılandırma

`lib/env.ts` `INTEGRATION_ENCRYPTION_KEY` ile **aynı** deseni izler:

- **Eksikse** → uygulama başlangıcı ve ilgisiz route'lar etkilenmez; yalnızca
  gerçek bir Stripe işlemi çağrıldığında `BillingConfigError` fırlatılır.
- **Biçimi bozuksa** → her ortamda başlangıçta reddedilir (yazım hatası sessizce
  üretime gitmez).

Fail-closed kapanan durumlar: gizli anahtar yok; anahtar öneki tanınmıyor;
`STRIPE_ENVIRONMENT` beyanı anahtarla uyuşmuyor; üretimde beyansız test anahtarı;
bilinmeyen plan kodu; eşlenmemiş plan fiyatı.

## 4. Ortam ayrımı (test ↔ live)

1. Çalışma ortamı (`TEST`/`LIVE`) **gizli anahtarın önekinden türetilir** — bir
   dağıtımın yalnızca tek bir Stripe ortamı olabilir.
2. `STRIPE_ENVIRONMENT` verilirse önekle **birebir** eşleşmelidir.
3. `NODE_ENV=production` altında test anahtarı yalnızca `STRIPE_ENVIRONMENT=test`
   **açıkça** beyan edilirse kabul edilir (staging meşrudur, kaza değil).
4. Kalıcı eşleme `environment` sütunu taşır; tüm okuma/yazmalar
   `[organizationId, environment]` ile scope edilir — TEST'te oluşan bir müşteri
   LIVE'da **asla** yeniden kullanılmaz.
5. Idempotency anahtarı ortamı içerir; ortamlar aynı anahtarı paylaşmaz.

Gizli anahtar ve webhook sırrı hiçbir log/hata mesajına yazılmaz
(`redactBillingSecrets`, ikinci savunma katmanı).

## 5. Idempotency ve eşzamanlılık

İki katmanlıdır:

1. **Stripe tarafı:** deterministik anahtar
   `yapifin:{test|live}:customer:{organizationId}` → tekrar/eşzamanlı çağrı
   Stripe'ta ikinci müşteri oluşturmaz.
2. **Veritabanı tarafı (doğruluk kaynağı):**
   `@@unique([organizationId, environment])`. Check-then-insert yarışı yoktur —
   P2002 yakalanır, kazanan satır yeniden okunur (`settlement-service.ts` /
   `provider-lifecycle-service.ts` ile aynı desen).

`@@unique([environment, stripeCustomerId])` aynı Stripe müşterisinin iki
organizasyona bağlanmasını (tenant sızıntısı) veritabanı düzeyinde imkânsız kılar.

Stripe `idempotency_key_in_use` (eşzamanlı uçuşta istek) hatası
`IDEMPOTENCY_CONFLICT` kategorisine çevrilir; kalıcı satır varsa yeniden
kullanılır, yoksa kontrollü bir `ServiceError(CONFLICT)` döner.

## 6. Tenant izolasyonu ve yetki

- `organizationId` **yalnızca** doğrulanmış oturumdan (`SessionUser`) türetilir.
  Servis imzaları başka parametre almaz — istemciden gelen `organizationId`,
  Stripe Customer/Product/Price kimliği **hiçbir yerde** kabul edilmez veya
  güvenilmez.
- `ensureOrganizationStripeCustomer`: yalnızca **OWNER**
  (`canManageOrganizationSettings`).
- `getOrganizationStripeCustomer`: **OWNER/ADMIN**
  (`canViewOrganizationSettings`).
- Müşteri oluşturma `billing.stripe_customer.create` audit kaydı üretir (yalnızca
  sır olmayan kısa tanımlayıcılar).
- Bu görevde **hiçbir yeni API route veya server action eklenmemiştir** —
  saldırı yüzeyi bilinçli olarak sıfır tutuldu; sınır servis katmanı üzerinden
  test edilir.

## 7. Bilinçli olarak ertelenenler

Bu görevde **uygulanmamıştır** (ayrı görevler):

- Checkout/ödeme akışı (Stripe Checkout Session, Payment Element, Billing Portal).
- Abonelik yaşam döngüsü (`Subscription` oluşturma/yükseltme/düşürme/iptal,
  deneme süresi, proration).
- **Webhook altyapısı** — imza doğrulama, olay kuyruğu/idempotency, olay→plan
  eşlemesi. Yapısal olarak gerekli olmadığından tamamen ertelendi; `whsec_`
  redaksiyonu ileride eklenecek doğrulama için bugünden hazırdır.
- Fatura/makbuz üretimi, vergi (KDV) yapılandırması, TRY para birimi/fiyat
  kararları (bkz. `docs/product/YF-807-plan-unit-economics.md` — fiyat henüz
  belirlenmedi).
- Ödemeye bağlı plan değişikliği (`Organization.planId` mutasyonu) — YF-804 ile
  birlikte tasarlanmalıdır.
- Faturalama arayüzü (Türkçe ekranlar) ve YF-805 CTA'larının aktifleştirilmesi.
