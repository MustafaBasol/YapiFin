import { z } from "zod";

const emptyToUndefined = (v: unknown) => (v === "" ? undefined : v);

/**
 * `lib/validation/project-budget.ts` plannedAmountSchema ile aynı desen:
 * en fazla 2 ondalık basamaklı, negatif olmayan bir ondalık string —
 * `Number()` aritmetiğinden asla geçirilmez (bkz. CLAUDE.md "Para
 * tutarlarında floating point kullanılmamalıdır").
 */
const DECIMAL_AMOUNT_PATTERN = /^(0|[1-9]\d{0,15})(\.\d{1,2})?$/;
const ZERO_AMOUNT_PATTERN = /^0(\.0{1,2})?$/;

function moneyAmountSchema(opts: { allowZero: boolean; requiredMessage: string; positiveMessage?: string }) {
  return z
    .union([z.string(), z.number()])
    .transform((v) => (typeof v === "number" ? v.toString() : v.trim()))
    .superRefine((v, ctx) => {
      if (v.length === 0) {
        ctx.addIssue({ code: "custom", message: opts.requiredMessage });
        return;
      }
      if (!DECIMAL_AMOUNT_PATTERN.test(v)) {
        ctx.addIssue({
          code: "custom",
          message: "Geçerli bir tutar giriniz (en fazla 2 ondalık basamak, negatif olamaz)",
        });
        return;
      }
      if (!opts.allowZero && ZERO_AMOUNT_PATTERN.test(v)) {
        ctx.addIssue({ code: "custom", message: opts.positiveMessage ?? "Tutar sıfırdan büyük olmalıdır" });
      }
    });
}

const grossAmountSchema = moneyAmountSchema({
  allowZero: false,
  requiredMessage: "Brüt hakediş tutarı zorunludur",
  positiveMessage: "Brüt hakediş tutarı sıfırdan büyük olmalıdır",
});

const deductionAmountSchema = z.preprocess(
  emptyToUndefined,
  moneyAmountSchema({
    allowZero: true,
    requiredMessage: "Kesinti tutarı zorunludur",
  }).default("0"),
);

const notesSchema = z.preprocess(
  emptyToUndefined,
  z.string().trim().max(1000, "Not en fazla 1000 karakter olabilir").optional(),
);

export const createProgressPaymentSchema = z
  .object({
    projectId: z.string().min(1, "Proje zorunludur"),
    categoryId: z.string().min(1, "Kategori zorunludur"),
    periodStartDate: z.coerce.date(),
    periodEndDate: z.coerce.date(),
    dueDate: z.preprocess(emptyToUndefined, z.coerce.date().optional()),
    grossAmount: grossAmountSchema,
    deductionAmount: deductionAmountSchema,
    notes: notesSchema,
  })
  .refine((v) => v.periodEndDate.getTime() >= v.periodStartDate.getTime(), {
    message: "Dönem bitiş tarihi başlangıç tarihinden önce olamaz",
    path: ["periodEndDate"],
  });
export type CreateProgressPaymentInput = z.infer<typeof createProgressPaymentSchema>;

export const updateProgressPaymentSchema = z
  .object({
    id: z.string().min(1),
    categoryId: z.string().min(1, "Kategori zorunludur"),
    periodStartDate: z.coerce.date(),
    periodEndDate: z.coerce.date(),
    dueDate: z.preprocess(emptyToUndefined, z.coerce.date().optional()),
    grossAmount: grossAmountSchema,
    deductionAmount: deductionAmountSchema,
    notes: notesSchema,
  })
  .refine((v) => v.periodEndDate.getTime() >= v.periodStartDate.getTime(), {
    message: "Dönem bitiş tarihi başlangıç tarihinden önce olamaz",
    path: ["periodEndDate"],
  });
export type UpdateProgressPaymentInput = z.infer<typeof updateProgressPaymentSchema>;

export const progressPaymentIdSchema = z.object({ id: z.string().min(1) });
export type ProgressPaymentIdInput = z.infer<typeof progressPaymentIdSchema>;

export const rejectProgressPaymentSchema = z.object({
  id: z.string().min(1),
  reason: z.string().trim().min(3, "Red nedeni zorunludur").max(500),
});
export type RejectProgressPaymentInput = z.infer<typeof rejectProgressPaymentSchema>;

export const cancelProgressPaymentSchema = z.object({
  id: z.string().min(1),
  reason: z.string().trim().min(3, "İptal nedeni zorunludur").max(500),
});
export type CancelProgressPaymentInput = z.infer<typeof cancelProgressPaymentSchema>;

export const createExtraWorkItemSchema = z.object({
  progressPaymentId: z.string().min(1),
  description: z.string().trim().min(2, "Açıklama zorunludur").max(300),
  amount: moneyAmountSchema({
    allowZero: false,
    requiredMessage: "Tutar zorunludur",
    positiveMessage: "Tutar sıfırdan büyük olmalıdır",
  }),
});
export type CreateExtraWorkItemInput = z.infer<typeof createExtraWorkItemSchema>;

export const extraWorkItemIdSchema = z.object({ id: z.string().min(1) });
export type ExtraWorkItemIdInput = z.infer<typeof extraWorkItemIdSchema>;
