/**
 * YF-701 — AI çağrılarına özgü hata sınıflandırması. `ServiceError`
 * (bkz. server/services/errors.ts) kullanıcıya doğrudan gösterilebilecek
 * Türkçe hataları temsil eder; `AiError` ise sağlayıcı/altyapı katmanının
 * gözlemlenebilirlik amaçlı, kategorize edilmiş iç hatasıdır. Uç kullanıcı
 * özelliği eklendiğinde çağıran kod bunu kendi `ServiceError`'ına çevirir —
 * bu dönüşüm burada YAPILMAZ (kapsam dışı, bkz. görev talimatı).
 */

export type AiErrorCategory =
  | "not_configured"
  | "timeout"
  | "provider_error"
  | "invalid_response"
  | "unauthorized_context"
  | "quota_exceeded";

export class AiError extends Error {
  /**
   * YF-711 — genel amaçlı, katman-dışı geçiş alanı: `checkQuota`'nın
   * döndürdüğü `AiQuotaDecision.reasonCode` (bkz. lib/ai/usage-reporting.ts)
   * buraya taşınır ki üst katman (`server/services/ai-usage-reporting-service.ts`
   * requestAiCompletion) bunu `AiEntitlementError.reasonCode`'a çevirebilsin.
   * Kasıtlı olarak gevşek tipli (`string`) — bu dosya servis katmanının
   * spesifik reasonCode birleşim tipini BİLMEZ (bkz. lib/ai/* Prisma'dan/
   * servis katmanından bağımsızlık ilkesi).
   */
  public readonly reasonCode?: string;

  constructor(
    message: string,
    public readonly category: AiErrorCategory,
    public readonly correlationId: string,
    options?: { cause?: unknown; reasonCode?: string },
  ) {
    super(message, { cause: options?.cause });
    this.name = "AiError";
    this.reasonCode = options?.reasonCode;
  }
}
