import fs from "node:fs";
import path from "node:path";

/**
 * YF-405 — PDF için Türkçe karakter destekli gömülebilir yazı tipi.
 * pdfmake'in kendi npm paketi yalnızca WinAnsi kodlu 5 standart PDF
 * yazı tipini içerir (Helvetica/Times/Courier/Symbol/ZapfDingbats) — bunlar
 * `ş ğ ı ö ü ç İ Ğ Ş Ö Ü Ç` karakterlerini kapsamaz (doğrulandı:
 * `npm pack pdfmake --dry-run`). `@expo-google-fonts/roboto` gerçek `.ttf`
 * dosyaları içerir (SIL Open Font License 1.1 — bkz. docs/ARCHITECTURE.md);
 * yalnızca Regular (400) ve Bold (700) kullanılır.
 *
 * pdfmake'in sunucu API'si (`PdfPrinter`/`PDFDocument.provideFont`) yazı
 * tipi tanımı olarak yerel dosya YOLU (string) bekler — bir Buffer
 * verildiğinde `resolveUrls` içindeki `typeof value === 'object'` dalı
 * yanlışlıkla `value.url` okumaya çalışıp değeri `undefined`'a düşürür
 * (doğrulandı: font spike). Bu nedenle burada Buffer değil, çözümlenmiş
 * mutlak yol dizgeleri döndürülür.
 *
 * **`require.resolve()` KASITLI OLARAK KULLANILMAZ.** Gerçek `next build` +
 * `next start` altında doğrulandı: Next'in bundler'ı (Turbopack)
 * `require.resolve("@expo-google-fonts/roboto/package.json")` çağrısını
 * derleme zamanında statik olarak analiz edip bir dosya yolu STRING'i
 * yerine dahili sayısal bir modül kimliğine (`TypeError: The "path"
 * argument must be of type string. Received type number`) dönüştürüyor —
 * yalnızca `vitest`/`tsx` altında (bundler yokken) çalışıyordu. Bunun
 * yerine `process.cwd()` (bu paket için proje kökü — `next start` proje
 * kökünden çalıştırılır) temelli düz `path.join` kullanılır; bu, modül
 * çözümleyicisini hiç tetiklemediğinden bundler'ın statik analizinden
 * etkilenmez.
 */
export interface RobotoFontPaths {
  normal: string;
  bold: string;
}

let cached: RobotoFontPaths | null = null;

export function getRobotoFontPaths(): RobotoFontPaths {
  if (cached) return cached;

  const pkgDir = path.join(process.cwd(), "node_modules", "@expo-google-fonts", "roboto");
  const normal = path.join(pkgDir, "400Regular", "Roboto_400Regular.ttf");
  const bold = path.join(pkgDir, "700Bold", "Roboto_700Bold.ttf");

  if (!fs.existsSync(normal) || !fs.existsSync(bold)) {
    throw new Error("Roboto yazı tipi dosyaları bulunamadı — @expo-google-fonts/roboto paketi eksik veya bozuk olabilir.");
  }

  cached = { normal, bold };
  return cached;
}
