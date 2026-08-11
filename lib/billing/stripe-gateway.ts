import Stripe from "stripe";
import type { StripeEnvironment } from "@prisma/client";
import { BillingProviderError, type BillingErrorCategory } from "@/lib/billing/errors";
import { getStripeConfig, type BillingInterval } from "@/lib/billing/stripe-config";

/**
 * YF-808 — Stripe SDK'sının TEK sarmalayıcısı (provider boundary).
 *
 * **Kural:** `stripe` paketi bu dosya DIŞINDA hiçbir route, action veya domain
 * servisinden import EDİLMEZ. Domain katmanı yalnızca aşağıdaki
 * `StripeGateway` arayüzünü görür; böylece (a) sağlayıcı hataları tek yerde
 * güvenli/kategorize hatalara çevrilir, (b) testler gerçek Stripe kimlik
 * bilgisi olmadan deterministik bir sahte gateway takabilir, (c) ham Stripe
 * nesneleri domain'e sızmaz (bkz.
 * server/services/integrations/provider-adapter.ts ile aynı ilke).
 */

/** Domain'e dönen tek Stripe müşteri temsili — ham Stripe nesnesi ASLA dışarı verilmez. */
export interface StripeCustomerRef {
  readonly id: string;
}

export interface CreateStripeCustomerParams {
  /** Her zaman sunucu tarafındaki oturumdan türetilir — istemciden ASLA alınmaz. */
  readonly organizationId: string;
  readonly name: string;
  readonly email: string | null;
  /** Deterministik idempotency anahtarı (bkz. server/services/billing/stripe-customer-service.ts). */
  readonly idempotencyKey: string;
}

/** YF-809 — Domain'e dönen tek Stripe Checkout Session temsili — ham Stripe nesnesi ASLA dışarı verilmez. */
export interface StripeCheckoutSessionRef {
  readonly id: string;
  /** Kullanıcının yönlendirileceği Stripe barındırmalı ödeme sayfası. */
  readonly url: string;
  /** Unix saniye — Stripe oturumunun süre dolma zamanı (Stripe varsayılanı: oluşturmadan ~24 saat sonra). */
  readonly expiresAt: number;
}

export interface CreateCheckoutSessionParams {
  /** Her zaman sunucu tarafındaki oturumdan türetilir — istemciden ASLA alınmaz. */
  readonly organizationId: string;
  /** YF-808'in `ensureOrganizationStripeCustomer()`'ından — istemciden ASLA alınmaz. */
  readonly customerId: string;
  /** `resolveStripePriceForPlan()`'dan — istemciden ASLA alınmaz (bkz. server/services/billing/checkout-service.ts). */
  readonly priceId: string;
  readonly planCode: string;
  readonly billingInterval: BillingInterval;
  /** Sunucu tarafında, güvenilir uygulama yapılandırmasından üretilir — istemciden ASLA alınmaz. */
  readonly successUrl: string;
  readonly cancelUrl: string;
  /** Deterministik idempotency anahtarı (bkz. server/services/billing/checkout-service.ts buildCheckoutIdempotencyKey). */
  readonly idempotencyKey: string;
  /**
   * YF-809 — genişletilebilirlik noktası (görev talimatı madde 9): bugün
   * her zaman `false` geçilir (mevcut ürün politikasında indirim/promosyon
   * kararı YOKTUR, uydurma bir kupon/politika İCAT EDİLMEZ). İleride bir
   * merkezi promosyon politikası tanımlanırsa yalnızca çağıran taraf
   * (checkout-service.ts) değişir — bu arayüz zaten hazırdır.
   */
  readonly allowPromotionCodes: boolean;
}

/** YF-813 — kullanım/ek-kota (add-on/top-up) satın alma için tek seferlik Stripe Checkout Session (mode: "payment") oluşturma parametreleri. */
export interface CreateAddonCheckoutSessionParams {
  /** Her zaman sunucu tarafındaki oturumdan türetilir — istemciden ASLA alınmaz. */
  readonly organizationId: string;
  /** YF-808'in `ensureOrganizationStripeCustomer()`'ından — istemciden ASLA alınmaz. */
  readonly customerId: string;
  /** `lib/billing/addon-catalog.ts` `resolveAddonPrice()`'dan — istemciden ASLA alınmaz. */
  readonly priceId: string;
  readonly addonKey: string;
  readonly successUrl: string;
  readonly cancelUrl: string;
  /** Deterministik (kısa bir pencerede sabit) idempotency anahtarı — bkz. server/services/billing/addon-checkout-service.ts. */
  readonly idempotencyKey: string;
}

/**
 * YF-813 — bir Stripe Checkout Session'ın (tek seferlik `payment` modu)
 * ödeme onayı/köken doğrulaması için YENİDEN ÇEKİLEN (retrieve), yalnızca
 * gereken alanları taşıyan projeksiyonu — ham Stripe nesnesi ASLA dışarı
 * verilmez (bkz. `StripeSubscriptionRef` dosya başı notuyla AYNI ilke).
 * `retrieveSubscription` ile AYNI "her zaman Stripe'tan yeniden çek"
 * stratejisinin add-on tarafındaki karşılığıdır (bkz.
 * server/services/billing/addon-grant-service.ts `confirmAddonCheckoutSession`)
 * — hangi olay/tetikleyici (webhook `checkout.session.completed`/
 * `checkout.session.async_payment_succeeded` veya manuel mutabakat)
 * ÖNEMLİ DEĞİLDİR, karar HER ZAMAN bu taze anlık görüntüye göre verilir.
 */
