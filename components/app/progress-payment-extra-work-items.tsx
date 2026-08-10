"use client";

import { useActionState, useState } from "react";
import { Plus } from "lucide-react";
import { addExtraWorkItemAction, deleteExtraWorkItemAction } from "@/app/actions/progress-payments";
import { initialActionState } from "@/lib/action-state";
import { formatMoney } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import { FormAlert } from "@/components/auth/field-error";

interface ExtraWorkItem {
  id: string;
  description: string;
  amount: unknown;
}

function ExtraWorkItemRow({
  item,
  projectId,
  progressPaymentId,
  canEdit,
}: {
  item: ExtraWorkItem;
  projectId: string;
  progressPaymentId: string;
  canEdit: boolean;
}) {
  const [confirming, setConfirming] = useState(false);
  const [state, formAction, pending] = useActionState(deleteExtraWorkItemAction, initialActionState);

  return (
    <li className="flex items-center justify-between gap-3 border-b border-border/60 py-2 last:border-0">
      <div>
        <p className="text-[12.5px] font-medium">{item.description}</p>
      </div>
      <div className="flex items-center gap-3">
        <span className="text-[12.5px] font-semibold tabular-nums">{formatMoney(item.amount as string)}</span>
        {canEdit && !confirming && (
          <button
            type="button"
            onClick={() => setConfirming(true)}
            className="text-[12px] font-medium text-destructive hover:underline cursor-pointer"
          >
            Sil
          </button>
        )}
        {canEdit && confirming && (
          <form action={formAction} className="flex items-center gap-2">
            <input type="hidden" name="id" value={item.id} />
            <input type="hidden" name="projectId" value={projectId} />
            <input type="hidden" name="progressPaymentId" value={progressPaymentId} />
            <button type="submit" disabled={pending} className="text-[12px] font-semibold text-destructive hover:underline cursor-pointer">
              Evet, sil
            </button>
            <button
              type="button"
              onClick={() => setConfirming(false)}
              disabled={pending}
              className="text-[12px] text-muted-foreground hover:underline cursor-pointer"
            >
              Vazgeç
            </button>
          </form>
        )}
      </div>
      {state?.error && <p className="mt-1 text-[11px] text-destructive">{state.error}</p>}
    </li>
  );
}

export function ProgressPaymentExtraWorkItems({
  projectId,
  progressPaymentId,
  items,
  canEdit,
}: {
  projectId: string;
  progressPaymentId: string;
  items: ExtraWorkItem[];
  canEdit: boolean;
}) {
  const [state, formAction, pending] = useActionState(addExtraWorkItemAction, initialActionState);

  return (
    <div className="space-y-3">
      {items.length === 0 ? (
        <p className="text-[12.5px] text-muted-foreground">Bu hakedişe henüz ek iş/iş değişikliği kalemi eklenmemiş.</p>
      ) : (
        <ul>
          {items.map((item) => (
            <ExtraWorkItemRow
              key={item.id}
              item={item}
              projectId={projectId}
              progressPaymentId={progressPaymentId}
              canEdit={canEdit}
            />
          ))}
        </ul>
      )}

      {canEdit && (
        <form action={formAction} className="grid gap-2.5 border-t border-border pt-3 sm:grid-cols-[1.6fr_1fr_auto] sm:items-end">
          <input type="hidden" name="projectId" value={projectId} />
          <input type="hidden" name="progressPaymentId" value={progressPaymentId} />
          <div className="space-y-1.5">
            <Label htmlFor="ew-description">Açıklama</Label>
            <Input id="ew-description" name="description" maxLength={300} placeholder="ör. Ek elektrik tesisatı" required />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="ew-amount">Tutar</Label>
            <Input id="ew-amount" name="amount" type="number" step="0.01" min="0.01" required />
          </div>
          <Button type="submit" size="sm" disabled={pending} className="gap-1.5">
            <Plus className="h-3.5 w-3.5" />
            Ekle
          </Button>
        </form>
      )}
      <FormAlert error={state?.error} success={state?.success} />
    </div>
  );
}
