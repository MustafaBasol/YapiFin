import { z } from "zod";

const emptyToUndefined = (v: unknown) => (v === "" ? undefined : v);

export const createIncomeSchema = z.object({
  projectId: z.preprocess(emptyToUndefined, z.string().min(1).optional()),
  customerId: z.preprocess(emptyToUndefined, z.string().min(1).optional()),
  categoryId: z.string().min(1, "Kategori zorunludur"),
  documentNumber: z.string().trim().max(60).optional().or(z.literal("")),
  description: z.string().trim().min(2, "Açıklama zorunludur").max(300),
  issueDate: z.coerce.date(),
  dueDate: z.preprocess(emptyToUndefined, z.coerce.date().optional()),
  subtotal: z.coerce.number().positive("Ara toplam sıfırdan büyük olmalıdır"),
  taxRate: z.coerce.number().min(0, "KDV oranı negatif olamaz").max(100, "KDV oranı 100'den büyük olamaz").default(0),
});
export type CreateIncomeInput = z.infer<typeof createIncomeSchema>;

export const updateIncomeSchema = createIncomeSchema.extend({ id: z.string().min(1) });
export type UpdateIncomeInput = z.infer<typeof updateIncomeSchema>;

export const createExpenseSchema = z.object({
  projectId: z.preprocess(emptyToUndefined, z.string().min(1).optional()),
  supplierId: z.preprocess(emptyToUndefined, z.string().min(1).optional()),
  categoryId: z.string().min(1, "Kategori zorunludur"),
  documentNumber: z.string().trim().max(60).optional().or(z.literal("")),
  description: z.string().trim().min(2, "Açıklama zorunludur").max(300),
  issueDate: z.coerce.date(),
  dueDate: z.preprocess(emptyToUndefined, z.coerce.date().optional()),
  subtotal: z.coerce.number().positive("Ara toplam sıfırdan büyük olmalıdır"),
  taxRate: z.coerce.number().min(0, "KDV oranı negatif olamaz").max(100, "KDV oranı 100'den büyük olamaz").default(0),
});
export type CreateExpenseInput = z.infer<typeof createExpenseSchema>;

export const updateExpenseSchema = createExpenseSchema.extend({ id: z.string().min(1) });
export type UpdateExpenseInput = z.infer<typeof updateExpenseSchema>;

export const transactionIdSchema = z.object({ id: z.string().min(1) });
export type TransactionIdInput = z.infer<typeof transactionIdSchema>;

export const cancelTransactionSchema = z.object({
  id: z.string().min(1),
  reason: z.string().trim().min(3, "İptal nedeni zorunludur").max(500),
});
export type CancelTransactionInput = z.infer<typeof cancelTransactionSchema>;