export interface AddonCheckoutSessionRef {
  readonly id: string;
  readonly mode: string;
  readonly customerId: string | null;
  /** Stripe'ın ham ödeme durumu (`"paid"` | `"unpaid"` | `"no_payment_required"`) — yalnızca `"paid"` bir bağışı TETİKLER (bkz. addon-grant-service.ts). */
  readonly paymentStatus: string;
  /** Oturumun TEK satırının Price ID'si — kataloğa karşı çapraz doğrulama için (bkz. addon-catalog.ts resolveAddonForStripePrice). `null` ise satır kalemi/genişletme başarısız olmuştur. */
  readonly priceId: string | null;
  readonly paymentIntentId: string | null;
  /** `client_reference_id` — ikincil korelasyon (bkz. checkout-service.ts AYNI desen); TEK doğruluk kaynağı DEĞİLDİR. */
  readonly clientReferenceId: string | null;
  /** `metadata.yapifin_addon_key` — ikincil korelasyon; TEK doğruluk kaynağı DEĞİLDİR (bkz. addon-grant-service.ts fiyat çapraz doğrulaması). */
  readonly addonKeyMetadata: string | null;
}

/**
 * YF-814 — Stripe'ın barındırmalı (hosted) Faturalama Portalı (Billing
 * Portal) oturumu için minimal sınır sözleşmesi. Görev talimatı madde 7:
 * YF-811 (tam Customer Portal) BU görevde İNŞA EDİLMEZ — bu yalnızca "ödeme
 * yöntemini güncelle/faturaları görüntüle" CTA'sı için GÜVENLİ, MİNİMAL bir
 * entegrasyon sınırıdır (tek Stripe API çağrısı, ikinci bir portal
 * mimarisi İCAT EDİLMEZ). YF-811 ileride kendi kapsamını (yapılandırma
 * yönetimi, dahili portal ekranları vb.) bu TEK gateway metodunun ÜZERİNE
 * inşa edebilir.
 */
export interface CreateBillingPortalSessionParams {
  /** YF-808'in `ensureOrganizationStripeCustomer()`'ından — istemciden ASLA alınmaz. */
  readonly customerId: string;
  /** Kullanıcının portaldan döneceği, sunucu tarafında üretilen güvenilir URL — istemciden ASLA alınmaz. */
  readonly returnUrl: string;
}

export interface StripeBillingPortalSessionRef {
  /** Kullanıcının yönlendirileceği Stripe barındırmalı Faturalama Portalı sayfası. */
  readonly url: string;
}

/**
 * YF-810 — Domain'e dönen tek Stripe Subscription temsili — ham Stripe
 * nesnesi ASLA dışarı verilmez. Yalnızca yerel senkronizasyon
 * (`server/services/billing/webhook-service.ts`) için gereken alanlar
 * taşınır.
 *
 * **Dönem tarihleri (`currentPeriodStart`/`End`) Stripe'ın "Basil" API
 * sürümünden (2025-03-31) BERİ abonelik NESNESİNİN kendisinde DEĞİL, İLK
 * abonelik kalemindedir** (`subscription.items.data[0].current_period_*`)
 * — bkz. Stripe değişiklik günlüğü "deprecate subscription current period
 * start and end". Bu sınır dosyası bu ayrımı TEK yerde uygular; domain
 * katmanı bu ayrıntıyı bilmek ZORUNDA DEĞİLDİR (bkz. dosya başı "Stripe SDK'sı
 * yalnızca bu dosyadan import edilir" kuralı). Kendi kendine satın alma
 * akışımız her zaman TEK bir fiyat kalemi oluşturduğundan (bkz.
 * checkout-service.ts `line_items: [{ price, quantity: 1 }]`) ilk kalem her
 * zaman YETERLİ ve DOĞRUdur.
 */
export interface StripeSubscriptionRef {
  readonly id: string;
  readonly customerId: string;
  /** Stripe'ın ham durum dizesi (ör. "active", "past_due") — yerel `StripeSubscriptionStatus` enum'una çevirme sorumluluğu ÇAĞIRANDADIR (bkz. webhook-service.ts), bu sınır dosyası bir Prisma tipini İÇE AKTARMAZ. */
  readonly status: string;
  readonly cancelAtPeriodEnd: boolean;
  /** İlk (ve kendi-kendine akışımızda TEK) abonelik kaleminin Price ID'si; kalem yoksa `null`. */
  readonly priceId: string | null;
  /** Unix saniye — ilk abonelik kaleminden (bkz. yukarıdaki dosya notu). */
  readonly currentPeriodStart: number | null;
  readonly currentPeriodEnd: number | null;
  readonly trialStart: number | null;
  readonly trialEnd: number | null;
  readonly canceledAt: number | null;
  readonly endedAt: number | null;
}

/**
 * YF-815 — Domain'e dönen tek Stripe Refund (iade) temsili — ham Stripe
 * nesnesi ASLA dışarı verilmez. `retrieveSubscription`/
 * `retrieveCheckoutSessionForAddon` ile AYNI "her zaman Stripe'tan yeniden
 * çek" stratejisinin iade tarafındaki karşılığıdır (bkz.
 * server/services/billing/refund-service.ts).
 */
export interface StripeRefundRef {
  readonly id: string;
  /** Stripe'ın ham durum dizesi ("pending"|"requires_action"|"succeeded"|"failed"|"canceled") — yerel `StripeRefundStatus` enum'una çevirme sorumluluğu ÇAĞIRANDADIR (bkz. refund-service.ts `toRefundStatus`). */
  readonly status: string;
  /** En küçük para birimi biriminde (Stripe kuruş/cent tabanlıdır). */
  readonly amount: number;
  readonly currency: string;
  readonly chargeId: string | null;
  readonly paymentIntentId: string | null;
  readonly customerId: string | null;
  readonly reason: string | null;
  /** Unix saniye — `refund.created`. */
  readonly createdAt: number;
}

/**
 * YF-815 — bir Stripe Charge'ın YALNIZCA iade politikası kararı için gereken
 * minimal projeksiyonu (`amountRefunded`/`refunded` — bir iadenin charge'ı
 * TAM mı KISMİ mi karşıladığını belirlemek için, bkz.
 * server/services/billing/refund-service.ts "Case A/B/C" ayrımı). Refund
 * nesnesinin kendisi yalnızca KENDİ tutarını taşır, charge'ın TOPLAM
 * durumunu taşımaz — bu yüzden ayrı bir yeniden-çekim gereklidir.
 */
