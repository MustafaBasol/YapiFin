"use client";

import { useActionState, useState } from "react";
import type { ActionState } from "@/lib/action-state";
import { initialActionState } from "@/lib/action-state";
import { Button } from "@/components/ui/button";
import { FormAlert } from "@/components/auth/field-error";

/**
 * Genel iptal/ters kayıt formu — YF-306. İptal nedeni zorunludur; onay
 * gerektiren işlemler için basit bir açılır alan kullanılır (bkz.
 * docs/UX_UI.md örnek metni: "Bu işlem iptal edilecek ve hesap hareketi ters
 * kayıtla düzeltilecektir.").
 */
export function CancelReasonForm({
  action,
  hiddenFields,
  triggerLabel,
  confirmLabel,
  warningText,
}: {
  action: (prevState: ActionState, formData: FormData) => Promise<ActionState>;
  hiddenFields: Record<string, string>;
  triggerLabel: string;
  confirmLabel: string;
  warningText: string;
}) {
  const [state, formAction, pending] = useActionState(action, initialActionState);
  const [open, setOpen] = useState(false);

  if (!open) {
    return (
      <Button type="button" variant="destructive" size="sm" onClick={() => setOpen(true)}>
        {triggerLabel}
      </Button>
    );
  }

  return (
    <form action={formAction} className="space-y-2 rounded-lg border border-destructive/30 bg-destructive/5 p-3">
      {Object.entries(hiddenFields).map(([name, value]) => (
        <input key={name} type="hidden" name={name} value={value} />
      ))}
      <p className="text-[12px] text-muted-foreground">{warningText}</p>
      <FormAlert error={state?.error} success={state?.success} />
      <div className="space-y-1">
        <label htmlFor="reason" className="text-[12px] font-medium text-foreground">
          İptal nedeni
        </label>
        <textarea
          id="reason"
          name="reason"
          rows={2}
          required
          minLength={3}
          className="flex w-full rounded-lg border border-input bg-card px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          placeholder="Zorunlu"
        />
      </div>
      <div className="flex gap-2">
        <Button type="submit" variant="destructive" size="sm" disabled={pending}>
          {confirmLabel}
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={() => setOpen(false)} disabled={pending}>
          Vazgeç
        </Button>
      </div>
    </form>
  );
}
