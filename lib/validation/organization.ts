import { z } from "zod";

export const updateOrganizationSchema = z.object({
  tradeName: z.string().trim().min(2, "Firma ticari adı zorunludur").max(160),
  taxOffice: z.string().trim().max(120).optional().or(z.literal("")),
  taxNumber: z.string().trim().max(20).optional().or(z.literal("")),
  phone: z.string().trim().max(30).optional().or(z.literal("")),
  email: z.string().trim().toLowerCase().email("Geçerli bir e-posta girin").optional().or(z.literal("")),
  city: z.string().trim().max(80).optional().or(z.literal("")),
  district: z.string().trim().max(80).optional().or(z.literal("")),
  address: z.string().trim().max(300).optional().or(z.literal("")),
});
export type UpdateOrganizationInput = z.infer<typeof updateOrganizationSchema>;
