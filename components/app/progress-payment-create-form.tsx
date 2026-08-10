"use client";

import { useActionState } from "react";
import { Plus } from "lucide-react";
import { createProgressPaymentAction } from "@/app/actions/progress-payments";
import { initialActionState } from "@/lib/action-state";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import { FormAlert } from "@/components/auth/field-error";

interface CategoryOption {
  id: string;
  name: string;
}

export function ProgressPaymentCreateForm({
  projectId,
  categoryOptions,
}: {
  projectId: string;
  categoryOptions: CategoryOption[];
}) {
  const [state, formAction, pending] = useActionState(createProgressPaymentAction, initialActionState);

  if (categoryOptions.length === 0) {
    return (
      <p className="border-t border-border pt-4 text-[12.5px] text-muted-foreground">
        Seçilebilecek aktif gelir kategorisi yok. Önce Kategoriler sayfasından bir gelir kategorisi ekleyin.
      </p>
    );
  }

  return (
    <form action={formAction} className="space-y-3 border-t border-border pt-4">
      <input type="hidden" name="projectId" value={projectId} />
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div className="space-y-1.5">
          <Label htmlFor="pp-create-categoryId">Gelir kategorisi</Label>
          <select
            id="pp-create-categoryId"
            name="categoryId"
            required
            defaultValue=""
            className="flex h-10 w-full rounded-lg border border-input bg-card px-3 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <option value="" disabled>
              Seçin…
            </option>
            {categoryOptions.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="pp-create-periodStartDate">Dönem başlangıcı</Label>
          <Input id="pp-create-periodStartDate" name="periodStartDate" type="date" required />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="pp-create-periodEndDate">Dönem bitişi</Label>
          <Input id="pp-create-periodEndDate" name="periodEndDate" type="date" required />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="pp-create-dueDate">Vade tarihi (opsiyonel)</Label>
          <Input id="pp-create-dueDate" name="dueDate" type="date" />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="pp-create-grossAmount">Brüt hakediş tutarı</Label>
          <Input id="pp-create-grossAmount" name="grossAmount" type="number" step="0.01" min="0.01" required />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="pp-create-deductionAmount">Kesinti tutarı (opsiyonel)</Label>
          <Input id="pp-create-deductionAmount" name="deductionAmount" type="number" step="0.01" min="0" defaultValue="0" />
        </div>
        <div className="space-y-1.5 sm:col-span-2 lg:col-span-2">
          <Label htmlFor="pp-create-notes">Not (opsiyonel)</Label>
          <Input id="pp-create-notes" name="notes" maxLength={1000} placeholder="ör. 3. kat kaba inşaat hakedişi" />
        </div>
      </div>
      <Button type="submit" size="sm" disabled={pending} className="gap-1.5">
        <Plus className="h-3.5 w-3.5" />
        Taslak hakediş oluştur
      </Button>
      <FormAlert error={state?.error} success={state?.success} />
    </form>
  );
}
