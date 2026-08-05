"use client";

import { useActionState } from "react";
import { Plus } from "lucide-react";
import { createCategoryAction } from "@/app/actions/categories";
import { initialActionState } from "@/lib/action-state";
import { Button } from "@/components/ui/button";
import { FormAlert } from "@/components/auth/field-error";
import type { TransactionType } from "@prisma/client";

export function CategoryCreateForm({
  type,
  parentOptions,
}: {
  type: TransactionType;
  parentOptions: { id: string; name: string }[];
}) {
  const [state, formAction, pending] = useActionState(createCategoryAction, initialActionState);

  return (
    <form action={formAction} className="flex flex-wrap items-end gap-2.5 border-t border-border pt-4">
      <input type="hidden" name="type" value={type} />
      <div className="min-w-0 flex-1 space-y-1">
        <label className="text-[11px] text-muted-foreground">Yeni kategori adı</label>
        <input
          name="name"
          required
          placeholder="ör. Elektrik malzemesi"
          className="h-9 w-full rounded-lg border border-input bg-card px-2.5 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
      </div>
      {parentOptions.length > 0 && (
        <div className="min-w-0 space-y-1">
          <label className="text-[11px] text-muted-foreground">Üst kategori</label>
          <select
            name="parentId"
            className="h-9 rounded-lg border border-input bg-card px-2.5 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <option value="">Ana kategori</option>
            {parentOptions.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </div>
      )}
      <Button type="submit" size="sm" disabled={pending} className="gap-1.5">
        <Plus className="h-3.5 w-3.5" />
        Ekle
      </Button>
      <div className="w-full">
        <FormAlert error={state?.error} success={state?.success} />
      </div>
    </form>
  );
}
