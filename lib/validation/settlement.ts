import { z } from "zod";

export const paymentMethodEnum = z.enum(["NAKIT", "HAVALE_EFT", "KREDI_KARTI", "CEK", "SENET", "DIGER"]);

export const PAYMENT_METHOD_LABELS: Record<z.infer<typeof paymentMethodEnum>, string> = {
  NAKIT: "Nakit",
  HAVALE_EFT: "Havale/EFT",
  KREDI_KARTI: "Kredi Kartı",
  CEK: "Çek",
  SENET: "Senet",
  DIGER: "Diğer",
};

export const createSettlementSchema = z.object({
  transactionId: z.string().min(1),
  financialAccountId: z.string().min(1, "Hesap seçimi zorunludur"),
  amount: z.coerce.number().positive("Tutar sıfırdan büyük olmalıdır"),
  settlementDate: z.coerce.date(),
  paymentMethod: paymentMethodEnum,
  referenceNumber: z.string().trim().max(80).optional().or(z.literal("")),
  notes: z.string().trim().max(500).optional().or(z.literal("")),
  idempotencyKey: z.string().trim().min(1).max(100),
});
export type CreateSettlementInput = z.infer<typeof createSettlementSchema>;

export const cancelSettlementSchema = z.object({
  id: z.string().min(1),
  reason: z.string().trim().min(3, "İptal nedeni zorunludur").max(500),
});
export type CancelSettlementInput = z.infer<typeof cancelSettlementSchema>;
