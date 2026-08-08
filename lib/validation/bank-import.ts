import { z } from "zod";

export const uploadBankStatementSchema = z.object({
  financialAccountId: z.string().min(1, "Hesap seçimi zorunludur"),
});
export type UploadBankStatementInput = z.infer<typeof uploadBankStatementSchema>;

export const confirmBankImportRowAsSettlementSchema = z.object({
  rowId: z.string().min(1),
  transactionId: z.string().min(1, "Kayıt seçimi zorunludur"),
});
export type ConfirmBankImportRowAsSettlementInput = z.infer<typeof confirmBankImportRowAsSettlementSchema>;

export const confirmBankImportRowAsTransferSchema = z.object({
  rowId: z.string().min(1),
  counterpartAccountId: z.string().min(1, "Karşı hesap seçimi zorunludur"),
});
export type ConfirmBankImportRowAsTransferInput = z.infer<typeof confirmBankImportRowAsTransferSchema>;

export const ignoreBankImportRowSchema = z.object({
  rowId: z.string().min(1),
});
export type IgnoreBankImportRowInput = z.infer<typeof ignoreBankImportRowSchema>;
