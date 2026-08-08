import crypto from "node:crypto";
import ExcelJS from "exceljs";
import { Prisma } from "@prisma/client";
import type { MovementDirection } from "@prisma/client";
import { ServiceError } from "@/server/services/errors";

/**
 * YF-602 — Banka ekstresi dosya ayrıştırma ve normalizasyon. Bu modül hiçbir
 * veritabanı işlemi yapmaz (saf fonksiyonlar) — çağıran
 * `server/services/bank-import-service.ts` sonuçları `BankImportRow`
 * satırlarına dönüştürüp kaydeder.
 *
 * ## Mükerrer içe aktarım koruması (fingerprint tasarımı)
 *
 * İki katmanlı koruma uygulanır:
 *
 * 1. **Dosya parmak izi** (`computeFileFingerprint`) — normalize edilmiş
 *    (BOM temizlenmiş) dosya baytlarının SHA-256'sı, organizasyon + hesap
 *    ile birlikte `BankImportBatch` üzerinde DB-zorunlu benzersizdir. AYNI
 *    dosyanın aynı hesaba iki kez yüklenmesi, yeni satır denenmeden mevcut
 *    batch'i idempotent olarak döner (bkz. bank-import-service.ts). Bu
 *    yalnızca hızlı bir kısayoldur — tek koruma katmanı DEĞİLDİR, çünkü aynı
 *    işlemler iki FARKLI dosyadan (ör. üst üste binen tarih aralıklı iki
 *    ekstre) da gelebilir.
 * 2. **Satır parmak izi** (`computeRowFingerprint`) — asıl finansal
 *    çift-kayıt koruması budur, `BankImportRow` üzerinde DB-zorunlu
 *    benzersizdir (`(organizationId, financialAccountId, rowFingerprint)`).
 *    Kaynak veri, satırlara GLOBAL (dosyalar arası) kararlı bir kimlik
 *    sağlamayabilir — bu yüzden iki FARKLI hesaplama yolu vardır, hangisinin
 *    kullanılacağı satırda banka referans numarası olup olmamasına göre
 *    belirlenir (`GÜÇLÜ` vs `ZAYIF` — YF-602 review düzeltmesi, önceki
 *    tasarımın hatalı varsayımı için aşağıya bakınız):
 *
 *    - **GÜÇLÜ (banka referansı VARSA):** parmak izi YALNIZCA
 *      (organizasyon, hesap, para birimi, banka referansı)'ndan türetilir —
 *      tarih/tutar/açıklama/dosya kimliğine BAĞLI DEĞİLDİR. Banka referans
 *      numarası, bankanın kendisinin verdiği kararlı bir işlem kimliğidir;
 *      bu nedenle FARKLI dosyalardan (ör. üst üste binen tarih aralıklı iki
 *      ekstre) gelen AYNI referanslı satırlar güvenle tek bir global kimliğe
 *      indirgenebilir — DB benzersizlik kısıtı ikinci satırı sessizce atlar
 *      (`skipDuplicates`).
 *    - **ZAYIF (banka referansı YOKSA):** kaynak veride hiçbir global
 *      kararlı kimlik YOKTUR — bu durumda parmak izi dosya kimliğiyle
 *      (`computeFileFingerprint` çıktısı) SINIRLANIR, yani yalnızca AYNI
 *      dosya İÇİNDE mükerrer korumaya sahiptir. Dosya içindeki gerçekten
 *      birebir aynı görünen (tarih + tutar + açıklama) satırları ayırt etmek
 *      için dosya İÇİNDEKİ karşılaşma sırasına göre bir `occurrenceIndex`
 *      (0, 1, 2, …) eklenir. KRİTİK İLKE: `occurrenceIndex` ASLA dosyalar
 *      ARASI bir kimlik kanıtı olarak kullanılmaz — iki FARKLI ekstre
 *      dosyasında aynı occurrenceIndex'e sahip görünüşte özdeş satırların
 *      gerçekten aynı işlem olduğu VARSAYILAMAZ (kaynak veri bunu
 *      kanıtlamaz). Bu yüzden dosya kimliği parmak izine dahil edilir:
 *      farklı bir dosyadan gelen referanssız bir satır asla önceki bir
 *      dosyanın referanssız satırlarıyla çakışıp sessizce atlanmaz — yeni,
 *      ayrı bir satır olarak içe aktarılır ve mutabakat kararı insana
 *      bırakılır (üst üste binen ekstrelerde bu satır kullanıcı tarafından
 *      yok sayılabilir/eşleştirilebilir — bkz. görev talimatı "avoid
 *      destructive global dedup that could silently collapse a distinct
 *      legitimate transaction").
 *
 *    ÖNCEKİ TASARIMIN HATASI (YF-602 review düzeltmesi öncesi): parmak izi
 *      dosya kimliğinden bağımsız, yalnızca içerik + occurrenceIndex'ten
 *      türetiliyordu. Bu, occurrenceIndex'in dosyalar arası GLOBAL bir işlem
 *      kimliği ifade ettiğini ÖRTÜK OLARAK varsayıyordu — oysa değildir.
 *      Görünüşte özdeş iki işlem içeren bir dosya (A#0, A#1) ile bunlardan
 *      yalnızca birini içeren örtüşen ikinci bir dosya (B#0) arasında hangi
 *      işlemin hangisine karşılık geldiği kaynak veriden BİLİNEMEZ; eski
 *      tasarım B#0'ı sessizce A#0 (veya A#1) ile aynı sayıp atlayabilir ya da
 *      gerçek bir mükerrer olsa dahi ayrı bir satır olarak yeniden içe
 *      aktarabilirdi — dosya bileşimine/sırasına bağlı, öngörülemez bir
 *      sonuç. Düzeltilmiş tasarım bunu kabul etmek yerine referanssız
 *      satırlar için dosya sınırının DIŞINA asla global kimlik iddia etmez.
 */

