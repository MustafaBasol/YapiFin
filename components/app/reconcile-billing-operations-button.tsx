"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";
import { reconcileBillingOperationsAction } from "@/app/actions/billing";
import { initialActionState } from "@/lib/action-state";
import { FormAlert } from "@/components/auth/field-error";

/**
 * YF-815 — `ReconcileBillingButton` (YF-810) ile AYNI desen: bekleyen iade/
 * açık uyuşmazlık kayıtlarının mutabakatını manuel tetikler. Webhook zaten
 * bağımsız olarak AYNI sonucu uygulayacaktır — bu buton yalnızca beklemeyi
 * KISALTIR.
 */
export function ReconcileBillingOperationsButton() {
  const [state, formAction] = useActionState(reconcileBillingOperationsAction, initialActionState);

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
      {pending ? "Kontrol ediliyor…" : "Bekleyen kayıtları şimdi kontrol et"}
    </button>
  );
}
