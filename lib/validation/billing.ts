import { z } from "zod";
import { CANONICAL_BILLING_PLAN_CODES, BILLING_INTERVALS, type BillingInterval } from "@/lib/billing/stripe-config";
import { ADDON_KEYS } from "@/lib/billing/addon-catalog";

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

/**
 * YF-813 — istemciden yalnızca `addonKey` kabul edilir (bkz.
 * server/services/billing/addon-checkout-service.ts dosya başı "girdi
 * güveni" notu — `startCheckoutSchema` ile AYNI ilke, ikinci bir allowlist
 * İCAT EDİLMEZ: `ADDON_KEYS` doğrudan lib/billing/addon-catalog.ts'ten okunur).
 */
export const purchaseAddonSchema = z.object({
  addonKey: z.string().refine((v) => ADDON_KEYS.includes(v), "Geçersiz ek paket"),
});

export type PurchaseAddonInput = z.infer<typeof purchaseAddonSchema>;

/** YF-813 — mutabakat (reconciliation) formu, Stripe'ın `success_url`'e yerleştirdiği `session_id`'yi taşır. */
export const reconcileAddonPurchaseSchema = z.object({
  checkoutSessionId: z.string().min(1, "Ödeme oturumu kimliği zorunludur"),
});