const MAX_UPLOAD_SIZE_BYTES = 5 * 1024 * 1024; // 5 MB — tipik banka ekstresi için fazlasıyla yeterli
const MAX_DATA_ROWS = 5000;

export type BankStatementFileKind = "csv" | "xlsx";

const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04];

/** İstemcinin bildirdiği dosya adı/uzantısına GÜVENMEDEN, yalnızca ilk baytlardan (magic number) tür belirler. */
export function sniffFileKind(buffer: Buffer): BankStatementFileKind | null {
  if (buffer.length >= 4 && ZIP_MAGIC.every((b, i) => buffer[i] === b)) {
    return "xlsx";
  }
  // CSV/metin için güvenilir bir magic number yoktur — geçerli UTF-8 metin
  // olup olmadığı `decodeCsvText` içinde ayrıca doğrulanır.
  return "csv";
}

/** BOM'u temizler ve geçerli UTF-8 olduğunu doğrular; geçersiz baytlar (U+FFFD'ye dönüşen) veya NUL bayt varsa null döner. */
export function decodeCsvText(buffer: Buffer): string | null {
  if (buffer.includes(0x00)) return null;
  let bytes = buffer;
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    bytes = bytes.subarray(3);
  }
  const text = bytes.toString("utf8");
  if (text.includes("�")) return null;
  return text;
}

/** Basit RFC4180 uyumlu CSV ayrıştırıcı — tırnaklı alan içindeki ayraç/satır sonu ve `""` kaçışını destekler. */
export function parseCsvRows(text: string): string[][] {
  const delimiter = detectDelimiter(text);
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let i = 0;
  const len = text.length;

  const pushField = () => {
    row.push(field);
    field = "";
  };
  const pushRow = () => {
    pushField();
    rows.push(row);
    row = [];
  };

  while (i < len) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      field += ch;
      i += 1;
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      i += 1;
      continue;
    }
    if (ch === delimiter) {
      pushField();
      i += 1;
      continue;
    }
    if (ch === "\r") {
      i += 1;
      continue;
    }
    if (ch === "\n") {
      pushRow();
      i += 1;
      continue;
    }
    field += ch;
    i += 1;
  }
  if (field.length > 0 || row.length > 0) pushRow();

  return rows.filter((r) => !(r.length === 1 && r[0].trim() === ""));
}

