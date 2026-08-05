"use client";

import { useActionState } from "react";
import { Plus } from "lucide-react";
import { createProjectBudgetItemAction } from "@/app/actions/project-budget";
import { initialActionState } from "@/lib/action-state";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import { FormAlert } from "@/components/auth/field-error";

interface CategoryOption {
  id: string;
  name: string;
}

export function ProjectBudgetCreateForm({
  projectId,
  categoryOptions,
}: {
  projectId: string;
  categoryOptions: CategoryOption[];
}) {
  const [state, formAction, pending] = useActionState(createProjectBudgetItemAction, initialActionState);

  if (categoryOptions.length === 0) {
    return (
      <p className="border-t border-border pt-4 text-[12.5px] text-muted-foreground">
        Seçilebilecek aktif gider kategorisi yok. Önce Kategoriler sayfasından bir gider kategorisi ekleyin.
      </p>
    );
  }

  return (
    <form action={formAction} className="space-y-3 border-t border-border pt-4">
      <input type="hidden" name="projectId" value={projectId} />
      <div className="grid gap-3 sm:grid-cols-[1.2fr_0.8fr_1.4fr_auto] sm:items-end">
        <div className="space-y-1.5">
          <Label htmlFor="budget-create-categoryId">Gider kategorisi</Label>
          <select
            id="budget-create-categoryId"
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
          <Label htmlFor="budget-create-plannedAmount">Planlanan tutar</Label>
          <Input id="budget-create-plannedAmount" name="plannedAmount" type="number" step="0.01" min="0.01" required />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="budget-create-description">Açıklama (opsiyonel)</Label>
          <Input id="budget-create-description" name="description" maxLength={500} placeholder="ör. Kaba inşaat malzemesi" />
        </div>
        <Button type="submit" size="sm" disabled={pending} className="gap-1.5">
          <Plus className="h-3.5 w-3.5" />
          Ekle
        </Button>
      </div>
      <FormAlert error={state?.error} success={state?.success} />
    </form>
  );
}
