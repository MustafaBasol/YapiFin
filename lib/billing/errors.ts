/**
 * YF-808 — Faturalama/ödeme sağlayıcı (Stripe) sınırındaki hata tipleri.
 *
 * İki katman ayrılır (bkz. lib/ai/errors.ts ile aynı ayrım):
 *
 * - `BillingConfigError`: yapılandırma eksik/tutarsız. **Fail-closed**'dır —
 *   yalnızca gerçek bir Stripe işlemi çağrıldığında fırlatılır, uygulama
 *   başlangıcını veya ilgisiz route'ları ETKİLEMEZ (bkz. lib/env.ts'te
 *   `STRIPE_*` değişkenlerinin her ortamda opsiyonel olması —
 *   `INTEGRATION_ENCRYPTION_KEY` ile aynı desen).
 * - `BillingProviderError`: sağlayıcı çağrısı başarısız. Ham Stripe hata
 *   gövdesi/`message`'ı ASLA taşınmaz; yalnızca sabit, güvenli Türkçe mesaj +
 *   kategorize edilmiş `category` + (varsa) kısa, güvenli `providerCode`
 *   (ör. "resource_missing") dışarı verilir. Orijinal hata yalnızca
 *   `cause` üzerinden (serileştirilmeden) taşınır.
 *
 * Bu dosya Stripe SDK'sını İÇE AKTARMAZ — böylece sınır tipleri sağlayıcıdan
 * bağımsız kalır (bkz. server/services/integrations/provider-adapter.ts aynı
 * ilke).
 */

/** Sağlayıcı-nötr hata sınıflandırması (bkz. IntegrationErrorCategory ile aynı felsefe; kasıtlı olarak o Prisma enum'una BAĞLANMAZ — e-belge domaini ile faturalama domaini birbirine kuplajlanmamalıdır). */
export type BillingErrorCategory =
  | "AUTH_CONFIG"
  | "VALIDATION"
  | "TEMPORARY_PROVIDER"
  | "RATE_LIMIT"
  | "TIMEOUT_NETWORK"
  | "PERMANENT_REJECTION"
  /** Aynı idempotency anahtarıyla eşzamanlı ikinci bir istek (Stripe: `idempotency_key_in_use`). */
  | "IDEMPOTENCY_CONFLICT"
  /** YF-810 — webhook `stripe-signature` başlığı doğrulanamadı (eksik/bozuk/yanlış sır). */
  | "WEBHOOK_SIGNATURE_INVALID"
  | "UNKNOWN";

/**
 * Log/hata mesajlarına sızabilecek bilinen sır biçimlerini temizler. Sınır
 * katmanı zaten ham sağlayıcı mesajını dışarı vermez; bu ikinci bir savunma
 * katmanıdır (bkz. provider-lifecycle-service.ts `redactSecret` aynı desen).
 */
const SECRET_PATTERNS: readonly RegExp[] = [
  /\b[sr]k_(?:test|live)_[A-Za-z0-9]+/g,
  /\bwhsec_[A-Za-z0-9]+/g,
];

export function redactBillingSecrets(value: string): string {
  return SECRET_PATTERNS.reduce((acc, pattern) => acc.replace(pattern, "[REDACTED]"), value);
}

/**
 * Yapılandırma hatası — çağıran servis bunu kullanıcıya doğrudan
 * göstermemelidir (operasyonel bir kurulum eksikliğidir). `message` her zaman
 * sır İÇERMEZ: yalnızca hangi ortam değişkeninin eksik/tutarsız olduğunu
 * söyler, değerini asla yazmaz.
 */
export class BillingConfigError extends Error {
  constructor(message: string) {
    super(redactBillingSecrets(message));
    this.name = "BillingConfigError";
  }
}

/**
 * Sağlayıcı sınırının fırlattığı TEK hata tipi. `message` sabit, güvenli ve
 * Türkçedir — ham Stripe mesajı buraya ASLA kopyalanmaz (görev talimatı
 * "Never leak raw Stripe error internals or secrets to clients").
 */
export class BillingProviderError extends Error {
  constructor(
    message: string,
    public readonly category: BillingErrorCategory,
    /** Stripe'ın kısa, güvenli hata kodu (ör. "resource_missing") — ham gövde/mesaj DEĞİLDİR. */
    public readonly providerCode?: string,
    options?: { cause?: unknown },
  ) {
    super(redactBillingSecrets(message), { cause: options?.cause });
    this.name = "BillingProviderError";
  }
}