function detectDelimiter(text: string): "," | ";" {
  const firstLine = text.split(/\r?\n/, 1)[0] ?? "";
  const semicolons = (firstLine.match(/;/g) ?? []).length;
  const commas = (firstLine.match(/,/g) ?? []).length;
  return semicolons > commas ? ";" : ",";
}

/** ExcelJS ile `.xlsx` okuma — formül hücreleri ASLA yeniden hesaplanmaz, yalnızca dosyada önbelleklenmiş `result`/metin değeri okunur. */
export async function readXlsxRows(buffer: Buffer): Promise<string[][]> {
  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(buffer as unknown as ArrayBuffer);
  } catch {
    throw new ServiceError("Excel dosyası okunamadı veya bozuk");
  }
  const sheet = workbook.worksheets[0];
  if (!sheet) throw new ServiceError("Excel dosyasında sayfa bulunamadı");

  const rows: string[][] = [];
  sheet.eachRow({ includeEmpty: false }, (row) => {
    const cells: string[] = [];
    const values = row.values as unknown[];
    // ExcelJS `row.values` 1-indekslidir (index 0 boş) — atlanır.
    for (let c = 1; c < values.length; c++) {
      cells.push(cellToText(values[c]));
    }
    rows.push(cells);
  });
  return rows;
}

function cellToText(value: unknown): string {
  if (value == null) return "";
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "object") {
    const v = value as { result?: unknown; text?: unknown; richText?: { text: string }[] };
    if (Array.isArray(v.richText)) return v.richText.map((r) => r.text).join("");
    if (v.result != null) return String(v.result);
    if (v.text != null) return String(v.text);
    return "";
  }
  return String(value).trim();
}

// ---------------------------------------------------------------------------
// Başlık eşleme
// ---------------------------------------------------------------------------

const TURKISH_FOLD: Record<string, string> = {
  ı: "i",
  İ: "i",
  ş: "s",
  Ş: "s",
  ğ: "g",
  Ğ: "g",
  ü: "u",
  Ü: "u",
  ö: "o",
  Ö: "o",
  ç: "c",
  Ç: "c",
};

function foldHeader(raw: string): string {
  const noParens = raw.replace(/\([^)]*\)/g, "");
  const folded = noParens
    .split("")
    .map((ch) => TURKISH_FOLD[ch] ?? ch)
    .join("");
  return folded.toLowerCase().replace(/[^a-z0-9]/g, "");
}

const HEADER_ALIASES = {
  date: ["tarih", "islemtarihi", "isltarihi", "date", "transactiondate"],
  description: ["aciklama", "aciklamasi", "description", "detay", "islemaciklamasi"],
  amount: ["tutar", "islemtutari", "amount", "tutartl"],
  valueDate: ["valortarihi", "valor", "valuedate"],
  reference: ["referans", "referansno", "dekontno", "reference", "islemreferansi"],
  counterparty: ["karsitaraf", "karsihesap", "gonderenaliciunvani", "counterparty", "unvan"],
} as const;

type HeaderField = keyof typeof HEADER_ALIASES;
const REQUIRED_FIELDS: HeaderField[] = ["date", "description", "amount"];

export interface HeaderMap {
  date: number;
  description: number;
  amount: number;
  valueDate: number | null;
  reference: number | null;
  counterparty: number | null;
}

export function resolveHeaderMap(headerRow: string[]): HeaderMap {
  const folded = headerRow.map(foldHeader);
  const found: Partial<Record<HeaderField, number>> = {};

  for (const field of Object.keys(HEADER_ALIASES) as HeaderField[]) {
    const aliases: readonly string[] = HEADER_ALIASES[field];
    const idx = folded.findIndex((h) => aliases.includes(h));
    if (idx >= 0) found[field] = idx;
  }

  const missing = REQUIRED_FIELDS.filter((f) => found[f] === undefined);
  if (missing.length > 0) {
    throw new ServiceError(
      `Gerekli sütunlar bulunamadı: ${missing.map((f) => HEADER_ALIASES[f][0]).join(", ")}. ` +
        `Dosyada "Tarih", "Açıklama" ve "Tutar" başlıklı sütunlar olmalıdır.`,
    );
  }

  return {
    date: found.date as number,
    description: found.description as number,
    amount: found.amount as number,
    valueDate: found.valueDate ?? null,
    reference: found.reference ?? null,
    counterparty: found.counterparty ?? null,
  };
}

