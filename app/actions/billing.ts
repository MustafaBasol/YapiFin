"use server";

import { redirect } from "next/navigation";
import { requireRole } from "@/lib/auth/guard";
import { createPlanCheckoutSession } from "@/server/services/billing/checkout-service";
import { reconcileOrganizationStripeSubscription } from "@/server/services/billing/webhook-service";
import { createAddonCheckoutSession } from "@/server/services/billing/addon-checkout-service";
import { reconcileAddonPurchase } from "@/server/services/billing/addon-grant-service";
import { startCheckoutSchema, purchaseAddonSchema, reconcileAddonPurchaseSchema } from "@/lib/validation/billing";
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

/**
 * YF-813 — kullanım/ek-kota (add-on/top-up) paketi satın alma. Başarıda
 * kullanıcıyı doğrudan Stripe'ın barındırmalı ödeme sayfasına yönlendirir;
 * bu adımda hiçbir kota KAZANDIRILMAZ (bkz.
 * server/services/billing/addon-checkout-service.ts dosya başı not) — gerçek
 * bağış yalnızca webhook onayı/mutabakat sonrasında oluşur (bkz.
 * `reconcileAddonPurchaseAction`).
 */
export async function purchaseAddonAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const actor = await requireRole(["OWNER"]);
  const parsed = purchaseAddonSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Form geçersiz" };
  }

  let checkoutUrl: string;
  try {
    const session = await createAddonCheckoutSession(actor, parsed.data);
    checkoutUrl = session.checkoutUrl;
  } catch (err) {
    return toActionError(err);
  }

  redirect(checkoutUrl);
}

/**
 * YF-813 — bir add-on satın almasının onayını HEMEN kontrol eder (YF-810
 * `reconcileBillingAction`'ın add-on karşılığı, bkz.
 * server/services/billing/addon-grant-service.ts `reconcileAddonPurchase`
 * dosya başı not). Webhook zaten birkaç dakika içinde AYNI sonucu bağımsız
 * olarak uygulayacaktır — bu yalnızca beklemeyi KISALTIR, hiçbir zaman
 * doğrudan bir bağış OLUŞTURMAZ (doğrulama zinciri `confirmAddonCheckoutSession`
 * içindedir, bu action yalnızca çağırır).
 */
export async function reconcileAddonPurchaseAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const actor = await requireRole(["OWNER"]);
  const parsed = reconcileAddonPurchaseSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Form geçersiz" };
  }

  try {
    const result = await reconcileAddonPurchase(actor, parsed.data.checkoutSessionId);
    if (result.outcome === "GRANTED" || result.outcome === "ALREADY_GRANTED") {
      return { success: "Satın alma onaylandı — ek kotanız kullanıma hazır." };
    }
    return { success: "Ödeme henüz onaylanmadı. Birkaç dakika içinde tekrar deneyin." };
  } catch (err) {
    return toActionError(err);
  }
}
