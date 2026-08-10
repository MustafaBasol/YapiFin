import { z } from "zod";
import { CANONICAL_BILLING_PLAN_CODES, BILLING_INTERVALS, type BillingInterval } from "@/lib/billing/stripe-config";

/**
 * YF-809 — form (client) ve server action'ın ortak doğrulama kaynağı. İkinci
 * bir allowlist İCAT EDİLMEZ: `CANONICAL_BILLING_PLAN_CODES`/`BILLING_INTERVALS`
 * doğrudan buradan okunur (bkz. lib/billing/stripe-config.ts).
 */
export const startCheckoutSchema = z.object({
  planCode: z.string().refine((v) => CANONICAL_BILLING_PLAN_CODES.includes(v), "Geçersiz plan kodu"),
  billingInterval: z
    .string()
    .refine((v): v is BillingInterval => BILLING_INTERVALS.includes(v as BillingInterval), "Geçersiz faturalama aralığı"),
});

export type StartCheckoutInput = z.infer<typeof startCheckoutSchema>;