export interface StripeChargeRef {
  readonly id: string;
  readonly amount: number;
  readonly amountRefunded: number;
  readonly refunded: boolean;
  readonly paymentIntentId: string | null;
  readonly customerId: string | null;
}

/**
 * YF-815 — Domain'e dönen tek Stripe Dispute (uyuşmazlık/chargeback) temsili
 * — ham Stripe nesnesi ASLA dışarı verilmez. `StripeRefundRef` ile AYNI
 * "her zaman Stripe'tan yeniden çek" stratejisi (bkz.
 * server/services/billing/dispute-service.ts).
 *
 * **`customerId`** — Stripe'ın `Dispute` nesnesi doğrudan bir `customer`
 * alanı TAŞIMAZ (yalnızca `charge`/`payment_intent`); bu alan gateway
 * tarafından `charge` GENİŞLETİLEREK (`expand: ["charge"]`) TEK bir istekte
 * çözülür (bkz. `createRealStripeGateway` `retrieveDispute` — ikinci bir ağ
 * çağrısı İCAT EDİLMEZ).
 */
export interface StripeDisputeRef {
  readonly id: string;
  /** Stripe'ın ham durum dizesi — yerel `StripeDisputeStatus` enum'una çevirme sorumluluğu ÇAĞIRANDADIR (bkz. dispute-service.ts `toDisputeStatus`). */
  readonly status: string;
  readonly amount: number;
  readonly currency: string;
  readonly chargeId: string;
  readonly paymentIntentId: string | null;
  readonly customerId: string | null;
  /** Stripe'ın ham uyuşmazlık nedeni ("fraudulent"|"duplicate"|... ). */
  readonly reason: string;
  /** Unix saniye — `dispute.created`. */
  readonly createdAt: number;
}

/**
 * YF-810 — imza doğrulanmış bir Stripe webhook olayının Domain'e dönen
 * projeksiyonu. Ham Stripe `Event`/`data.object` nesnesi bu sınırın DIŞINA
 * ASLA taşınmaz — yalnızca ilgili olay türü için gereken, önceden
 * çıkarılmış (extract edilmiş) kısa/sır İÇERMEYEN alanlar taşınır
 * (`kind` ile ayırt edilen union). Bilinmeyen/ele alınmayan bir olay türü
 * `UNHANDLED` olarak projekte edilir — çağıran bunu güvenle yok sayabilir.
 */
export type StripeWebhookEventRef =
  | {
      readonly kind: "SUBSCRIPTION";
      readonly id: string;
      readonly type: string;
      /** Unix saniye — `event.created` (sıra-dışı/out-of-order gözlemlenebilirliği içindir, bkz. webhook-service.ts). */
      readonly createdAt: number;
      readonly subscriptionId: string;
      readonly customerId: string;
    }
  | {
      readonly kind: "INVOICE";
      readonly id: string;
      readonly type: string;
      readonly createdAt: number;
      /** Fatura bir aboneliğe bağlı DEĞİLSE `null` (ör. tek seferlik fatura) — bu durumda webhook-service.ts olayı YOK SAYAR. */
      readonly subscriptionId: string | null;
      readonly customerId: string | null;
      readonly invoiceId: string;
      /** En küçük para birimi biriminde (Stripe kuruş/cent tabanlıdır) — YALNIZCA denetim/teşhis için taşınır, hiçbir proje/muhasebe kaydına AKTARILMAZ (bkz. görev talimatı "do not feed SaaS billing invoices into construction project financial ledgers"). */
      readonly amountDue: number;
      readonly currency: string;
    }
  | {
      readonly kind: "CHECKOUT_SESSION";
      readonly id: string;
      readonly type: string;
      readonly createdAt: number;
      readonly subscriptionId: string | null;
      readonly customerId: string | null;
      readonly checkoutSessionId: string;
    }
  | {
      readonly kind: "REFUND";
      readonly id: string;
      readonly type: string;
      readonly createdAt: number;
      readonly refundId: string;
      /** `Refund.customer` doğrudan mevcuttur (Dispute'un aksine) — ek bir ağ çağrısı GEREKMEZ. */
      readonly customerId: string | null;
    }
  | {
      readonly kind: "DISPUTE";
      readonly id: string;
      readonly type: string;
      readonly createdAt: number;
      readonly disputeId: string;
      // Kasıtlı olarak `customerId` YOK — bkz. `StripeDisputeRef` dosya başı
      // notu (Dispute nesnesi doğrudan customer taşımaz). Tenant çözümlemesi
      // `server/services/billing/dispute-service.ts` içinde,
      // `gateway.retrieveDispute()` ile TEK bir yeniden-çekim çağrısında
      // yapılır (bkz. o dosyanın dosya başı notu).
    }
  | {
      readonly kind: "UNHANDLED";
      readonly id: string;
      readonly type: string;
      readonly createdAt: number;
    };

