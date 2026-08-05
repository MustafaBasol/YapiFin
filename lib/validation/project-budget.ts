import { z } from "zod";

const emptyToUndefined = (v: unknown) => (v === "" ? undefined : v);

/**
 * Planlanan tutar en fazla 2 ondalık basamaklı, negatif olmayan, en fazla 16
 * tam sayı basamaklı bir ondalık string olarak doğrulanır (Decimal(18,2)
 * kolonuna sığar). Üstel gösterim (`1e5`), virgüllü/yerelleştirilmiş girdi
 * (`1.234,56`), `NaN`/`Infinity` ve önde sıfır (`0123`) bu düzenli ifadeyle
 * kendiliğinden reddedilir — `Number()` dönüşümü yalnızca aralık dışı devasa
 * tam sayılarda hassasiyet kaybedebileceğinden, sıfır kontrolü de saf metin
 * eşleştirmesiyle yapılır (yetkili değer hiçbir zaman `Number()` aritmetiğinden
 * geçmez).
 */
const DECIMAL_AMOUNT_PATTERN = /^(0|[1-9]\d{0,15})(\.\d{1,2})?$/;
const ZERO_AMOUNT_PATTERN = /^0(\.0{1,2})?$/;

export const plannedAmountSchema = z
  .union([z.string(), z.number()])
  .transform((v) => (typeof v === "number" ? v.toString() : v.trim()))
  .superRefine((v, ctx) => {
    if (v.length === 0) {
      ctx.addIssue({ code: "custom", message: "Planlanan tutar zorunludur" });
      return;
    }
    if (!DECIMAL_AMOUNT_PATTERN.test(v)) {
      ctx.addIssue({
        code: "custom",
        message: "Planlanan tutar geçerli bir sayı olmalıdır (en fazla 2 ondalık basamak, negatif olamaz)",
      });
      return;
    }
    if (ZERO_AMOUNT_PATTERN.test(v)) {
      ctx.addIssue({ code: "custom", message: "Planlanan tutar sıfırdan büyük olmalıdır" });
    }
  });

const descriptionSchema = z.preprocess(
  emptyToUndefined,
  z.string().trim().max(500, "Açıklama en fazla 500 karakter olabilir").optional(),
);

export const createProjectBudgetItemSchema = z.object({
  projectId: z.string().min(1, "Proje zorunludur"),
  categoryId: z.string().min(1, "Kategori zorunludur"),
  plannedAmount: plannedAmountSchema,
  description: descriptionSchema,
});
export type CreateProjectBudgetItemInput = z.infer<typeof createProjectBudgetItemSchema>;

export const updateProjectBudgetItemSchema = z.object({
  id: z.string().min(1),
  categoryId: z.string().min(1, "Kategori zorunludur"),
  plannedAmount: plannedAmountSchema,
  description: descriptionSchema,
});
export type UpdateProjectBudgetItemInput = z.infer<typeof updateProjectBudgetItemSchema>;

export const projectBudgetItemIdSchema = z.object({ id: z.string().min(1) });
export type ProjectBudgetItemIdInput = z.infer<typeof projectBudgetItemIdSchema>;