// ---------------------------------------------------------------------------
// Alan ayrıştırma (tarih/tutar) — Türkiye pazarı biçimleri
// ---------------------------------------------------------------------------

/** `GG.AA.YYYY`, `GG/AA/YYYY`, `GG-AA-YYYY` veya ISO `YYYY-MM-DD` kabul eder. Belirsiz/geçersiz olan her şey null döner — asla tahmin edilmez. */
export function parseFlexibleDate(raw: string): Date | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(trimmed);
  const dmy = /^(\d{2})[./-](\d{2})[./-](\d{4})$/.exec(trimmed);

  let year: number, month: number, day: number;
  if (iso) {
    year = Number(iso[1]);
    month = Number(iso[2]);
    day = Number(iso[3]);
  } else if (dmy) {
    day = Number(dmy[1]);
    month = Number(dmy[2]);
    year = Number(dmy[3]);
  } else {
    return null;
  }

  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    return null; // ör. 31.02.2025 gibi takvimde var olmayan bir tarih
  }
  return date;
}

/**
 * Türkçe (`1.234,56`) ve İngilizce (`1,234.56`) biçimlerini kabul eder.
 * Belirsiz/geçersiz/sıfır tutar null döner — asla sessizce 0'a düşürülmez.
 */
export function parseTurkishAmount(raw: string): Prisma.Decimal | null {
  let s = raw.trim();
  if (!s) return null;

  let negative = false;
  if (/^\(.*\)$/.test(s)) {
    negative = true;
    s = s.slice(1, -1).trim();
  }
  s = s.replace(/[₺TRYtry\s]/g, "");
  if (s.startsWith("-")) {
    negative = true;
    s = s.slice(1);
  } else if (s.startsWith("+")) {
    s = s.slice(1);
  }
  if (!s) return null;
  if (!/^[0-9.,]+$/.test(s)) return null;

  const lastComma = s.lastIndexOf(",");
  const lastDot = s.lastIndexOf(".");
  let normalized: string;

  if (lastComma >= 0 && lastDot >= 0) {
    if (lastComma > lastDot) {
      normalized = s.replace(/\./g, "").replace(",", ".");
    } else {
      normalized = s.replace(/,/g, "");
    }
  } else if (lastComma >= 0) {
    const decimals = s.length - lastComma - 1;
    normalized = decimals === 2 && s.indexOf(",") === lastComma ? s.replace(",", ".") : s.replace(/,/g, "");
  } else if (lastDot >= 0) {
    const decimals = s.length - lastDot - 1;
    normalized = decimals === 2 && s.indexOf(".") === lastDot ? s : s.replace(/\./g, "");
  } else {
    normalized = s;
  }

  if (!/^\d+(\.\d{1,2})?$/.test(normalized)) return null;

  const value = new Prisma.Decimal(normalized).toDecimalPlaces(2);
  if (value.isZero()) return null;
  return negative ? value.negated() : value;
}

// ---------------------------------------------------------------------------
// Parmak izi
// ---------------------------------------------------------------------------

function sha256(input: string): string {
  return crypto.createHash("sha256").update(input, "utf8").digest("hex");
}

export function computeFileFingerprint(buffer: Buffer): string {
  let bytes = buffer;
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    bytes = bytes.subarray(3);
  }
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

/**
 * Satır parmak izi — GÜÇLÜ (banka referanslı) veya ZAYIF (dosya kapsamlı)
 * olarak hesaplanır; hangisi seçilirse seçilsin `occurrenceIndex` ASLA
 * dosyalar arası bir kimlik kanıtı olarak kullanılmaz. Bkz. modül başı
 * yorumu (tam tasarım gerekçesi).
 */