export interface StripeGateway {
  readonly environment: StripeEnvironment;
  createCustomer(params: CreateStripeCustomerParams): Promise<StripeCustomerRef>;
  /** Bulunamazsa `null` döner (hata fırlatmaz) — çağıran fail-closed kararını kendisi verir. */
  retrieveCustomer(customerId: string): Promise<StripeCustomerRef | null>;
  /** YF-809 — kendi kendine satın alma için Stripe Checkout Session (subscription modu) oluşturur. */
  createCheckoutSession(params: CreateCheckoutSessionParams): Promise<StripeCheckoutSessionRef>;
  /** YF-813 — kullanım/ek-kota (add-on/top-up) satın alma için Stripe Checkout Session (tek seferlik `payment` modu) oluşturur. */
  createAddonCheckoutSession(params: CreateAddonCheckoutSessionParams): Promise<StripeCheckoutSessionRef>;
  /**
   * YF-813 — bir add-on Checkout Session'ını Stripe'tan YENİDEN ÇEKER
   * (satır kalemi/ödeme durumu/payment intent dahil, bkz. `AddonCheckoutSessionRef`
   * dosya başı notu). Bulunamazsa `null` döner (hata fırlatmaz).
   */
  retrieveCheckoutSessionForAddon(sessionId: string): Promise<AddonCheckoutSessionRef | null>;
  /**
   * YF-810 — Stripe'tan aboneliğin GÜNCEL (anlık) durumunu yeniden çeker.
   * **Sıra-dışı (out-of-order) webhook koruma stratejimizin TEMELİDİR** (bkz.
   * server/services/billing/webhook-service.ts dosya başı not): hangi olay
   * tetiklediği ÖNEMLİ DEĞİLDİR, bu her zaman Stripe'ın O ANKİ gerçeğini
   * döner — böylece geç/sıra-dışı teslim edilen bir olayın işlenmesi dahi
   * yerel durumu asla ESKİ bir anlık görüntüyle EZEMEZ. Bulunamazsa `null`
   * döner (hata fırlatmaz).
   */
  retrieveSubscription(subscriptionId: string): Promise<StripeSubscriptionRef | null>;
  /**
   * YF-810 — bir Stripe müşterisinin aboneliklerini listeler (en yeni
   * önce). YALNIZCA mutabakat (`reconcileOrganizationStripeSubscription`)
   * için kullanılır — normal webhook akışı bunu ÇAĞIRMAZ (bkz.
   * webhook-service.ts).
   */
  listSubscriptionsForCustomer(customerId: string, limit?: number): Promise<readonly StripeSubscriptionRef[]>;
  /**
   * YF-815 — Stripe'tan bir iadenin GÜNCEL (anlık) durumunu yeniden çeker
   * (bkz. `StripeRefundRef` dosya başı notu — `retrieveSubscription` ile
   * AYNI refetch-on-write stratejisi). Bulunamazsa `null` döner (hata
   * FIRLATMAZ).
   */
  retrieveRefund(refundId: string): Promise<StripeRefundRef | null>;
  /**
   * YF-815 — YALNIZCA bir iadenin karşıladığı charge'ın TAM mı KISMİ mi
   * karşılandığını belirlemek için (bkz. `StripeChargeRef` dosya başı notu).
   * Bulunamazsa `null` döner (hata FIRLATMAZ).
   */
  retrieveCharge(chargeId: string): Promise<StripeChargeRef | null>;
  /**
   * YF-815 — Stripe'tan bir uyuşmazlığın GÜNCEL (anlık) durumunu yeniden
   * çeker; `customerId`'yi TEK istekte çözmek için `charge` GENİŞLETİLİR
   * (bkz. `StripeDisputeRef` dosya başı notu). Bulunamazsa `null` döner
   * (hata FIRLATMAZ).
   */
  retrieveDispute(disputeId: string): Promise<StripeDisputeRef | null>;
  /**
   * YF-814 — Stripe barındırmalı Faturalama Portalı oturumu oluşturur (bkz.
   * `CreateBillingPortalSessionParams` dosya başı notu — YF-811'in minimal
   * ön-koşulu, tam portal mimarisi İCAT EDİLMEZ). Yalnızca "ödeme
   * yöntemini güncelle" CTA'sı için kullanılır.
   */
  createBillingPortalSession(params: CreateBillingPortalSessionParams): Promise<StripeBillingPortalSessionRef>;
  /**
   * YF-810 — ham istek gövdesini (RAW — asla önceden ayrıştırılmış/yeniden
   * serileştirilmiş OLMAMALIDIR, bkz. app/api/billing/stripe/webhook/route.ts)
   * `stripe-signature` başlığına karşı doğrular. İmza geçersiz/eksikse
   * `BillingProviderError` (`category: "WEBHOOK_SIGNATURE_INVALID"`) fırlatır
   * — çağıran bunu HTTP 400 ile eşler, hiçbir işlem YAPILMAZ.
   */
  constructWebhookEvent(payload: string | Buffer, signatureHeader: string, webhookSecret: string): StripeWebhookEventRef;
}

/**
 * Ağ hatalarında sınırlı otomatik yeniden deneme. Stripe SDK'sı yeniden
 * denemelerde AYNI idempotency anahtarını kullanır, dolayısıyla bu tekrar
 * müşteri OLUŞTURMAZ.
 */
const MAX_NETWORK_RETRIES = 2;
const REQUEST_TIMEOUT_MS = 15000;

/** Stripe hata tipi/kodunu sağlayıcı-nötr kategoriye çevirir. Ham mesaj ASLA taşınmaz. */
function categorizeStripeError(err: unknown): { category: BillingErrorCategory; providerCode?: string } {
  // YF-810 — imza doğrulama hatası, genel `StripeError` switch'inden ÖNCE
  // ayrıca ele alınır: `err.type` bu sınıf için diğer sağlayıcı hatalarıyla
  // AYNI anlamlı değeri TAŞIMAZ (bkz. Stripe SDK'sı `Webhooks.js`
  // `constructEvent`) — burada özel olarak eşlenmezse yanlışlıkla `UNKNOWN`'a
  // düşerdi.
  if (err instanceof Stripe.errors.StripeSignatureVerificationError) {
    return { category: "WEBHOOK_SIGNATURE_INVALID" };
  }
  if (!(err instanceof Stripe.errors.StripeError)) {
    return { category: "UNKNOWN" };
  }

  const providerCode = typeof err.code === "string" ? err.code : undefined;

  if (providerCode === "idempotency_key_in_use") {
    return { category: "IDEMPOTENCY_CONFLICT", providerCode };
  }

  switch (err.type) {
    case "StripeAuthenticationError":
    case "StripePermissionError":
      return { category: "AUTH_CONFIG", providerCode };
    case "StripeRateLimitError":
      return { category: "RATE_LIMIT", providerCode };
    case "StripeConnectionError":
      return { category: "TIMEOUT_NETWORK", providerCode };
    case "StripeAPIError":
      return { category: "TEMPORARY_PROVIDER", providerCode };
    case "StripeIdempotencyError":
      return { category: "IDEMPOTENCY_CONFLICT", providerCode };
    case "StripeInvalidRequestError":
      return { category: "VALIDATION", providerCode };
    case "StripeCardError":
      return { category: "PERMANENT_REJECTION", providerCode };
    default:
      return { category: "UNKNOWN", providerCode };
  }
}

