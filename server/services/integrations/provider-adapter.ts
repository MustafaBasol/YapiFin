import type { IntegrationEnvironment, IntegrationErrorCategory, IntegrationProvider } from "@prisma/client";

export type { IntegrationErrorCategory } from "@prisma/client";

/**
 * YF-605-B — sağlayıcı-nötr e-belge adaptör sözleşmesi (bkz.
 * docs/architecture/YF-605_EINVOICE_ACCOUNTING_INTEGRATIONS.md §4). Somut bir
 * sağlayıcı (Nilvera, Uyumsoft, ...) bu fazda YOKTUR — yalnızca sözleşme ve
 * tek somut örnek (`providers/fake-provider.ts`) tanımlanır (bkz. görev
 * talimatı "Do NOT integrate a real e-invoice provider"). Gelecekteki bir
 * sağlayıcı adaptörü bu arayüzü uygulayıp `provider-registry.ts`'e
 * kaydedilir; `provider-lifecycle-service.ts` hiçbir zaman sağlayıcıya özgü
 * kod içermez.
 */

/**
 * Bir adaptörün destekleyebileceği yetenekler — domain katmanı bir işlemi
 * yalnızca adaptör ilgili yeteneği bildirdiğinde çağırır (bkz.
 * provider-lifecycle-service.ts, "provider capability handling").
 */
export type ProviderCapability = "CONNECTION_TEST" | "OUTBOUND_OPERATION";

/** Dahili kullanım için çözülmüş kimlik bilgisi — ASLA loglanmaz/serileştirilmez, yalnızca adaptöre parametre olarak geçirilir. */
export interface ProviderCredentials {
  readonly secretValue: string;
}

/** Adaptör çağrılarında sağlayıcıya özgü olmayan, güvenli bağlam bilgisi. */
export interface ProviderConnectionContext {
  readonly connectionId: string;
  readonly organizationId: string;
  readonly provider: IntegrationProvider;
  readonly environment: IntegrationEnvironment;
  readonly externalTenantId: string | null;
}

export interface ProviderConnectionTestResult {
  readonly ok: true;
  /** İnsan-okunur, güvenli özet — UI'da doğrudan gösterilebilir. */
  readonly summary: string;
}

export interface ProviderOutboundOperationInput {
  /** Provider-nötr mantıksal işlem türü (ör. gelecekte "EINVOICE_SUBMIT") — sağlayıcı adaptörü kendi protokolüne çevirir. */
  readonly operationType: string;
  /** Çağıranın ürettiği mantıksal işlem kimliği (bkz. provider-lifecycle-service.ts idempotency). */
  readonly idempotencyKey: string;
  /** Yalnızca güvenli/özet alanlar — çağıran hiçbir zaman ham kimlik bilgisi/tam belge içeriği koymamalıdır. */
  readonly payloadSummary?: Readonly<Record<string, unknown>>;
}

export interface ProviderOutboundOperationResult {
  readonly ok: true;
  /** Yalnızca güvenli/özet alanlar — asla ham sağlayıcı yanıtı/kimlik bilgisi içermemelidir. */
  readonly resultSummary?: Readonly<Record<string, unknown>>;
}

/** Yeniden denenebilir kategoriler — bkz. provider-lifecycle-service.ts retry/DEAD_LETTER kararı. */
const RETRYABLE_ERROR_CATEGORIES: ReadonlySet<IntegrationErrorCategory> = new Set([
  "TEMPORARY_PROVIDER",
  "RATE_LIMIT",
  "TIMEOUT_NETWORK",
]);

export function isRetryableErrorCategory(category: IntegrationErrorCategory): boolean {
  return RETRYABLE_ERROR_CATEGORIES.has(category);
}

/**
 * Adaptörlerin başarısızlık durumunda fırlatması gereken TEK hata tipi.
 * `message` insan-okunur ve GÜVENLİDİR — hiçbir zaman kimlik bilgisi/ham
 * sağlayıcı yanıt gövdesi içermemelidir (görev talimatı "Never log secrets").
 * `provider-lifecycle-service.ts` yine de savunma amaçlı olarak bilinen sır
 * değerini mesajdan ayrıca temizler (redaction) — bkz. `classifyProviderError`.
 */
export class ProviderError extends Error {
  constructor(
    message: string,
    public readonly category: IntegrationErrorCategory,
    public readonly providerCode?: string,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

/**
 * Her somut sağlayıcı adaptörünün uyması gereken sözleşme. Fonksiyon tabanlı
 * servis modülleriyle aynı üslup (bkz. mimari doküman §4) — sınıf hiyerarşisi
 * değil, düz obje/factory deseni (bkz. providers/fake-provider.ts).
 */
export interface ProviderAdapter {
  readonly provider: IntegrationProvider;
  readonly capabilities: readonly ProviderCapability[];
  testConnection(
    credentials: ProviderCredentials,
    ctx: ProviderConnectionContext,
  ): Promise<ProviderConnectionTestResult>;
  executeOutboundOperation(
    input: ProviderOutboundOperationInput,
    credentials: ProviderCredentials,
    ctx: ProviderConnectionContext,
  ): Promise<ProviderOutboundOperationResult>;
}
