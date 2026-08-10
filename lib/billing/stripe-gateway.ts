import Stripe from "stripe";
import type { StripeEnvironment } from "@prisma/client";
import { BillingProviderError, type BillingErrorCategory } from "@/lib/billing/errors";
import { getStripeConfig } from "@/lib/billing/stripe-config";

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

export interface StripeGateway {
  readonly environment: StripeEnvironment;
  createCustomer(params: CreateStripeCustomerParams): Promise<StripeCustomerRef>;
  /** Bulunamazsa `null` döner (hata fırlatmaz) — çağıran fail-closed kararını kendisi verir. */
  retrieveCustomer(customerId: string): Promise<StripeCustomerRef | null>;
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