/**
 * Kategoriye göre SABİT, güvenli Türkçe mesaj. Stripe'ın kendi `message`'ı
 * bilinçli olarak KULLANILMAZ — sağlayıcı iç detayı/sır sızdırmaması garanti
 * altına alınır (görev talimatı "Never leak raw Stripe error internals").
 */
const SAFE_MESSAGE_BY_CATEGORY: Record<BillingErrorCategory, string> = {
  AUTH_CONFIG: "Ödeme sağlayıcısı kimlik doğrulaması başarısız oldu (yapılandırma hatası).",
  VALIDATION: "Ödeme sağlayıcısı isteği geçersiz bularak reddetti.",
  TEMPORARY_PROVIDER: "Ödeme sağlayıcısı geçici bir hata döndürdü, lütfen daha sonra tekrar deneyin.",
  RATE_LIMIT: "Ödeme sağlayıcısı istek sınırına ulaşıldı, lütfen daha sonra tekrar deneyin.",
  TIMEOUT_NETWORK: "Ödeme sağlayıcısına ulaşılamadı (ağ/zaman aşımı).",
  PERMANENT_REJECTION: "Ödeme sağlayıcısı isteği kalıcı olarak reddetti.",
  IDEMPOTENCY_CONFLICT: "Aynı faturalama işlemi şu anda başka bir istek tarafından yürütülüyor.",
  WEBHOOK_SIGNATURE_INVALID: "Webhook imzası doğrulanamadı.",
  UNKNOWN: "Ödeme sağlayıcısı işlemi sınıflandırılmamış bir nedenle başarısız oldu.",
};

/**
 * Herhangi bir Stripe SDK hatasını sınır sözleşmesinin tek hata tipine çevirir.
 * Sınır dışına export edilir çünkü ileride eklenecek diğer Stripe çağrı
 * noktaları (ör. webhook doğrulama) AYNI çeviriyi yeniden yazmak yerine bunu
 * kullanmalıdır — sağlayıcı hata sızıntısı tek yerde engellenir.
 */
export function toBillingProviderError(err: unknown): BillingProviderError {
  const { category, providerCode } = categorizeStripeError(err);
  return new BillingProviderError(SAFE_MESSAGE_BY_CATEGORY[category], category, providerCode, { cause: err });
}

let cachedClient: { secretKey: string; client: Stripe } | null = null;

function getStripeClient(secretKey: string): Stripe {
  if (cachedClient && cachedClient.secretKey === secretKey) return cachedClient.client;
  const client = new Stripe(secretKey, {
    maxNetworkRetries: MAX_NETWORK_RETRIES,
    timeout: REQUEST_TIMEOUT_MS,
    telemetry: false,
  });
  cachedClient = { secretKey, client };
  return client;
}

/**
 * YF-810 — ham bir Stripe `Subscription` nesnesini sınır sözleşmesinin
 * `StripeSubscriptionRef` temsiline projekte eder (bkz. `StripeSubscriptionRef`
 * dosya başı notu — dönem tarihleri İLK abonelik kaleminden okunur).
 */
function toSubscriptionRef(sub: Stripe.Subscription): StripeSubscriptionRef {
  const item = sub.items.data[0];
  return {
    id: sub.id,
    customerId: typeof sub.customer === "string" ? sub.customer : sub.customer.id,
    status: sub.status,
    cancelAtPeriodEnd: sub.cancel_at_period_end,
    priceId: item?.price?.id ?? null,
    currentPeriodStart: item?.current_period_start ?? null,
    currentPeriodEnd: item?.current_period_end ?? null,
    trialStart: sub.trial_start,
    trialEnd: sub.trial_end,
    canceledAt: sub.canceled_at,
    endedAt: sub.ended_at,
  };
}

/**
 * YF-810 — `invoice.parent.subscription_details.subscription`'dan abonelik
 * ID'sini çıkarır. Stripe'ın "Basil" API sürümünden BERİ `Invoice.subscription`
 * ALAN OLARAK MEVCUT DEĞİLDİR (yalnızca liste/oluşturma parametresi olarak
 * kalmıştır) — bkz. `StripeSubscriptionRef` dosya başı notuyla AYNI API
 * sürümü değişikliği ailesi.
 */
function extractInvoiceSubscriptionId(invoice: Stripe.Invoice): string | null {
  const parent = invoice.parent;
  if (!parent || parent.type !== "subscription_details" || !parent.subscription_details) return null;
  const sub = parent.subscription_details.subscription;
  if (!sub) return null;
  return typeof sub === "string" ? sub : sub.id;
}

/** YF-815 — ham bir Stripe `Refund` nesnesini `StripeRefundRef`'e projekte eder (bkz. o tipin dosya başı notu). */
function toRefundRef(refund: Stripe.Refund): StripeRefundRef {
  return {
    id: refund.id,
    status: refund.status ?? "unknown",
    amount: refund.amount,
    currency: refund.currency,
    chargeId: typeof refund.charge === "string" ? refund.charge : (refund.charge?.id ?? null),
    paymentIntentId:
      typeof refund.payment_intent === "string" ? refund.payment_intent : (refund.payment_intent?.id ?? null),
    customerId: typeof refund.customer === "string" ? refund.customer : (refund.customer?.id ?? null),
    reason: refund.reason ?? null,
    createdAt: refund.created,
  };
}

