import { z } from "zod";

/** YF-820 — manuel Platform Admin mutabakat (reconciliation) formu. `organizationId` her zaman gizli bir form alanından (sunucuda zaten doğrulanmış route parametresinden türetilir) gelir — istemci tarafından İCAT EDİLEBİLECEK bir Stripe kimliği DEĞİLDİR. */
export const platformBillingReconciliationSchema = z.object({
  organizationId: z.string().trim().min(1, "Organizasyon kimliği zorunludur"),
  reason: z.string().trim().max(500, "Neden en fazla 500 karakter olabilir").optional().or(z.literal("")),
});
export type PlatformBillingReconciliationInput = z.infer<typeof platformBillingReconciliationSchema>;
