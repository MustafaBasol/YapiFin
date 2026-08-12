import { z } from "zod";
import { CANONICAL_BILLING_PLAN_CODES } from "@/lib/billing/stripe-config";

/**
 * YF-819 — form (client) ve server action'ın ortak doğrulama kaynağı.
 * `startCheckoutSchema` (lib/validation/billing.ts) ile AYNI ilke: ikinci
 * bir plan allowlist'i İCAT EDİLMEZ, doğrudan `CANONICAL_BILLING_PLAN_CODES`
 * (bkz. lib/billing/stripe-config.ts) reuse edilir. Bu yalnızca ŞEKİL
 * doğrulamasıdır — nihai/otoriter kontrol her zaman
 * `server/services/platform/platform-plan-override-service.ts`teki canlı
 * `Plan` tablosu (`isActive`) sorgusudur.
 */
export const platformPlanOverrideSchema = z.object({
  organizationId: z.string().min(1, "Organizasyon kimliği zorunludur"),
  planCode: z.string().refine((v) => CANONICAL_BILLING_PLAN_CODES.includes(v), "Geçersiz plan kodu"),
  reason: z
    .string()
    .trim()
    .min(10, "Gerekçe en az 10 karakter olmalıdır")
    .max(500, "Gerekçe en fazla 500 karakter olabilir"),
  /**
   * Sayfa yüklendiğinde/önizleme alındığında gözlemlenen GÜNCEL plan kodu —
   * eşzamanlılık için karşılaştır-ve-değiştir (compare-and-swap) anahtarı
   * (bkz. servis katmanı `applyPlatformPlanOverride` yorumu). Boş organizasyon
   * (plansız) durumunu temsil etmek için `"NONE"` kullanılır.
   */
  expectedCurrentPlanCode: z.string().min(1, "Beklenen güncel plan zorunludur"),
  /** Boş string = süresiz. */
  expiresAt: z
    .string()
    .optional()
    .transform((v) => (v && v.trim() !== "" ? v : undefined))
    .refine((v) => v === undefined || !Number.isNaN(Date.parse(v)), "Geçersiz son geçerlilik tarihi")
    .refine((v) => v === undefined || Date.parse(v) > Date.now(), "Son geçerlilik tarihi gelecekte olmalıdır"),
});
export type PlatformPlanOverrideInput = z.infer<typeof platformPlanOverrideSchema>;

export const platformPlanOverrideRevokeSchema = z.object({
  organizationId: z.string().min(1, "Organizasyon kimliği zorunludur"),
  /** Revoke edilecek `PlatformPlanOverride` kaydının kimliği — eşzamanlılık için karşılaştır-ve-değiştir anahtarı. */
  expectedOverrideId: z.string().min(1, "Geçersiz kılma kimliği zorunludur"),
  reason: z
    .string()
    .trim()
    .min(10, "Gerekçe en az 10 karakter olmalıdır")
    .max(500, "Gerekçe en fazla 500 karakter olabilir"),
});
export type PlatformPlanOverrideRevokeInput = z.infer<typeof platformPlanOverrideRevokeSchema>;