/** YF-815 — ham bir Stripe `Charge` nesnesini `StripeChargeRef`'e projekte eder (bkz. o tipin dosya başı notu). */
function toChargeRef(charge: Stripe.Charge): StripeChargeRef {
  return {
    id: charge.id,
    amount: charge.amount,
    amountRefunded: charge.amount_refunded,
    refunded: charge.refunded,
    paymentIntentId:
      typeof charge.payment_intent === "string" ? charge.payment_intent : (charge.payment_intent?.id ?? null),
    customerId: typeof charge.customer === "string" ? charge.customer : (charge.customer?.id ?? null),
  };
}

/**
 * YF-815 — ham bir Stripe `Dispute` nesnesini `StripeDisputeRef`'e projekte
 * eder (bkz. o tipin dosya başı notu — `customerId`, ÇAĞIRANIN `charge`'ı
 * `expand: ["charge"]` ile genişletmiş OLMASINI gerektirir; genişletilmemişse
 * `customerId` her zaman `null` döner, ikinci bir ağ çağrısı burada
 * YAPILMAZ).
 */
function toDisputeRef(dispute: Stripe.Dispute): StripeDisputeRef {
  const charge = dispute.charge;
  const chargeId = typeof charge === "string" ? charge : charge.id;
  const customerId =
    typeof charge === "string"
      ? null
      : typeof charge.customer === "string"
        ? charge.customer
        : (charge.customer?.id ?? null);
  return {
    id: dispute.id,
    status: dispute.status,
    amount: dispute.amount,
    currency: dispute.currency,
    chargeId,
    paymentIntentId:
      typeof dispute.payment_intent === "string" ? dispute.payment_intent : (dispute.payment_intent?.id ?? null),
    customerId,
    reason: dispute.reason,
    createdAt: dispute.created,
  };
}

/**
 * YF-810 — imza doğrulanmış bir Stripe `Event`'i `StripeWebhookEventRef`'e
 * projekte eder (bkz. o tipin dosya başı notu — ham `Event`/`data.object`
 * bu fonksiyon DIŞINA taşınmaz). Ele alınan olay türleri
 * `docs/architecture/YF-810_STRIPE_SUBSCRIPTION_LIFECYCLE.md`'de listelenir;
 * burada eksik bir `case`, olayı güvenle `UNHANDLED` yapar (fail-closed
 * DEĞİL — yalnızca "bu olay türü için bir eylemimiz yok" anlamına gelir;
 * webhook route'u yine de 200 döner ki Stripe GEREKSİZ yere yeniden
 * denemesin).
 */
function projectWebhookEvent(event: Stripe.Event): StripeWebhookEventRef {
  const base = { id: event.id, type: event.type, createdAt: event.created };

  switch (event.type) {
    case "customer.subscription.created":
    case "customer.subscription.updated":
    case "customer.subscription.deleted":
    case "customer.subscription.paused":
    case "customer.subscription.resumed": {
      const sub = event.data.object;
      return {
        ...base,
        kind: "SUBSCRIPTION",
        subscriptionId: sub.id,
        customerId: typeof sub.customer === "string" ? sub.customer : sub.customer.id,
      };
    }
    case "invoice.payment_succeeded":
    case "invoice.payment_failed": {
      const invoice = event.data.object;
      return {
        ...base,
        kind: "INVOICE",
        subscriptionId: extractInvoiceSubscriptionId(invoice),
        customerId: typeof invoice.customer === "string" ? invoice.customer : (invoice.customer?.id ?? null),
        invoiceId: invoice.id ?? "",
        amountDue: invoice.amount_due,
        currency: invoice.currency,
      };
    }
    case "checkout.session.completed":
    // YF-813 — gecikmeli bildirimli ödeme yöntemleri (ör. bazı banka
    // transferleri) için: `checkout.session.completed` bu durumda
    // `payment_status="unpaid"` ile HEMEN ateşlenir, gerçek ödeme onayı
    // SONRA bu olayla gelir. İki olay da AYNI CHECKOUT_SESSION projeksiyonunu
    // kullanır — asıl "ödendi mi" kararı (bkz. addon-grant-service.ts
    // `confirmAddonCheckoutSession`) HER ZAMAN Stripe'tan YENİDEN ÇEKİLEN
    // güncel `payment_status`'a bakar, bu olayın türüne DEĞİL (Stripe'ın
    // resmi "fulfill orders" rehberiyle AYNI desen).
    case "checkout.session.async_payment_succeeded": {
      const session = event.data.object;
      return {
        ...base,
        kind: "CHECKOUT_SESSION",
        subscriptionId:
          typeof session.subscription === "string" ? session.subscription : (session.subscription?.id ?? null),
        customerId: typeof session.customer === "string" ? session.customer : (session.customer?.id ?? null),
        checkoutSessionId: session.id,
      };
    }
    // YF-815 — `refund.*` olayları (`refund.created`/`refund.updated`/
    // `refund.failed`) TERCİH EDİLEN kaynaktır (Stripe'ın kendi olay
    // açıklaması: "Listen to refund.created for information about the
    // refund"). Eski `charge.refunded`/`charge.refund.updated` (Charge/Refund
    // nesnesi farklı taşır, seçili ödeme yöntemleriyle sınırlı) KASITLI
    // olarak ele ALINMAZ — bu API sürümünde (`2026-07-29.dahlia`) `refund.*`
    // ailesi TÜM ödeme yöntemlerini kapsar (bkz. görev talimatı "Do not
    // blindly use event names from older Stripe API versions").
    case "refund.created":
    case "refund.updated":
    case "refund.failed": {
      const refund = event.data.object;
      return {
        ...base,
        kind: "REFUND",
        refundId: refund.id,
        customerId: typeof refund.customer === "string" ? refund.customer : (refund.customer?.id ?? null),
      };
    }
    // YF-815 — `charge.dispute.funds_withdrawn`/`charge.dispute.funds_reinstated`
    // KASITLI olarak ele ALINMAZ (görev talimatı minimum kapsamı: created/
    // updated/closed) — ikisi de `charge.dispute.updated` ile AYNI `Dispute`
    // anlık görüntüsünü taşır; genişletme noktası budur (gerekirse buraya
    // eklenir, `dispute-service.ts` ZATEN refetch-on-write olduğundan
    // davranış DEĞİŞMEZ, yalnızca daha ERKEN bir bildirim sağlar).
    case "charge.dispute.created":
    case "charge.dispute.updated":
    case "charge.dispute.closed": {
      const dispute = event.data.object;
      return { ...base, kind: "DISPUTE", disputeId: dispute.id };
    }
    default:
      return { ...base, kind: "UNHANDLED" };
  }
}

