import type { IntegrationProvider } from "@prisma/client";
import {
  ProviderError,
  type DocumentStatusLookupInput,
  type DocumentStatusLookupResult,
  type NormalizedDocumentStatus,
  type ProviderAdapter,
  type ProviderCapability,
  type ProviderConnectionContext,
  type ProviderConnectionTestResult,
  type ProviderCredentials,
  type ProviderOutboundOperationResult,
  type TaxpayerLookupInput,
  type TaxpayerLookupResult,
} from "../provider-adapter";

/**
 * YF-605-D — Nilvera SANDBOX salt-okunur adaptörü (bkz. görev talimatı
 * "sandbox configuration/authentication", "READ-ONLY RULE"). Yalnızca GET
 * istekleri yapar; giden e-belge gönderimi/iptal/onay gibi hiçbir
 * mutasyon işlemi UYGULANMAZ (`testConnection`/`executeOutboundOperation`
 * kasıtlı olarak desteklenmez, bkz. `capabilities`).
 *
 * Uç nokta/kimlik doğrulama biçimi resmi Nilvera API dokümantasyonundan
 * (developer.nilvera.com) doğrulanmıştır:
 * - Sandbox taban URL: `https://apitest.nilvera.com`
 * - Kimlik doğrulama: `Authorization: Bearer <API Anahtarı>` (Portal'da
 *   üretilen "Persisted Access Token").
 * - Mükellef sorgulama: `GET /general/GlobalCompany/Check/TaxNumber/{VKN}`
 *   ("VKN ile Sorgular").
 * - Belge durumu sorgulama: `GET /einvoice/Sale/{UUID}/Status`
 *   ("Giden Faturanın Statü Bilgilerini Getirir").
 */
const NILVERA_SANDBOX_BASE_URL = "https://apitest.nilvera.com";
const REQUEST_TIMEOUT_MS = 15_000;

const CAPABILITIES: readonly ProviderCapability[] = ["TAXPAYER_LOOKUP", "DOCUMENT_STATUS_LOOKUP"];

export type NilveraFetch = typeof fetch;

export interface NilveraProviderOptions {
  /** Testlerde/gelecekte prod taban URL'i enjekte etmek için — varsayılan SANDBOX'tır. */
  readonly baseUrl?: string;
  /** Testlerde gerçek ağ çağrısı yapılmaması için enjekte edilebilir (görev talimatı "Do not make real external network calls in automated tests"). */
  readonly fetchImpl?: NilveraFetch;
}

/** Bu adaptör kapsamı yalnızca SANDBOX'tır — PRODUCTION bağlantılar kasıtlı olarak reddedilir (görev talimatı "READ-ONLY RULE", scope "Nilvera sandbox"). */
function assertSandboxEnvironment(ctx: ProviderConnectionContext): void {
  if (ctx.environment !== "SANDBOX") {
    throw new ProviderError(
      "Bu adaptör yalnızca SANDBOX ortamını destekler (YF-605-D kapsamı) — PRODUCTION e-belge gönderimi bu fazda desteklenmez",
      "VALIDATION",
    );
  }
}

function unsupportedOperation(): never {
  throw new ProviderError(
    "Bu adaptör bu işlemi desteklemiyor (salt-okunur Nilvera sandbox entegrasyonu — YF-605-D kapsamı)",
    "VALIDATION",
  );
}

interface RequestOptions {
  readonly baseUrl: string;
  readonly fetchImpl: NilveraFetch;
  readonly secretValue: string;
}

