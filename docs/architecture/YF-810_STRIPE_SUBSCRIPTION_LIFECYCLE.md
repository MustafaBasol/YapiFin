# YF-810 — Stripe Abonelik Yaşam Döngüsü ve Webhook Senkronizasyonu

> Bu doküman, YF-808 (Stripe Billing Foundation) ve YF-809 (Stripe Checkout)
> üzerine inşa edilen asenkron abonelik senkronizasyonunu belgeler. §7'de
> atıfta bulunulan "YF-810 webhook senkronizasyonu" budur.

## 1. Değişmez mimari sözleşme (YF-808/YF-809 ile AYNI)

> **Stripe bir ödeme/faturalama sağlayıcısıdır. Uygulama erişimi ve
> yeteneklerinin TEK yetkili kaynağı YapiFin'in kendi `Plan` modeli + YF-802
> entitlement servisidir.**

- Tarayıcının Checkout'tan **başarılı** dönmesi (`success_url`) entitlement'ı
  DEĞİŞTİRMEZ (YF-809 §1 ile AYNI).
- Bu görevde eklenen webhook senkronizasyonu, `Organization.planId`'yi
  mutasyona uğratan **TEK** yerdir. Hiçbir ikinci/paralel entitlement
  hesaplama mantığı yoktur — yalnızca "hangi plan grantlanmalı" kararı
  verilir; gerçek yetenek/kota kararı yine
  `lib/entitlements/entitlement-service.ts`'e aittir.
- Stripe Product/Price/Customer/Subscription metadata'sı hiçbir çalışma
  zamanı yetkilendirme kararında OKUNMAZ — yalnızca korelasyon/teşhis
  amaçlıdır.

## 2. Katmanlar ve dosyalar

| Katman | Dosya | Sorumluluk |
|---|---|---|
| Yapılandırma | `lib/billing/stripe-config.ts` | `getStripeWebhookSecret()`, `resolvePlanForStripePrice()` (Price ID → kanonik plan, ters yön) |
| Ortam doğrulama | `lib/env.ts` | `STRIPE_WEBHOOK_SECRET` biçim doğrulaması |
| Sağlayıcı sınırı | `lib/billing/stripe-gateway.ts` | `constructWebhookEvent()` (imza doğrulama + olay projeksiyonu), `retrieveSubscription()`, `listSubscriptionsForCustomer()` |
| Domain servisi | `server/services/billing/webhook-service.ts` | `processStripeWebhookEvent()`, `reconcileOrganizationStripeSubscription()` — idempotency, tenant izolasyonu, entitlement senkronizasyonu |
| Route | `app/api/billing/stripe/webhook/route.ts` | Ham gövde okuma, imza doğrulama, HTTP durum kodu eşleme |
| Server action | `app/actions/billing.ts` `reconcileBillingAction` | OWNER-tetiklemeli manuel mutabakat |
| UI | `app/(app)/settings/plan/checkout/success/page.tsx`, `components/app/reconcile-billing-button.tsx` | "Durumu şimdi kontrol et" — yalnızca Stripe'ı SORAR, hiçbir şey KAZANDIRMAZ |
| Şema | `prisma/schema.prisma`, migration `20260810174622_yf810_stripe_subscription_lifecycle` | `StripeWebhookEvent`, `OrganizationStripeSubscription` + 3 enum |

