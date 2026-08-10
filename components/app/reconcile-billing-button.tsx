"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";
import { reconcileBillingAction } from "@/app/actions/billing";
import { initialActionState } from "@/lib/action-state";
import { FormAlert } from "@/components/auth/field-error";

/**
 * YF-810 — kullanıcının Stripe Checkout'tan dönüşünde durumu HEMEN Stripe'ın
 * güncel gerçeğiyle yeniden hizalamak için manuel tetikleyici (bkz.
 * app/actions/billing.ts `reconcileBillingAction` dosya başı not — bu ASLA
 * doğrudan bir plan/entitlement mutasyonu OLUŞTURMAZ, yalnızca Stripe'ı
 * SORAR). Webhook zaten birkaç dakika içinde AYNI sonucu bağımsız olarak
 * uygulayacaktır — bu buton yalnızca beklemeyi KISALTIR.
 */
export function ReconcileBillingButton() {
  const [state, formAction] = useActionState(reconcileBillingAction, initialActionState);

  return (
    <form action={formAction} className="space-y-2">
      <SubmitButton />
      <FormAlert error={state?.error} success={state?.success} />
    </form>
  );
}

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="inline-block rounded-lg border border-border bg-card px-4 py-2 text-sm font-semibold text-foreground transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-70"
    >
      {pending ? "Kontrol ediliyor…" : "Durumu şimdi kontrol et"}
    </button>
  );
}
