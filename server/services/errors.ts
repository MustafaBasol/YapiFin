/** Servis katmanından fırlatılan, kullanıcıya doğrudan gösterilebilecek Türkçe hata. */
export class ServiceError extends Error {
  constructor(
    message: string,
    public code: "VALIDATION" | "FORBIDDEN" | "NOT_FOUND" | "CONFLICT" = "VALIDATION",
  ) {
    super(message);
    this.name = "ServiceError";
  }
}

export function notFound(message = "Kayıt bulunamadı") {
  return new ServiceError(message, "NOT_FOUND");
}

export function forbidden(message = "Bu işlem için yetkiniz yok") {
  return new ServiceError(message, "FORBIDDEN");
}

export function conflict(message: string) {
  return new ServiceError(message, "CONFLICT");
}