export function computeRowFingerprint(params: {
  organizationId: string;
  financialAccountId: string;
  fileFingerprint: string;
  transactionDateIso: string;
  valueDateIso: string;
  amount: string;
  direction: string;
  currency: string;
  bankReference: string;
  description: string;
  occurrenceIndex: number;
}): string {
  const bankReference = params.bankReference.trim().toLowerCase();
  if (bankReference.length > 0) {
    // GÜÇLÜ: banka referansı bankanın kendisinin verdiği kararlı bir işlem
    // kimliğidir — dosyalar arası (hatta tekrar yüklemeler arası) global
    // benzersiz kimlik olarak güvenle kullanılabilir. Tarih/tutar/açıklama/
    // dosya kimliği KASITLI OLARAK dışlanır: aksi halde aynı referansın
    // farklı dosyalarda hafifçe farklı biçimlendirilmiş (ör. açıklama
    // normalize farkı) görünmesi yanlışlıkla ayrı satırlar üretebilirdi.
    const key = ["REF", params.organizationId, params.financialAccountId, params.currency, bankReference].join("|");
    return sha256(key);
  }
  // ZAYIF: kaynak veride global kararlı bir kimlik YOK — parmak izi dosya
  // kimliğiyle (fileFingerprint) sınırlanır, yalnızca AYNI dosya İÇİNDEKİ
  // mükerrer koruma sağlar. occurrenceIndex, dosya içinde görünüşte özdeş
  // satırları ayırt eder (bkz. modül başı yorumu).
  const key = [
    "CONTENT",
    params.organizationId,
    params.financialAccountId,
    params.fileFingerprint,
    params.transactionDateIso,
    params.valueDateIso,
    params.amount,
    params.direction,
    params.currency,
    params.description.trim().toLowerCase().slice(0, 200),
    String(params.occurrenceIndex),
  ].join("|");
  return sha256(key);
}

/**
 * ERROR satırları hiçbir finansal etkiye sahip değildir, ancak aynı gerekçeyle
 * (bkz. `computeRowFingerprint` ZAYIF yol) dosya kimliğiyle sınırlanır —
 * farklı bir dosyadaki görünüşte özdeş bozuk satır sessizce atlanmaz.
 */
export function computeErrorRowFingerprint(params: {
  organizationId: string;
  financialAccountId: string;
  fileFingerprint: string;
  rawRowJson: Record<string, string>;
  occurrenceIndex: number;
}): string {
  const key = [
    "ERROR",
    params.organizationId,
    params.financialAccountId,
    params.fileFingerprint,
    JSON.stringify(params.rawRowJson),
    String(params.occurrenceIndex),
  ].join("|");
  return sha256(key);
}

// ---------------------------------------------------------------------------
// Ana giriş noktası
// ---------------------------------------------------------------------------

export interface ParsedBankRow {
  status: "IMPORTED" | "ERROR";
  transactionDate: Date | null;
  valueDate: Date | null;
  amount: Prisma.Decimal | null;
  currency: string | null;
  direction: MovementDirection | null;
  description: string;
  bankReference: string | null;
  counterparty: string | null;
  rawRowJson: Record<string, string>;
  errorMessage: string | null;
  rowFingerprint: string;
}

export async function extractRawRows(buffer: Buffer): Promise<{ kind: BankStatementFileKind; rows: string[][] }> {
  if (buffer.length === 0) throw new ServiceError("Boş dosya yüklenemez");
  if (buffer.length > MAX_UPLOAD_SIZE_BYTES) throw new ServiceError("Dosya boyutu 5 MB sınırını aşıyor");

  const kind = sniffFileKind(buffer);
  if (kind === "xlsx") {
    return { kind, rows: await readXlsxRows(buffer) };
  }

  const text = decodeCsvText(buffer);
  if (text === null) {
    throw new ServiceError("Dosya UTF-8 metin olarak okunamadı veya desteklenmeyen bir ikili biçimde");
  }
  return { kind: "csv", rows: parseCsvRows(text) };
}

/**
 * Ham satırları normalize edilmiş `ParsedBankRow[]`'a çevirir. Bu fonksiyon
 * hiçbir DB erişimi yapmaz — dedup/idempotency yalnızca çağıran serviste,
 * DB-zorunlu benzersizlik kısıtlarıyla uygulanır.
 */
