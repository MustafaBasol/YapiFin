"use server";

import { redirect } from "next/navigation";
import { requireRole } from "@/lib/auth/guard";
import { createPlanCheckoutSession } from "@/server/services/billing/checkout-service";
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