function createRealStripeGateway(): StripeGateway {
  // Yapılandırma burada çözülür — modül yüklenirken DEĞİL. Böylece Stripe
  // yapılandırılmamışken ilgisiz route'lar etkilenmez (fail-closed yalnızca
  // gerçek kullanımda).
  const config = getStripeConfig();
  const client = getStripeClient(config.secretKey);

  return {
    environment: config.environment,

    async createCustomer(params: CreateStripeCustomerParams): Promise<StripeCustomerRef> {
      try {
        const customer = await client.customers.create(
          {
            name: params.name,
            ...(params.email ? { email: params.email } : {}),
            /**
             * Metadata yalnızca **mutabakat/destek** amaçlıdır (Stripe
             * panelinden hangi organizasyona ait olduğunun görülebilmesi).
             * Çalışma zamanında ASLA okunmaz ve hiçbir yetki/erişim kararında
             * kullanılmaz — kanonik eşleme veritabanındaki
             * `OrganizationStripeCustomer` satırıdır.
             */
            metadata: {
              yapifin_organization_id: params.organizationId,
              yapifin_stripe_environment: config.environment,
            },
          },
          { idempotencyKey: params.idempotencyKey },
        );
        return { id: customer.id };
      } catch (err) {
        throw toBillingProviderError(err);
      }
    },

    async retrieveCustomer(customerId: string): Promise<StripeCustomerRef | null> {
      try {
        const customer = await client.customers.retrieve(customerId);
        if (customer.deleted) return null;
        return { id: customer.id };
      } catch (err) {
        const billingError = toBillingProviderError(err);
        if (billingError.providerCode === "resource_missing") return null;
        throw billingError;
      }
    },

    async createCheckoutSession(params: CreateCheckoutSessionParams): Promise<StripeCheckoutSessionRef> {
      try {
        /**
         * Korelasyon metadata'sı — YF-810 webhook senkronizasyonunun
         * `checkout.session.completed`/`customer.subscription.*` olaylarını
         * organizasyona/plana/aralığa güvenle bağlayabilmesi içindir. Yalnızca
         * kısa, sır OLMAYAN tanımlayıcılar (bkz. görev talimatı "Never put
         * secrets or sensitive PII in metadata"). Çalışma zamanında hiçbir
         * yetki/erişim kararında OKUNMAZ (bkz. lib/billing/stripe-config.ts
         * dosya başı mimari sözleşme notu).
         */
        const correlationMetadata = {
          yapifin_organization_id: params.organizationId,
          yapifin_plan_code: params.planCode,
          yapifin_billing_interval: params.billingInterval,
          yapifin_stripe_environment: config.environment,
        };

        const session = await client.checkout.sessions.create(
          {
            mode: "subscription",
            customer: params.customerId,
            // YF-810 için ikincil korelasyon alanı (Stripe'ın önerdiği desen).
            client_reference_id: params.organizationId,
            line_items: [{ price: params.priceId, quantity: 1 }],
            success_url: params.successUrl,
            cancel_url: params.cancelUrl,
            allow_promotion_codes: params.allowPromotionCodes,
            metadata: correlationMetadata,
            // Abonelik oluşunca metadata'nın Subscription nesnesine de
            // taşınması için — checkout.session.completed KAÇIRILSA bile
            // customer.subscription.* olaylarından aynı korelasyon okunabilir.
            subscription_data: {
              metadata: correlationMetadata,
              // YF-809 — deneme süresi kasıtlı olarak AYARLANMAZ (görev
              // talimatı madde 8: uydurma bir süre İCAT EDİLMEZ). Merkezi bir
              // deneme politikası tanımlanırsa buraya `trial_period_days`
              // eklenecek TEK genişletme noktası burasıdır.
            },
          },
          { idempotencyKey: params.idempotencyKey },
        );

        if (!session.url) {
          // Stripe normalde her zaman bir url döner; savunma amaçlı ikinci kontrol.
          throw new BillingProviderError(
            "Ödeme sağlayıcısı ödeme sayfası bağlantısı döndürmedi.",
            "UNKNOWN",
          );
        }

        return { id: session.id, url: session.url, expiresAt: session.expires_at };
      } catch (err) {
        if (err instanceof BillingProviderError) throw err;
        throw toBillingProviderError(err);
      }
    },

    async createAddonCheckoutSession(params: CreateAddonCheckoutSessionParams): Promise<StripeCheckoutSessionRef> {
      try {
        /**
         * YF-813 — korelasyon metadata'sı, checkout-service.ts `createCheckoutSession`
         * ile AYNI gerekçe: yalnızca kısa, sır OLMAYAN tanımlayıcılar, hiçbir
         * yetki/erişim/bağış kararında TEK BAŞINA OKUNMAZ (bkz.
         * server/services/billing/addon-grant-service.ts fiyat çapraz
         * doğrulaması — metadata yalnızca hangi katalog girdisinin
         * DENENECEĞİNİ işaret eder, gerçek fiyat/miktar HER ZAMAN kataloğun
         * kendisinden ve Stripe'ın gerçekten faturaladığı Price'tan gelir).
         */
        const correlationMetadata = {
          yapifin_organization_id: params.organizationId,
          yapifin_addon_key: params.addonKey,
          yapifin_stripe_environment: config.environment,
        };

        const session = await client.checkout.sessions.create(
          {
            mode: "payment",
            customer: params.customerId,
            client_reference_id: params.organizationId,
            line_items: [{ price: params.priceId, quantity: 1 }],
            success_url: params.successUrl,
            cancel_url: params.cancelUrl,
            metadata: correlationMetadata,
            payment_intent_data: { metadata: correlationMetadata },
          },
          { idempotencyKey: params.idempotencyKey },
        );

        if (!session.url) {
          throw new BillingProviderError("Ödeme sağlayıcısı ödeme sayfası bağlantısı döndürmedi.", "UNKNOWN");
        }

        return { id: session.id, url: session.url, expiresAt: session.expires_at };
      } catch (err) {
        if (err instanceof BillingProviderError) throw err;
        throw toBillingProviderError(err);
      }
    },

    async retrieveCheckoutSessionForAddon(sessionId: string): Promise<AddonCheckoutSessionRef | null> {
      try {
        const session = await client.checkout.sessions.retrieve(sessionId, {
          expand: ["line_items", "payment_intent"],
        });
        const lineItem = session.line_items?.data[0];
        const priceId = lineItem?.price?.id ?? null;
        const paymentIntentId =
          typeof session.payment_intent === "string" ? session.payment_intent : (session.payment_intent?.id ?? null);
        const addonKeyMetadata =
          typeof session.metadata?.yapifin_addon_key === "string" ? session.metadata.yapifin_addon_key : null;

        return {
          id: session.id,
          mode: session.mode,
          customerId: typeof session.customer === "string" ? session.customer : (session.customer?.id ?? null),
          paymentStatus: session.payment_status,
          priceId,
          paymentIntentId,
          clientReferenceId: session.client_reference_id ?? null,
          addonKeyMetadata,
        };
      } catch (err) {
        const billingError = toBillingProviderError(err);
        if (billingError.providerCode === "resource_missing") return null;
        throw billingError;
      }
    },

    async retrieveSubscription(subscriptionId: string): Promise<StripeSubscriptionRef | null> {
      try {
        const sub = await client.subscriptions.retrieve(subscriptionId);
        return toSubscriptionRef(sub);
      } catch (err) {
        const billingError = toBillingProviderError(err);
        if (billingError.providerCode === "resource_missing") return null;
        throw billingError;
      }
    },

    async listSubscriptionsForCustomer(customerId: string, limit = 3): Promise<readonly StripeSubscriptionRef[]> {
      try {
        const page = await client.subscriptions.list({ customer: customerId, status: "all", limit });
        return page.data.map(toSubscriptionRef);
      } catch (err) {
        throw toBillingProviderError(err);
      }
    },

    async retrieveRefund(refundId: string): Promise<StripeRefundRef | null> {
      try {
        const refund = await client.refunds.retrieve(refundId);
        return toRefundRef(refund);
      } catch (err) {
        const billingError = toBillingProviderError(err);
        if (billingError.providerCode === "resource_missing") return null;
        throw billingError;
      }
    },

    async retrieveCharge(chargeId: string): Promise<StripeChargeRef | null> {
      try {
        const charge = await client.charges.retrieve(chargeId);
        return toChargeRef(charge);
      } catch (err) {
        const billingError = toBillingProviderError(err);
        if (billingError.providerCode === "resource_missing") return null;
        throw billingError;
      }
    },

    async retrieveDispute(disputeId: string): Promise<StripeDisputeRef | null> {
      try {
        const dispute = await client.disputes.retrieve(disputeId, { expand: ["charge"] });
        return toDisputeRef(dispute);
      } catch (err) {
        const billingError = toBillingProviderError(err);
        if (billingError.providerCode === "resource_missing") return null;
        throw billingError;
      }
    },

    async createBillingPortalSession(params: CreateBillingPortalSessionParams): Promise<StripeBillingPortalSessionRef> {
      try {
        const session = await client.billingPortal.sessions.create({
          customer: params.customerId,
          return_url: params.returnUrl,
        });
        return { url: session.url };
      } catch (err) {
        throw toBillingProviderError(err);
      }
    },

    constructWebhookEvent(payload: string | Buffer, signatureHeader: string, webhookSecret: string): StripeWebhookEventRef {
      let event: Stripe.Event;
      try {
        event = client.webhooks.constructEvent(payload, signatureHeader, webhookSecret);
      } catch (err) {
        throw toBillingProviderError(err);
      }
      return projectWebhookEvent(event);
    },
  };
}

let testGateway: StripeGateway | null = null;

/**
 * Domain katmanının kullandığı TEK çözümleme noktası. Testlerde takılmış bir
 * sahte gateway varsa onu, yoksa gerçek Stripe SDK sarmalayıcısını döner
 * (bkz. server/services/integrations/provider-registry.ts aynı desen).
 */
export function resolveStripeGateway(): StripeGateway {
  return testGateway ?? createRealStripeGateway();
}

/** YALNIZCA testler içindir — gerçek Stripe kimlik bilgisi olmadan sınırın uçtan uca doğrulanmasını sağlar. Üretim kod yolunun hiçbir yerinden çağrılmaz. */
export function setStripeGatewayForTests(gateway: StripeGateway): void {
  testGateway = gateway;
}

/** YALNIZCA testler içindir — `afterEach`'te çağrılarak override'ların sonraki testlere sızmasını engeller. */
export function resetStripeGatewayForTests(): void {
  testGateway = null;
}