export function normalizeBankStatementRows(params: {
  rows: string[][];
  organizationId: string;
  financialAccountId: string;
  currency: string;
  fileFingerprint: string;
}): ParsedBankRow[] {
  const { rows, organizationId, financialAccountId, currency, fileFingerprint } = params;
  if (rows.length === 0) throw new ServiceError("Dosyada hiç satır bulunamadı");

  const headerMap = resolveHeaderMap(rows[0]);
  const dataRows = rows.slice(1).filter((r) => r.some((c) => c.trim() !== ""));
  if (dataRows.length === 0) throw new ServiceError("Dosyada başlık dışında hiç veri satırı bulunamadı");
  if (dataRows.length > MAX_DATA_ROWS) {
    throw new ServiceError(`Dosya en fazla ${MAX_DATA_ROWS} veri satırı içerebilir (bu dosyada ${dataRows.length} satır var)`);
  }

  const cell = (row: string[], idx: number | null): string => (idx == null ? "" : (row[idx] ?? "").trim());

  const occurrenceCounters = new Map<string, number>();
  const nextOccurrence = (key: string): number => {
    const n = occurrenceCounters.get(key) ?? 0;
    occurrenceCounters.set(key, n + 1);
    return n;
  };

  return dataRows.map((row) => {
    const rawRowJson: Record<string, string> = {
      tarih: cell(row, headerMap.date),
      aciklama: cell(row, headerMap.description),
      tutar: cell(row, headerMap.amount),
      valorTarihi: cell(row, headerMap.valueDate),
      referans: cell(row, headerMap.reference),
      karsiTaraf: cell(row, headerMap.counterparty),
    };

    const transactionDate = parseFlexibleDate(rawRowJson.tarih);
    const amount = parseTurkishAmount(rawRowJson.tutar);
    const description = rawRowJson.aciklama;
    const valueDate = rawRowJson.valorTarihi ? parseFlexibleDate(rawRowJson.valorTarihi) : null;

    if (!transactionDate || !amount) {
      const reasons: string[] = [];
      if (!transactionDate) reasons.push("tarih ayrıştırılamadı/belirsiz");
      if (!amount) reasons.push("tutar ayrıştırılamadı/belirsiz/sıfır");
      const errKey = `error|${JSON.stringify(rawRowJson)}`;
      const rowFingerprint = computeErrorRowFingerprint({
        organizationId,
        financialAccountId,
        fileFingerprint,
        rawRowJson,
        occurrenceIndex: nextOccurrence(errKey),
      });
      return {
        status: "ERROR",
        transactionDate: null,
        valueDate: null,
        amount: null,
        currency: null,
        direction: null,
        description,
        bankReference: rawRowJson.referans || null,
        counterparty: rawRowJson.karsiTaraf || null,
        rawRowJson,
        errorMessage: reasons.join("; "),
        rowFingerprint,
      };
    }

    const direction: MovementDirection = amount.isNegative() ? "DEBIT" : "CREDIT";
    const absAmount = amount.abs();
    const bankReference = rawRowJson.referans || null;

    const dedupKey = [
      transactionDate.toISOString(),
      absAmount.toString(),
      direction,
      currency,
      (bankReference ?? "").toLowerCase(),
      description.toLowerCase(),
    ].join("|");

    const rowFingerprint = computeRowFingerprint({
      organizationId,
      financialAccountId,
      fileFingerprint,
      transactionDateIso: transactionDate.toISOString(),
      valueDateIso: valueDate?.toISOString() ?? "",
      amount: absAmount.toString(),
      direction,
      currency,
      bankReference: bankReference ?? "",
      description,
      occurrenceIndex: nextOccurrence(dedupKey),
    });

    return {
      status: "IMPORTED",
      transactionDate,
      valueDate,
      amount: absAmount,
      currency,
      direction,
      description,
      bankReference,
      counterparty: rawRowJson.karsiTaraf || null,
      rawRowJson,
      errorMessage: null,
      rowFingerprint,
    };
  });
}
