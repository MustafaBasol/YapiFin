import type { IntegrationEnvironment, IntegrationErrorCategory, IntegrationProvider } from "@prisma/client";

export type { IntegrationErrorCategory } from "@prisma/client";

/**
 * YF-605-B — sağlayıcı-nötr e-belge adaptör sözleşmesi (bkz.
 * docs/architecture/YF-605_EINVOICE_ACCOUNTING_INTEGRATIONS.md §4). Somut
 * sağlayıcılardan yalnızca Nilvera'nın SANDBOX/salt-okunur bir adaptörü
 * vardır (YF-605-D, bkz. `providers/nilvera-provider.ts`) — giden e-belge
 * gönderimi (`OUTBOUND_OPERATION`) hiçbir gerçek sağlayıcıda henüz YOKTUR
 * (bkz. görev talimatı "Do NOT integrate a real e-invoice provider").
 * Gelecekteki bir sağlayıcı adaptörü bu arayüzü uygulayıp
 * `provider-registry.ts`'e kaydedilir; `provider-lifecycle-service.ts`
 * hiçbir zaman sağlayıcıya özgü kod içermez.
 */

/**
 * Bir adaptörün destekleyebileceği yetenekler — domain katmanı bir işlemi
 * yalnızca adaptör ilgili yeteneği bildirdiğinde çağırır (bkz.
 * provider-lifecycle-service.ts, "provider capability handling").
 * `TAXPAYER_LOOKUP`/`DOCUMENT_STATUS_LOOKUP` YF-605-D ile eklenen
 * salt-okunur sorgu yetenekleridir (bkz. `lookupTaxpayer`/
 * `lookupDocumentStatus` — opsiyoneldir, yalnızca bu yetenekleri bildiren
 * adaptörler uygular).
 */
export type ProviderCapability =
  | "CONNECTION_TEST"
  | "OUTBOUND_OPERATION"
  | "TAXPAYER_LOOKUP"
  | "DOCUMENT_STATUS_LOOKUP";

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

/** YF-605-D — mükellef/GİB e-belge kapasitesi sorgusu için sorgulanan kimlik (VKN/TCKN). */
export interface TaxpayerLookupInput {
  readonly identifier: string;
}

/**
 * Sağlayıcı-nötr, domain-güvenli sonuç — ham sağlayıcı gövdesi asla
 * dışarı sızmaz (görev talimatı "Do not leak raw provider responses into
 * domain/UI"). Yalnızca sorgulanan kimlik, e-belge mükellefi olup olmadığı
 * ve (güvenilir şekilde biliniyorsa) desteklenen belge türü döner.
 */
export interface TaxpayerLookupResult {
  readonly identifier: string;
  readonly isEDocumentTaxpayer: boolean;
  readonly supportedDocumentType: string | null;
}

/** YF-605-D — belge durumu sorgusu için sağlayıcıdaki harici belge/referans kimliği (ör. Nilvera ETTN/UUID). */
export interface DocumentStatusLookupInput {
  readonly externalDocumentId: string;
}

/** Provider-nötr normalize edilmiş belge durumu — sağlayıcıya özgü ham kod/metin asla doğrudan döndürülmez. */
export type NormalizedDocumentStatus = "PENDING" | "ACCEPTED" | "REJECTED" | "ERROR" | "UNKNOWN";

export interface DocumentStatusLookupResult {
  readonly externalDocumentId: string;
  readonly status: NormalizedDocumentStatus;
  /** Sağlayıcının kendi durum kodu — yalnızca güvenli/kısa bir tanımlayıcıysa (ör. "succeed") taşınır, ham gövde değildir. */
  readonly providerStatusCode: string | null;
  /** Sağlayıcının bildirdiği en güncel zaman damgası (ISO 8601), biliniyorsa. */
  readonly lastKnownProviderTimestamp: string | null;
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
  /** Yalnızca `capabilities` içinde `TAXPAYER_LOOKUP` bildiren adaptörler uygular. */
  lookupTaxpayer?(
    input: TaxpayerLookupInput,
    credentials: ProviderCredentials,
    ctx: ProviderConnectionContext,
  ): Promise<TaxpayerLookupResult>;
  /** Yalnızca `capabilities` içinde `DOCUMENT_STATUS_LOOKUP` bildiren adaptörler uygular. */
  lookupDocumentStatus?(
    input: DocumentStatusLookupInput,
    credentials: ProviderCredentials,
    ctx: ProviderConnectionContext,
  ): Promise<DocumentStatusLookupResult>;
}