/** Tüm sağlayıcı çağrıları için ortak GET yardımcı fonksiyonu — zaman aşımı ve ağ hatalarını `TIMEOUT_NETWORK` olarak sınıflandırır. */
async function nilveraGet(path: string, options: RequestOptions): Promise<Response> {
  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await options.fetchImpl(`${options.baseUrl}${path}`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${options.secretValue}`,
        Accept: "application/json",
      },
      signal: controller.signal,
    });
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new ProviderError("Nilvera sandbox isteği zaman aşımına uğradı", "TIMEOUT_NETWORK");
    }
    throw new ProviderError("Nilvera sandbox'a bağlanılamadı", "TIMEOUT_NETWORK");
  } finally {
    clearTimeout(timeoutHandle);
  }
}

/** 2xx dışı (404 hariç — çağıran uç noktaya göre ayrıca ele alır) yanıtları ortak `IntegrationErrorCategory` kümesine sınıflandırır. */
function throwForHttpError(response: Response): never {
  const status = response.status;
  if (status === 401 || status === 403) {
    throw new ProviderError("Nilvera kimlik doğrulaması başarısız oldu", "AUTH_CONFIG", String(status));
  }
  if (status === 429) {
    throw new ProviderError("Nilvera sandbox istek sınırına ulaşıldı", "RATE_LIMIT", String(status));
  }
  if (status >= 500) {
    throw new ProviderError("Nilvera sandbox geçici olarak yanıt vermiyor", "TEMPORARY_PROVIDER", String(status));
  }
  if (status === 400) {
    throw new ProviderError("Nilvera sandbox isteği geçersiz olarak reddetti", "VALIDATION", String(status));
  }
  throw new ProviderError(`Nilvera sandbox beklenmeyen bir durum kodu döndürdü (${status})`, "UNKNOWN", String(status));
}

async function parseJsonBody(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new ProviderError("Nilvera sandbox yanıtı ayrıştırılamadı (bozuk/eksik gövde)", "UNKNOWN");
  }
}

/**
 * VKN/TCKN ile GİB'e kayıtlı e-belge mükellefi olup olmadığını sorgular
 * (görev talimatı "Taxpayer lookup"). 404/boş liste, sorgulanan kimliğin
 * e-belge mükellefi OLMADIĞI anlamına gelen GEÇERLİ bir domain sonucudur —
 * hata olarak sınıflandırılmaz (bkz. docs: "404 — No record found for
 * specified tax number").
 */
async function lookupTaxpayer(
  input: TaxpayerLookupInput,
  credentials: ProviderCredentials,
  ctx: ProviderConnectionContext,
  request: RequestOptions,
): Promise<TaxpayerLookupResult> {
  assertSandboxEnvironment(ctx);
  if (!credentials.secretValue) {
    throw new ProviderError("Kimlik bilgisi eksik", "AUTH_CONFIG");
  }
  const identifier = input.identifier.trim();
  if (!identifier) {
    throw new ProviderError("Sorgulanacak vergi/kimlik numarası zorunludur", "VALIDATION");
  }

  const response = await nilveraGet(
    `/general/GlobalCompany/Check/TaxNumber/${encodeURIComponent(identifier)}?globalUserType=Invoice`,
    request,
  );

  if (response.status === 404) {
    return { identifier, isEDocumentTaxpayer: false, supportedDocumentType: null };
  }
  if (!response.ok) {
    throwForHttpError(response);
  }

  const body = await parseJsonBody(response);
  if (!Array.isArray(body) || body.length === 0) {
    return { identifier, isEDocumentTaxpayer: false, supportedDocumentType: null };
  }

  const first = body[0] as Record<string, unknown> | null | undefined;
  const supportedDocumentType = typeof first?.DocumentType === "string" ? first.DocumentType : null;
  return { identifier, isEDocumentTaxpayer: true, supportedDocumentType };
}

function normalizeInvoiceStatus(record: Record<string, unknown>): NormalizedDocumentStatus {
  const answer = record.Answer as Record<string, unknown> | undefined;
  const invoiceStatus = record.InvoiceStatus as Record<string, unknown> | undefined;
  const answerCode = typeof answer?.AnswerCode === "string" ? answer.AnswerCode : undefined;
  const statusCode = typeof invoiceStatus?.Code === "string" ? invoiceStatus.Code : undefined;

  if (answerCode === "rejected") return "REJECTED";
  if (statusCode === "error") return "ERROR";
  if (answerCode === "approved" || statusCode === "succeed") return "ACCEPTED";
  if (statusCode === "waiting" || answerCode === "waitingForApproval") return "PENDING";
  return "UNKNOWN";
}

/**
 * Bir belgenin (ETTN/UUID ile) GİB/Nilvera üzerindeki durumunu sorgular
 * (görev talimatı "Document status lookup"). Taxpayer sorgusunun aksine,
 * 404 burada GEÇERSİZ bir referans kimliğine işaret eder (bkz. docs:
 * "Parametrede belirtilen kayıt bulunamadığında dönülür") — istemci
 * girdisi hatası olarak `VALIDATION` ile sınıflandırılır.
 */
async function lookupDocumentStatus(
  input: DocumentStatusLookupInput,
  credentials: ProviderCredentials,
  ctx: ProviderConnectionContext,
  request: RequestOptions,
): Promise<DocumentStatusLookupResult> {
  assertSandboxEnvironment(ctx);
  if (!credentials.secretValue) {
    throw new ProviderError("Kimlik bilgisi eksik", "AUTH_CONFIG");
  }
  const externalDocumentId = input.externalDocumentId.trim();
  if (!externalDocumentId) {
    throw new ProviderError("Belge referans kimliği (ETTN/UUID) zorunludur", "VALIDATION");
  }

  const response = await nilveraGet(`/einvoice/Sale/${encodeURIComponent(externalDocumentId)}/Status`, request);

  if (response.status === 404) {
    throw new ProviderError("Belirtilen belge referansı Nilvera sandbox'ta bulunamadı", "VALIDATION", "404");
  }
  if (!response.ok) {
    throwForHttpError(response);
  }

  const body = await parseJsonBody(response);
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new ProviderError("Nilvera sandbox beklenmeyen bir yanıt biçimi döndürdü", "UNKNOWN");
  }

  const record = body as Record<string, unknown>;
  const envelopeInfo = record.EnvelopeInfo as Record<string, unknown> | undefined;
  const invoiceStatus = record.InvoiceStatus as Record<string, unknown> | undefined;
  const providerStatusCode = typeof invoiceStatus?.Code === "string" ? invoiceStatus.Code : null;
  const lastKnownProviderTimestamp =
    (typeof envelopeInfo?.CreatedDate === "string" ? envelopeInfo.CreatedDate : null) ??
    (typeof record.IssueDate === "string" ? (record.IssueDate as string) : null);

  return {
    externalDocumentId,
    status: normalizeInvoiceStatus(record),
    providerStatusCode,
    lastKnownProviderTimestamp,
  };
}

export function createNilveraProviderAdapter(options: NilveraProviderOptions = {}): ProviderAdapter {
  const baseUrl = options.baseUrl ?? NILVERA_SANDBOX_BASE_URL;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;

  return {
    provider: "NILVERA" as IntegrationProvider,
    capabilities: CAPABILITIES,
    async testConnection(): Promise<ProviderConnectionTestResult> {
      unsupportedOperation();
    },
    async executeOutboundOperation(): Promise<ProviderOutboundOperationResult> {
      unsupportedOperation();
    },
    lookupTaxpayer(input, credentials, ctx) {
      return lookupTaxpayer(input, credentials, ctx, { baseUrl, fetchImpl, secretValue: credentials.secretValue });
    },
    lookupDocumentStatus(input, credentials, ctx) {
      return lookupDocumentStatus(input, credentials, ctx, { baseUrl, fetchImpl, secretValue: credentials.secretValue });
    },
  };
}
