"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";
import { reconcileAddonPurchaseAction } from "@/app/actions/billing";
import { initialActionState } from "@/lib/action-state";
import { FormAlert } from "@/components/auth/field-error";

/**
 * YF-813 — `ReconcileBillingButton` (YF-810) ile AYNI desen, tek bir add-on
 * Checkout Session'ına scope edilmiş (bkz.
 * server/services/billing/addon-grant-service.ts `reconcileAddonPurchase`
 * dosya başı not). Bu ASLA doğrudan bir bağış OLUŞTURMAZ — yalnızca Stripe'ı
 * SORAR.
 */
export function ReconcileAddonButton({ checkoutSessionId }: { checkoutSessionId: string }) {
  const [state, formAction] = useActionState(reconcileAddonPurchaseAction, initialActionState);

  return (
    <form action={formAction} className="space-y-2">
      <input type="hidden" name="checkoutSessionId" value={checkoutSessionId} />
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
