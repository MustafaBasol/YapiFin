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
  constructor(
    message: string,
    public readonly category: AiErrorCategory,
    public readonly correlationId: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "AiError";
  }
}
