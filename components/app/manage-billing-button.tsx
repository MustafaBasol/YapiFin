"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";
import { openBillingPortalAction } from "@/app/actions/billing";
import { initialActionState } from "@/lib/action-state";
import { FormAlert } from "@/components/auth/field-error";
import { cn } from "@/lib/utils";

/**
 * YF-811 — Stripe'ın barındırmalı Faturalama Portalını açan TEK paylaşılan
 * form/buton. `app/actions/billing.ts` `openBillingPortalAction` dosya başı
 * notu: hem `billing-subscription-card.tsx` (daima görünür genel CTA) HEM DE
 * `billing-dunning-banner.tsx` (YF-814 acil kurtarma CTA'sı) bu TEK bileşeni
 * kullanır — ikinci bir portal formu İCAT EDİLMEZ.
 */
interface ManageBillingButtonProps {
  readonly label?: string;
  readonly variant?: "primary" | "outline";
}

export function ManageBillingButton({ label = "Faturalamayı yönet", variant = "outline" }: ManageBillingButtonProps) {
  const [state, formAction] = useActionState(openBillingPortalAction, initialActionState);
  return (
    <form action={formAction} className="shrink-0 space-y-1.5">
      <SubmitButton label={label} variant={variant} />
      <FormAlert error={state?.error} />
    </form>
  );
}

function SubmitButton({ label, variant }: { label: string; variant: "primary" | "outline" }) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className={cn(
        "inline-block rounded-lg px-4 py-2 text-sm font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-70",
        variant === "primary"
          ? "bg-primary text-primary-foreground hover:bg-primary/90"
          : "border border-border bg-card text-foreground hover:bg-muted",
      )}
    >
      {pending ? "Yönlendiriliyor…" : label}
    </button>
  );
}
