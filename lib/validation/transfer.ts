import { z } from "zod";

export const createTransferSchema = z
  .object({
    fromAccountId: z.string().min(1, "Kaynak hesap zorunludur"),
    toAccountId: z.string().min(1, "Hedef hesap zorunludur"),
    amount: z.coerce.number().positive("Tutar sıfırdan büyük olmalıdır"),
    transferDate: z.coerce.date(),
    description: z.string().trim().max(300).optional().or(z.literal("")),
    idempotencyKey: z.string().trim().min(1).max(100),
  })
  .refine((v) => v.fromAccountId !== v.toAccountId, {
    message: "Kaynak ve hedef hesap aynı olamaz",
    path: ["toAccountId"],
  });
export type CreateTransferInput = z.infer<typeof createTransferSchema>;

export const cancelTransferSchema = z.object({
  id: z.string().min(1),
  reason: z.string().trim().min(3, "İptal nedeni zorunludur").max(500),
});
export type CancelTransferInput = z.infer<typeof cancelTransferSchema>;
