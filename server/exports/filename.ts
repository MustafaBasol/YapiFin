/**
 * YF-405 — Dışa aktarılan dosyalar için merkezi, güvenli dosya adı üretimi.
 * Hiçbir route/servis doğrudan dosya adı birleştirmez; istemciden gelen
 * hiçbir değer (proje/organizasyon adı hariç) dosya adına karışmaz ve o ad
 * bile tamamen ASCII'ye indirgenir — CR/LF veya tırnak enjeksiyonu riski
 * taşımaz (bkz. görev talimatları "Do not accept a filename directly from
 * the client").
 */

const TURKISH_CHAR_MAP: Record<string, string> = {
  ı: "i",
  ş: "s",
  ğ: "g",
  ü: "u",
  ö: "o",
  ç: "c",
  İ: "i",
  Ş: "s",
  Ğ: "g",
  Ü: "u",
  Ö: "o",
  Ç: "c",
};

export function slugifyTurkish(input: string): string {
  const mapped = input
    .split("")
    .map((ch) => TURKISH_CHAR_MAP[ch] ?? ch)
    .join("");
  return mapped
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export type ExportExtension = "xlsx" | "pdf";

const FILENAME_PATTERN = /^[a-z0-9][a-z0-9-]*-\d{4}-\d{2}-\d{2}\.(xlsx|pdf)$/;

/**
 * `isoDate` GG.AA.YYYY değil, dosya sistemi/sıralama dostu YYYY-AA-GG
 * biçimindedir (bkz. görev talimatlarındaki örnekler) — belge içeriği
 * (başlık, üstbilgi) her zaman Türkçe GG.AA.YYYY kullanır, yalnızca dosya
 * adı ISO biçimindedir.
 */
export function buildExportFilename(
  reportSlug: string,
  ext: ExportExtension,
  isoDate: string,
  entitySlug?: string,
): string {
  const parts = [reportSlug, ...(entitySlug ? [slugifyTurkish(entitySlug)] : []), isoDate];
  const filename = `${parts.filter(Boolean).join("-")}.${ext}`;

  if (!FILENAME_PATTERN.test(filename)) {
    // Savunma amaçlı: slugifyTurkish alfabesi zaten CR/LF/tırnak üretemez,
    // ama beklenmeyen bir girdi (ör. boş entitySlug sonrası çift tire) bu
    // sabit deseni ihlal ederse, kısmen temizlenmiş bir ad yerine sabit bir
    // yedek ada düşülür.
    return `yapifin-rapor-${isoDate}.${ext}`;
  }
  return filename;
}

/** `Content-Disposition` başlığı için güvenli, tırnaklı değer üretir. */
export function buildContentDisposition(filename: string, disposition: "attachment" | "inline" = "attachment"): string {
  if (!FILENAME_PATTERN.test(filename) || /["\r\n]/.test(filename)) {
    throw new Error("Güvensiz dosya adı: Content-Disposition başlığı oluşturulamadı");
  }
  return `${disposition}; filename="${filename}"`;
}
