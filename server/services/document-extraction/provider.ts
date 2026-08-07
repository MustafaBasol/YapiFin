/**
 * YF-601 — Sağlayıcıdan bağımsız (provider-neutral) belge çıkarım soyutlaması.
 *
 * Bilinçli tasarım kararı: bu görev herhangi bir OCR/Document-AI sağlayıcısı
 * (Google Vision, Azure Document Intelligence, AWS Textract vb.) için API
 * anahtarı/kimlik bilgisi eklemez ve OCR model eğitimi kapsam dışıdır (bkz.
 * görev talimatı "OCR training/model development" — MVP dışı). Bu nedenle
 * varsayılan ve tek üretim sağlayıcısı `nullDocumentExtractionProvider`dır:
 * her zaman güvenli, veri UYDURMAYAN, boş/belirsiz bir sonuç döner — kullanıcı
 * tüm alanları elle doldurup onaylar. Gerçek bir sağlayıcı eklenmek
 * istendiğinde tek yapılması gereken bu arayüzü uygulayan yeni bir modül
 * yazıp servis katmanına enjekte etmektir (bkz.
 * server/services/document-extraction-service.ts `uploadAndExtractDocument`
 * ikinci parametresi) — yeni bir plugin/registry çatısı gerekmez.
 */

/** Tek bir alan için aday değer. `confidence` sağlayıcı raporlamıyorsa null'dır — asla uydurulmaz. */
export interface DocumentExtractionFieldCandidate<T> {
  value: T | null;
  confidence: number | null;
}

/**
 * Tüm parasal/tarih alanları HAM STRING olarak taşınır — hiçbir alan burada
 * `Number()`/`Date()` ile parse edilmez veya doğrulanmaz. Belirsizlik
 * kasıtlı olarak korunur (bkz. görev talimatı "Preserve ambiguity instead of
 * inventing values"); gerçek doğrulama yalnızca kullanıcı onayında
 * `lib/validation/document-extraction.ts` (mevcut `createExpenseSchema`)
 * üzerinden, tek bir yerde yapılır.
 */
export interface DocumentExtractionResult {
  supplierName: DocumentExtractionFieldCandidate<string>;
  documentNumber: DocumentExtractionFieldCandidate<string>;
  /** Sağlayıcının okuduğu ham tarih metni (ör. "12.03.2025") — ayrıştırılmamış. */
  documentDateRaw: DocumentExtractionFieldCandidate<string>;
  subtotalAmountRaw: DocumentExtractionFieldCandidate<string>;
  taxAmountRaw: DocumentExtractionFieldCandidate<string>;
  totalAmountRaw: DocumentExtractionFieldCandidate<string>;
  /** ISO 4217 kodu (ör. "TRY") — yalnızca sağlayıcı yüksek güvenle tanıdıysa doludur. */
  currency: DocumentExtractionFieldCandidate<string>;
}

export interface DocumentExtractionInput {
  buffer: Buffer;
  mimeType: string;
}

export interface DocumentExtractionProvider {
  /** `DocumentExtraction.providerName` alanına yazılır — denetlenebilirlik için. */
  readonly name: string;
  extract(input: DocumentExtractionInput): Promise<DocumentExtractionResult>;
}

function emptyCandidate<T>(): DocumentExtractionFieldCandidate<T> {
  return { value: null, confidence: null };
}

export function emptyExtractionResult(): DocumentExtractionResult {
  return {
    supplierName: emptyCandidate(),
    documentNumber: emptyCandidate(),
    documentDateRaw: emptyCandidate(),
    subtotalAmountRaw: emptyCandidate(),
    taxAmountRaw: emptyCandidate(),
    totalAmountRaw: emptyCandidate(),
    currency: emptyCandidate(),
  };
}

/**
 * Varsayılan/üretim sağlayıcısı. Kasıtlı olarak hiçbir alanı doldurmaz —
 * "OCR sağlayıcısı yapılandırılmadı" durumunu dürüstçe temsil eder. Boru
 * hattının geri kalanı (yükleme, doğrulama, tenant/rol izolasyonu, taslak
 * durumu, insan onayı, canonical gider oluşturma) bu sağlayıcıdan tamamen
 * bağımsız çalışır ve tam olarak üretime hazırdır.
 */
export const nullDocumentExtractionProvider: DocumentExtractionProvider = {
  name: "none",
  async extract(): Promise<DocumentExtractionResult> {
    return emptyExtractionResult();
  },
};
