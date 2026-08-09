"use client";

import { useActionState } from "react";
import type { ProgressPaymentStatus } from "@prisma/client";
import {
  submitProgressPaymentAction,
  approveProgressPaymentAction,
  rejectProgressPaymentAction,
  cancelProgressPaymentAction,
} from "@/app/actions/progress-payments";
import { initialActionState } from "@/lib/action-state";
import { Button } from "@/components/ui/button";
import { FormAlert } from "@/components/auth/field-error";
import { CancelReasonForm } from "@/components/app/cancel-reason-form";

function SimpleActionForm({
  action,
  id,
  label,
}: {
  action: (prevState: import("@/lib/action-state").ActionState, formData: FormData) => Promise<import("@/lib/action-state").ActionState>;
  id: string;
  label: string;
}) {
  const [state, formAction, pending] = useActionState(action, initialActionState);
  return (
    <form action={formAction} className="space-y-2">
      <input type="hidden" name="id" value={id} />
      <Button type="submit" size="sm" disabled={pending}>
        {label}
      </Button>
      <FormAlert error={state?.error} success={state?.success} />
    </form>
  );
}

export function ProgressPaymentActions({ id, status }: { id: string; status: ProgressPaymentStatus }) {
  if (status === "DRAFT") {
    return (
      <div className="space-y-3">
        <SimpleActionForm action={submitProgressPaymentAction} id={id} label="Onaya Gönder" />
        <CancelReasonForm
          action={cancelProgressPaymentAction}
          hiddenFields={{ id }}
          triggerLabel="Taslağı iptal et"
          confirmLabel="Taslağı iptal et"
          warningText="Bu taslak hakediş iptal edilecektir."
        />
      </div>
    );
  }

  if (status === "SUBMITTED") {
    return (
      <div className="space-y-3">
        <SimpleActionForm action={approveProgressPaymentAction} id={id} label="Onayla ve gelir tahakkuku oluştur" />
        <CancelReasonForm
          action={rejectProgressPaymentAction}
          hiddenFields={{ id }}
          triggerLabel="Reddet"
          confirmLabel="Hakedişi reddet"
          warningText="Bu hakediş reddedilecektir; gelir tahakkuku oluşturulmaz."
        />
        <CancelReasonForm
          action={cancelProgressPaymentAction}
          hiddenFields={{ id }}
          triggerLabel="İptal et"
          confirmLabel="Hakedişi iptal et"
          warningText="Bu hakediş iptal edilecektir; gelir tahakkuku oluşturulmaz."
        />
      </div>
    );
  }

  if (status === "APPROVED") {
    return (
      <p className="text-[12px] text-muted-foreground">
        Bu hakediş onaylanmış ve ilişkili gelir tahakkuku oluşturulmuştur. İptal gerekiyorsa ilişkili gelir kaydı üzerinden mevcut
        iptal akışı kullanılmalıdır.
      </p>
    );
  }

  return null;
}
