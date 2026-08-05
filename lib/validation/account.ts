import { z } from "zod";

const emptyToUndefined = (v: unknown) => (v === "" ? undefined : v);
const normalizeIban = (v: unknown) => (typeof v === "string" ? v.replace(/\s+/g, "").toUpperCase() : v);

export const financialAccountTypeEnum = z.enum(["CASH", "BANK", "CREDIT_CARD", "PARTNER_ACCOUNT", "OTHER"]);

export const createAccountSchema = z.object({
  name: z.string().trim().min(2, "Hesap adı zorunludur").max(120),
  type: financialAccountTypeEnum,
  bankName: z.string().trim().max(120).optional().or(z.literal("")),
  iban: z.preprocess(
    (v) => emptyToUndefined(normalizeIban(v)),
    z
      .string()
      .regex(/^TR\d{24}$/, "Geçerli bir IBAN girin (TR ile başlayan 26 karakter)")
      .optional(),
  ),
  openingBalance: z.coerce.number().min(0, "Açılış bakiyesi negatif olamaz").default(0),
  currency: z.string().trim().toUpperCase().length(3, "Para birimi 3 harfli olmalıdır (ör. TRY)").default("TRY"),
});
export type CreateAccountInput = z.infer<typeof createAccountSchema>;

export const updateAccountSchema = z.object({
  id: z.string().min(1),
  name: z.string().trim().min(2, "Hesap adı zorunludur").max(120),
  bankName: z.string().trim().max(120).optional().or(z.literal("")),
  iban: z.preprocess(
    (v) => emptyToUndefined(normalizeIban(v)),
    z
      .string()
      .regex(/^TR\d{24}$/, "Geçerli bir IBAN girin (TR ile başlayan 26 karakter)")
      .optional(),
  ),
});
export type UpdateAccountInput = z.infer<typeof updateAccountSchema>;

export const accountIdSchema = z.object({ id: z.string().min(1) });
export type AccountIdInput = z.infer<typeof accountIdSchema>;
