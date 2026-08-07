import { z } from "zod";
import { createExpenseSchema } from "@/lib/validation/transaction";

const emptyToUndefined = (v: unknown) => (v === "" ? undefined : v);

/**
 * Yükleme adımında yalnızca proje ataması (opsiyonel) doğrulanır — dosyanın
 * kendisi (mime/boyut/magic-byte) `server/services/document-extraction-service.ts`
 * içinde imperatif olarak doğrulanır; Zod dosya/Blob içeriğini doğrulamak için
 * uygun bir araç değildir.
 */
export const uploadDocumentSchema = z.object({
  projectId: z.preprocess(emptyToUndefined, z.string().min(1).optional()),
});
export type UploadDocumentInput = z.infer<typeof uploadDocumentSchema>;

export const documentExtractionIdSchema = z.object({ id: z.string().min(1) });
export type DocumentExtractionIdInput = z.infer<typeof documentExtractionIdSchema>;

/**
 * Onay adımı, mevcut `createExpenseSchema`'yı OLDUĞU GİBİ genişletir —
 * gider oluşturma doğrulama kuralları (tutar/KDV/tarih/kategori) burada
 * TEKRARLANMAZ. Yalnızca hangi taslağın onaylandığını belirten `extractionId`
 * eklenir. OCR adayları yalnızca formu ön-doldurmak için kullanılır; burada
 * gönderilen değerler (kullanıcı tarafından görülüp gerekirse düzeltilmiş)
 * her zaman bu şemadan ve ardından `createExpense` servisinin kendi
 * yetki/tenant/ilişkili-kayıt kontrollerinden geçer.
 */
export const confirmDocumentExtractionSchema = createExpenseSchema.extend({
  extractionId: z.string().min(1),
});
export type ConfirmDocumentExtractionInput = z.infer<typeof confirmDocumentExtractionSchema>;
