"use server";

import { redirect } from "next/navigation";
import { requireRole } from "@/lib/auth/guard";
import { createPlanCheckoutSession } from "@/server/services/billing/checkout-service";
import { reconcileOrganizationStripeSubscription } from "@/server/services/billing/webhook-service";
import { startCheckoutSchema } from "@/lib/validation/billing";
import type { ActionState } from "@/lib/action-state";
import { toActionError } from "@/lib/action-error";

/**
 * YF-809 — Stripe Checkout başlatma. Başarıda kullanıcıyı doğrudan Stripe'ın
 * barındırmalı ödeme sayfasına yönlendirir (`redirect()`); bu ekranda hiçbir
 * plan/entitlement mutasyonu YAPILMAZ (bkz.
 * server/services/billing/checkout-service.ts dosya başı not).
 */
export async function startCheckoutAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const actor = await requireRole(["OWNER"]);
  const parsed = startCheckoutSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Form geçersiz" };
  }

  let checkoutUrl: string;
  try {
    const session = await createPlanCheckoutSession(actor, parsed.data);
    checkoutUrl = session.checkoutUrl;
  } catch (err) {
    return toActionError(err);
  }

  redirect(checkoutUrl);
}

/**
 * YF-810 — dahili/manuel mutabakat (reconciliation) tetikleyicisi. Webhook
 * teslimatı gecikmiş/kaçırılmışsa, kullanıcının Stripe Checkout'tan
 * (`success_url`) dönüşünde durumu HEMEN Stripe'ın güncel gerçeğiyle
 * yeniden hizalamak için kullanılabilir. **Bu ASLA doğrudan bir plan/
 * entitlement mutasyonu OLUŞTURMAZ** — yalnızca Stripe'ı SORAR ve GERÇEKTEN
 * ne dönerse (webhook'un uygulayacağı AYNI, tek doğruluk kaynağı mantıkla)
 * onu uygular (bkz. server/services/billing/webhook-service.ts
 * `reconcileOrganizationStripeSubscription`) — checkout redirect'inin
 * kendisi HÂLÂ hiçbir şey KAZANDIRMAZ.
 */
export async function reconcileBillingAction(_prev: ActionState, _formData: FormData): Promise<ActionState> {
  const actor = await requireRole(["OWNER"]);
  try {
    const result = await reconcileOrganizationStripeSubscription(actor);
    if (!result.found) {
      return { success: "Ödeme sağlayıcısında bu organizasyona ait bir abonelik bulunamadı." };
    }
    return { success: `Abonelik durumu güncellendi: ${result.status ?? "bilinmiyor"}.` };
  } catch (err) {
    return toActionError(err);
  }
}
