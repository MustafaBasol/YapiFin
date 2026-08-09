"use client";

import { useActionState } from "react";
import { updateProgressPaymentAction } from "@/app/actions/progress-payments";
import { initialActionState } from "@/lib/action-state";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import { FormAlert } from "@/components/auth/field-error";

interface CategoryOption {
  id: string;
  name: string;
}

function toDateInputValue(d: Date | string) {
  const date = typeof d === "string" ? new Date(d) : d;
  return date.toISOString().slice(0, 10);
}

export function ProgressPaymentEditForm({
  id,
  categoryId,
  periodStartDate,
  periodEndDate,
  dueDate,
  grossAmount,
  deductionAmount,
  notes,
  categoryOptions,
}: {
  id: string;
  categoryId: string;
  periodStartDate: Date | string;
  periodEndDate: Date | string;
  dueDate: Date | string | null;
  grossAmount: unknown;
  deductionAmount: unknown;
  notes: string | null;
  categoryOptions: CategoryOption[];
}) {
  const [state, formAction, pending] = useActionState(updateProgressPaymentAction, initialActionState);

  return (
    <form action={formAction} className="space-y-3">
      <input type="hidden" name="id" value={id} />
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div className="space-y-1.5">
          <Label htmlFor="pp-edit-categoryId">Gelir kategorisi</Label>
          <select
            id="pp-edit-categoryId"
            name="categoryId"
            required
            defaultValue={categoryId}
            className="flex h-10 w-full rounded-lg border border-input bg-card px-3 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {!categoryOptions.some((c) => c.id === categoryId) && <option value={categoryId}>Mevcut kategori</option>}
            {categoryOptions.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="pp-edit-periodStartDate">Dönem başlangıcı</Label>
          <Input id="pp-edit-periodStartDate" name="periodStartDate" type="date" required defaultValue={toDateInputValue(periodStartDate)} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="pp-edit-periodEndDate">Dönem bitişi</Label>
          <Input id="pp-edit-periodEndDate" name="periodEndDate" type="date" required defaultValue={toDateInputValue(periodEndDate)} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="pp-edit-dueDate">Vade tarihi (opsiyonel)</Label>
          <Input id="pp-edit-dueDate" name="dueDate" type="date" defaultValue={dueDate ? toDateInputValue(dueDate) : ""} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="pp-edit-grossAmount">Brüt hakediş tutarı</Label>
          <Input
            id="pp-edit-grossAmount"
            name="grossAmount"
            type="number"
            step="0.01"
            min="0.01"
            required
            defaultValue={grossAmount as string}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="pp-edit-deductionAmount">Kesinti tutarı (opsiyonel)</Label>
          <Input
            id="pp-edit-deductionAmount"
            name="deductionAmount"
            type="number"
            step="0.01"
            min="0"
            defaultValue={deductionAmount as string}
          />
        </div>
        <div className="space-y-1.5 sm:col-span-2 lg:col-span-2">
          <Label htmlFor="pp-edit-notes">Not (opsiyonel)</Label>
          <Input id="pp-edit-notes" name="notes" maxLength={1000} defaultValue={notes ?? ""} />
        </div>
      </div>
      <Button type="submit" size="sm" disabled={pending}>
        Kaydet
      </Button>
      <FormAlert error={state?.error} success={state?.success} />
    </form>
  );
}