**Kural (YF-808'den DEVAM):** `stripe` paketi yalnızca
`lib/billing/stripe-gateway.ts` içinden import edilir (testler hariç — bkz.
`tests/billing-webhook-route.test.ts`, imza doğrulamasını gerçek Stripe SDK
yardımcılarıyla uçtan uca kanıtlamak için).

## 3. Ele alınan Stripe olayları

Stripe SDK'sı `stripe@22.4.0` (API sürümü `2026-07-29.dahlia`, "Basil"
sonrası). Bu sürümde `Subscription.current_period_start/end` alanları
KALDIRILMIŞTIR — dönem tarihleri artık `subscription.items.data[0]`
üzerindedir (bkz. Stripe değişiklik günlüğü "deprecate subscription current
period start and end", 2025-03-31). `Invoice.subscription` alanı da benzer
şekilde kaldırılmış, yerini `invoice.parent.subscription_details.subscription`
almıştır. Bu ayrıntılar `lib/billing/stripe-gateway.ts` içinde TEK yerde
(`toSubscriptionRef`, `extractInvoiceSubscriptionId`) ele alınır.

| Olay | İşlem |
|---|---|
| `customer.subscription.created` | Abonelik yeniden çekilir (refetch), yerel satır yazılır, entitlement senkronize edilir |
| `customer.subscription.updated` | Aynı (durum/fiyat/dönem/`cancel_at_period_end` değişiklikleri dahil) |
| `customer.subscription.deleted` | Aynı — genellikle `status=canceled` ile gelir, erişim geri alınır |
| `customer.subscription.paused` | Aynı — `paused` durumu fail-closed geri alınır |
| `customer.subscription.resumed` | Aynı — yeniden çekilen durum `active`/`trialing` ise erişim GERİ GRANTLANIR |
| `invoice.payment_succeeded` | Abonelik yeniden senkronize edilir + `lastPaymentStatus=SUCCEEDED` + audit log |
| `invoice.payment_failed` | Aynı, `FAILED` — abonelik genellikle `past_due`'ya geçer (Stripe tarafından), bu NÖTR'dür (bkz. §5) |
| `checkout.session.completed` | En erken korelasyon sinyali — `subscription` varsa aynı senkronizasyon tetiklenir (best-effort; `customer.subscription.created` zaten aynı sonucu bağımsız olarak üretir) |
| *(diğer tüm olay türleri)* | `UNHANDLED` — veritabanına idempotency kaydı için yazılır, `IGNORED` işaretlenir, 200 döner (Stripe yeniden DENEMEZ) |

`customer.subscription.trial_will_end` ve `*.pending_update_*` bilinçli
olarak ele ALINMAZ (bildirim amaçlı/schedule-bazlı, entitlement durumunu
DEĞİŞTİRMEZ — kapsam dışı, YF-810 görev talimatı "avoid MVP→ERP scope
expansion" ile uyumlu).

## 4. İdempotency stratejisi

`StripeWebhookEvent.stripeEventId` üzerinde veritabanı düzeyi `@unique`
kısıt TEK doğruluk kaynağıdır. `webhook-service.ts` `claimEvent`:

1. `create()` dener. Başarılıysa olay "iddia edilmiştir" (claimed).
2. `P2002` (çakışma) durumunda mevcut satır okunur:
   - `PROCESSED`/`IGNORED` ise → `DUPLICATE` (yeniden işlenmez, route 200 döner).
   - `FAILED`/`RECEIVED` (önceki deneme çökmüş/başarısız) ise → GÜVENLE
     yeniden denenir (`attempts` artırılır).

Bu, `AiUsageLedger`/`OrganizationStripeCustomer` ile AYNI "önce veritabanı
düzeyinde tekillik, sonra uygulama mantığı" felsefesini izler.

## 5. Sıra-dışı (out-of-order) olay stratejisi: refetch-on-write

Stripe olayları geç/sıra dışı teslim edilebilir. Bu kod tabanı **"her zaman
Stripe'tan yeniden çek"** stratejisini kullanır: `syncSubscriptionFromStripe`
hangi olayın tetiklediğinden BAĞIMSIZ olarak `gateway.retrieveSubscription()`
ile Stripe'ın O ANKİ gerçeğini çeker ve yerel satırı bununla yazar. İki olay
(biri eski, biri yeni) hangi sırada işlenirse işlensin, ikisi de AYNI
(Stripe'ın güncel) duruma yakınsar. `OrganizationStripeSubscription.lastProcessedEventId`/
`lastProcessedEventCreatedAt` yalnızca gözlemlenebilirlik içindir (monoton
ileri taşınır), yazma kararını ETKİLEMEZ.

Aynı organizasyon için eşzamanlı iki webhook teslimatı,
`lockOrganizationForEntitlement` (mevcut `SELECT ... FOR UPDATE` deseni,
`checkout-service.ts`/`ai-usage-reporting-service.ts` ile AYNI) ile
serileştirilir.

## 6. Tenant izolasyonu

1. Bir Stripe müşteri kimliğinin hangi organizasyona ait olduğu ASLA webhook
   metadata'sından DOĞRUDAN güvenilmez — TEK kanonik kaynak
   `OrganizationStripeCustomer` eşlemesidir (YF-808).
2. Eşleme YOKSA olay `IGNORED` işaretlenir, hiçbir organizasyona yazılmaz.
3. Stripe'tan YENİDEN ÇEKİLEN abonelik nesnesinin `customer` alanı, eşlemeden
   çözülen BEKLENEN müşteri kimliğiyle çapraz doğrulanır; uyuşmazlıkta
   fail-closed reddedilir (hiçbir yazma yapılmaz, `billing.webhook.tenant_mismatch`
   olarak loglanır).

## 7. Entitlement durumları ve erişim davranışı

| Stripe durumu | Yerel `StripeSubscriptionStatus` | Erişim |
|---|---|---|
| `active` | `ACTIVE` | GRANT — satın alınan plan `Organization.planId`'ye yazılır |
| `trialing` | `TRIALING` | GRANT — deneme tam erişimdir |
| `past_due` | `PAST_DUE` | NÖTR — mevcut plan KORUNUR (Stripe otomatik yeniden dener) |
| `incomplete` | `INCOMPLETE` | NÖTR — ilk ödeme hiç tamamlanmadı, zaten grant verilmemiştir |
| `canceled` | `CANCELED` | REVOKE — bkz. aşağıdaki güvenlik koruması |
| `unpaid` | `UNPAID` | REVOKE |
| `incomplete_expired` | `INCOMPLETE_EXPIRED` | REVOKE (savunma amaçlı — genelde zaten grant yok) |
| `paused` | `PAUSED` | REVOKE (fail-closed — nadir/belirsiz durum) |
| *(bilinmeyen/gelecekteki)* | `UNKNOWN` | REVOKE (fail-closed) |

**Revoke güvenlik koruması:** `Organization.planId`, YALNIZCA HÂLÂ bu
aboneliğin en son grantladığı plana (`OrganizationStripeSubscription.lastGrantedPlanId`)
eşitse `null`lanır. Plan bu abonelik DIŞINDA (ör. bir yönetici tarafından
elle) değiştirilmişse revoke ATLANIR — asla EZİLMEZ.

**Veri koruma:** Hiçbir revoke/downgrade kullanıcı/proje/finansal veri
SİLMEZ — yalnızca `Organization.planId` `null`lanır (entitlement servisi
bunu `NO_PLAN` fail-closed sentinel'i ile ele alır, limit=0/capability=false,
bkz. `lib/entitlements/entitlement-service.ts`).

**Fiyat kataloğa çözülemezse:** (`resolvePlanForStripePrice` `null` döner —
ör. Stripe panelinde elle oluşturulmuş, izlenmeyen bir Price) plan ASLA
grantlanmaz; `OrganizationStripeSubscription.reconciliationNote` alanına
sır İÇERMEYEN bir teşhis notu yazılır.

## 8. Ödeme durumu — platform faturalaması, proje muhasebesinden AYRI

`invoice.payment_succeeded`/`invoice.payment_failed`, YALNIZCA
`OrganizationStripeSubscription.lastPaymentStatus`/`lastPaymentAt`/`lastInvoiceId`
alanlarını ve bir audit log satırı günceller. **Hiçbir `FinancialTransaction`
kaydı OLUŞTURULMAZ** — Stripe SaaS abonelik geliri platform faturalama
verisidir, inşaat projesi gelir/gider muhasebe defteri DEĞİLDİR.

## 9. Mutabakat (reconciliation)

`reconcileOrganizationStripeSubscription` (OWNER-only,
`app/actions/billing.ts` `reconcileBillingAction` üzerinden UI'a bağlıdır):

1. Organizasyonun `OrganizationStripeCustomer` eşlemesi okunur (yoksa
   `NOT_FOUND`).
2. Yerel `OrganizationStripeSubscription` satırı varsa, o aboneliği YENİDEN
   senkronize eder (`syncSubscriptionFromStripe` — webhook ile AYNI
   fonksiyon).
3. Yerel satır YOKSA (webhook TAMAMEN kaçırılmış olabilir),
   `gateway.listSubscriptionsForCustomer()` ile Stripe'taki abonelikler
   KEŞFEDİLİR ve en ilgili olanı (aktif/deneme/gecikmiş, yoksa en yenisi)
   senkronize edilir.

`syncSubscriptionFromStripe`'ı yeniden kullandığı için DOĞASI GEREĞİ
idempotenttir — art arda çağrılması AYNI sonucu üretir, mükerrer audit
kaydı OLUŞTURMAZ (yalnızca GERÇEK bir durum değişikliği audit üretir).

## 10. Güvenlik

- Webhook imzası (`stripe-signature`) HAM (değiştirilmemiş) istek gövdesi
  üzerinden doğrulanır (`request.text()` — `request.json()` ASLA önce
  çağrılmaz).
- `STRIPE_WEBHOOK_SECRET` tanımsızsa route fail-closed 500 döner — sessizce
  "başarılı" dönmez.
- Hiçbir ham Stripe olay payload'ı veritabanına/loglara YAZILMAZ — yalnızca
  kısa, sır İÇERMEYEN korelasyon alanları.
- `lib/billing/errors.ts` `redactBillingSecrets`, webhook sırrı biçimini
  (`whsec_...`) da kapsayacak şekilde ZATEN genişletilmişti (YF-808).
