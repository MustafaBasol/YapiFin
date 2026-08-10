/**
 * YF-802 — Plan yeteneği (capability) ve nicel limit kimlikleri.
 *
 * Bunlar kararlı, makine-okunur tanımlayıcılardır — ASLA arayüz etiketi
 * (ör. "Gelişmiş Raporlar") DEĞİLDİR ve asla yeniden adlandırılmaz (mevcut
 * `Plan.capabilities`/`Plan.limits` JSON'unda anahtar olarak saklanırlar,
 * bir yeniden adlandırma sessizce erişimi keser). Yeni bir modül eklemek
 * yalnızca bu listeye bir kimlik eklemek ve ilgili Plan satırlarını
 * güncellemek anlamına gelir — hiçbir servis kodu veya şema değişikliği
 * gerekmez (bkz. lib/entitlements/entitlement-service.ts).
 *
 * Bu fazda TÜM kimlikler için gerçek bir uygulama noktası YOKTUR — yalnızca
 * OCR (`ocr`) ve banka içe aktarım (`bank_import`) merkezi kontrol
 * fonksiyonu üzerinden uygulanır (bkz. görev talimatı "wire at least one or
 * two of those ... as a demonstration"). Kalan kimlikler ileride aynı
 * `canUseCapability` çağrısıyla ilgili servise eklenebilir.
 */
export const CAPABILITY_IDS = [
  /** Bütçe/nakit akışı gibi gelişmiş rapor görünümleri. */
  "reports.advanced",
  /** Excel (xlsx) dışa aktarma. */
  "export.xlsx",
  /** PDF dışa aktarma. */
  "export.pdf",
  /** Banka ekstresi içe aktarım ve mutabakat modülü (YF-602). */
  "bank_import",
  /** Belge/fiş OCR çıkarım modülü (YF-601). */
  "ocr",
  /** E-belge/muhasebe sağlayıcı entegrasyonları (YF-605-A). */
  "e_document",
  /** Yapay zekâ destekli özellikler (ör. otomatik kategori önerisi). */
  "ai.features",
] as const;

export type CapabilityId = (typeof CAPABILITY_IDS)[number];

export function isCapabilityId(value: string): value is CapabilityId {
  return (CAPABILITY_IDS as readonly string[]).includes(value);
}

/**
 * Nicel kota kimlikleri. `LimitCheckResult.max === null` sınırsız anlamına
 * gelir. Yeni bir kota eklemek yalnızca bu listeye bir kimlik eklemek,
 * `entitlement-service.ts` içinde bir kullanım (usage) hesaplayıcısı
 * yazmak ve Plan satırlarına ilgili anahtarı eklemek demektir.
 */
export const LIMIT_IDS = [
  /** Organizasyondaki aktif (status=ACTIVE) kullanıcı sayısı. */
  "users.active",
  /** Organizasyondaki arşivlenmemiş (status != CANCELLED) proje sayısı. */
  "projects.active",
  /** Aylık yapay zekâ kullanım kotası — bkz. lib/entitlements/ai-quota-usage.ts. */
  "ai.monthly_quota",
  /**
   * YF-817 — Aylık OCR/belge çıkarım kotası. Kullanım, mevcut
   * `DocumentExtraction` kayıtlarından (PENDING hariç, bkz.
   * lib/entitlements/ocr-quota-usage.ts) türetilir — ayrı bir kullanım
   * defteri İCAT EDİLMEZ. `ai.monthly_quota` ile AYNI deterministik UTC
   * takvim ayı dönemini kullanır (bkz. lib/ai/quota-period.ts).
   * Starter'da 0 (zaten `ocr` capability'si kapalı — bu savunma amaçlı bir
   * ikinci kilittir). Professional/Business SAYISAL değerleri geçici bir
   * başlangıç seed değeridir; gerçek ticari OCR kota rakamları
   * docs/product/YF-807-plan-unit-economics.md §9'da AÇIKÇA çözümlenmemiş
   * bir fiyatlandırma kararı olarak bırakılmıştır (bkz.
   * lib/entitlements/plan-defaults.ts doc yorumu).
   */
  "ocr.monthly_quota",
] as const;

export type LimitId = (typeof LIMIT_IDS)[number];

export function isLimitId(value: string): value is LimitId {
  return (LIMIT_IDS as readonly string[]).includes(value);
}
