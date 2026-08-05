import { z } from "zod";

const emptyToUndefined = (v: unknown) => (v === "" ? undefined : v);

export const supplierTypeEnum = z.enum(["SUPPLIER", "SUBCONTRACTOR", "BOTH"]);

export const createSupplierSchema = z.object({
  type: supplierTypeEnum,
  name: z.string().trim().min(2, "Ad/ünvan zorunludur").max(160),
  identityOrTaxNumber: z.preprocess(
    emptyToUndefined,
    z
      .string()
      .trim()
      .regex(/^\d{10}$|^\d{11}$/, "TCKN 11, VKN 10 haneli olmalıdır")
      .optional(),
  ),
  taxOffice: z.string().trim().max(120).optional().or(z.literal("")),
  contactName: z.string().trim().max(120).optional().or(z.literal("")),
  phone: z.string().trim().max(30).optional().or(z.literal("")),
  email: z.string().trim().toLowerCase().email("Geçerli bir e-posta girin").optional().or(z.literal("")),
  city: z.string().trim().max(80).optional().or(z.literal("")),
  district: z.string().trim().max(80).optional().or(z.literal("")),
  address: z.string().trim().max(300).optional().or(z.literal("")),
});
export type CreateSupplierInput = z.infer<typeof createSupplierSchema>;

export const updateSupplierSchema = createSupplierSchema.extend({
  id: z.string().min(1),
});
export type UpdateSupplierInput = z.infer<typeof updateSupplierSchema>;

export const supplierIdSchema = z.object({ id: z.string().min(1) });
export type SupplierIdInput = z.infer<typeof supplierIdSchema>;
