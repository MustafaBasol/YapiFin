import { toDecimal } from "@/server/services/ledger";

/**
 * YF-405 — Decimal → Excel sayısal hücre dönüşümü, sınırlı ve test edilmiş
 * bir aralıkta. `prisma/schema.prisma` her para alanını `Decimal(18,2)`
 * olarak tanımlar (16 tam sayı hanesi + 2 ondalık = 18 anlamlı hane); bir
 * Excel/JS `number` ise IEEE-754 double'dır (~15–17 anlamlı ondalık hane
 * kesin hassasiyet). Yani Decimal hassasiyeti, bir Excel sayısal hücresine
 * dönüştürülerek koşulsuz korunamaz — bu modül bunu iddia etmez, açıkça
 * sınırlar ve aşan değerleri metne düşürür.
 *
 * `EXCEL_EXACT_SAFE_MAX = 999.999.999.999,99` (12 tam sayı hanesi + 2
 * ondalık = 14 anlamlı hane). Bu büyüklükte en kötü durum double yuvarlama
 * hatası ≈ değer × 2,22e-16 ≈ 2×10⁻⁴ TL — yarım kuruşun (0,005) çok
 * altında; hücrenin *görüntülenen* 2 ondalıklı değeri bu eşik altında her
 * zaman doğrudur.
 */
export const EXCEL_EXACT_SAFE_MAX = "999999999999.99";

export type ExcelAmountCell = { kind: "numeric"; value: number } | { kind: "text"; value: string };

/**
 * Decimal'in kendi `toFixed(2)` dizgesinden, hiçbir noktada JS `number`'a
 * dönüştürmeden (bu tam da önlenmek istenen hassasiyet kaybı olurdu) binlik
 * ayraçlı Türkçe bir metin üretir.
 */
function formatDecimalStringTurkish(exactDecimalString: string): string {
  const negative = exactDecimalString.startsWith("-");
  const unsigned = negative ? exactDecimalString.slice(1) : exactDecimalString;
  const [integerPart, fractionPart = "00"] = unsigned.split(".");
  const grouped = integerPart.replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return `${negative ? "-" : ""}${grouped},${fractionPart.padEnd(2, "0")}`;
}

export function toExcelAmountCell(decimalString: string): ExcelAmountCell {
  const amount = toDecimal(decimalString);
  const safeMax = toDecimal(EXCEL_EXACT_SAFE_MAX);
  if (amount.abs().lessThanOrEqualTo(safeMax)) {
    return { kind: "numeric", value: Number(decimalString) };
  }
  const exact = formatDecimalStringTurkish(amount.toFixed(2));
  return { kind: "text", value: `${exact} ₺ (metin — Excel sayısal hassasiyet sınırını aşıyor)` };
}
