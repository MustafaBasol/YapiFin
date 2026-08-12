"use server";

import { revalidatePath } from "next/cache";
import { requirePlatformAdmin } from "@/lib/auth/platform-guard";
import {
  reconcilePlatformOrganizationSubscription,
  type PlatformReconciliationResult,
} from "@/server/services/platform/platform-billing-reconciliation-service";
import { platformBillingReconciliationSchema } from "@/lib/validation/platform-billing";
import { toActionError } from "@/lib/action-error";
import type { ActionState } from "@/lib/action-state";

/**
 * YF-820 — Platform Admin-only manuel mutabakat action'ı. `requirePlatformAdmin()`
 * ZORUNLU olarak form doğrulamasından/servis çağrısından ÖNCE çağrılır —
 * oturum yoksa (tenant kullanıcısı VEYA hiç giriş yapılmamış) fail-closed
 * `/platform/login`e yönlendirilir (bkz. lib/auth/platform-guard.ts).
 * Hedef organizasyon `organizationId` form alanından okunur ama Stripe
 * müşteri/abonelik kimlikleri BURADA ASLA istemciden alınmaz — servis
 * katmanı (`reconcilePlatformOrganizationSubscription`) bunları SUNUCU
 * tarafında, kanonik `OrganizationStripeCustomer`/`OrganizationStripeSubscription`
 * eşlemesinden çözer.
 */
export interface PlatformBillingReconciliationActionState extends ActionState {
  result?: PlatformReconciliationResult;
}

export const initialPlatformBillingReconciliationState: PlatformBillingReconciliationActionState = {};

export async function reconcilePlatformOrganizationBillingAction(
  _prev: PlatformBillingReconciliationActionState,
  formData: FormData,
): Promise<PlatformBillingReconciliationActionState> {
  const admin = await requirePlatformAdmin();

  const parsed = platformBillingReconciliationSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Form geçersiz" };
  }

  try {
    const reason = parsed.data.reason?.trim() || null;
    const result = await reconcilePlatformOrganizationSubscription(admin, parsed.data.organizationId, reason);
    revalidatePath(`/platform/organizations/${parsed.data.organizationId}`);
    return {
      success:
        result.warnings.length > 0
          ? result.warnings.join(" ")
          : result.changed
            ? "Mutabakat tamamlandı — durum güncellendi."
            : "Mutabakat tamamlandı — değişiklik yoktu (zaten güncel).",
      result,
    };
  } catch (err) {
    return toActionError(err);
  }
}
