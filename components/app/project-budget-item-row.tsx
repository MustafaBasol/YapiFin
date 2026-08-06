"use client";

import { useActionState, useState } from "react";
import { updateProjectBudgetItemAction, deleteProjectBudgetItemAction } from "@/app/actions/project-budget";
import { initialActionState } from "@/lib/action-state";
import { formatMoney, cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { FormAlert } from "@/components/auth/field-error";
import { ProjectBudgetStatusBadge } from "@/components/app/project-budget-status";
import type { ProjectBudgetPlanningItem } from "@/server/services/project-budget-service";

interface CategoryOption {
  id: string;
  name: string;
}

function percentLabel(value: string | null) {
  return value ? `%${value.replace(".", ",")}` : "—";
}

export function ProjectBudgetItemRow({
  item,
  categoryOptions,
  canManage,
}: {
  item: ProjectBudgetPlanningItem;
  categoryOptions: CategoryOption[];
  canManage: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [updateState, updateAction, updatePending] = useActionState(updateProjectBudgetItemAction, initialActionState);
  const [deleteState, deleteAction, deletePending] = useActionState(deleteProjectBudgetItemAction, initialActionState);

  if (editing) {
    return (
      <tr className="border-b border-border/60 last:border-0 bg-muted/30">
        <td colSpan={6} className="p-3">
          <form
            action={updateAction}
            className="grid gap-2.5 sm:grid-cols-[1.2fr_0.8fr_1.4fr_auto_auto] sm:items-end"
          >
            <input type="hidden" name="id" value={item.id} />
            <div className="space-y-1">
              <label className="text-[11px] text-muted-foreground">Gider kategorisi</label>
              <select
                name="categoryId"
                required
                defaultValue={item.categoryId}
                className="h-9 w-full rounded-lg border border-input bg-card px-2.5 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {!categoryOptions.some((c) => c.id === item.categoryId) && (
                  <option value={item.categoryId}>{item.categoryName} (pasif)</option>
                )}
                {categoryOptions.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1">
              <label className="text-[11px] text-muted-foreground">Planlanan tutar</label>
              <input
                name="plannedAmount"
                type="number"
                step="0.01"
                min="0.01"
                required
                defaultValue={item.plannedAmount}
                className="h-9 w-full rounded-lg border border-input bg-card px-2.5 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              />
            </div>
            <div className="space-y-1">
              <label className="text-[11px] text-muted-foreground">Açıklama (opsiyonel)</label>
              <input
                name="description"
                maxLength={500}
                defaultValue={item.description ?? ""}
                className="h-9 w-full rounded-lg border border-input bg-card px-2.5 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              />
            </div>
            <Button type="submit" size="sm" disabled={updatePending}>
              Kaydet
            </Button>
            <Button type="button" variant="ghost" size="sm" onClick={() => setEditing(false)} disabled={updatePending}>
              Vazgeç
            </Button>
          </form>
          <div className="mt-2">
            <FormAlert error={updateState?.error} success={updateState?.success} />
          </div>
        </td>
      </tr>
    );
  }

  return (
    <tr className="border-b border-border/60 last:border-0">
      <td className="py-2.5 pl-4 text-[12.5px] font-medium">
        {item.categoryName}
        {!item.categoryIsActive && (
          <span className="ml-1.5 inline-flex items-center rounded-full bg-muted px-1.5 py-0.5 text-[10.5px] font-semibold text-muted-foreground">
            Pasif
          </span>
        )}
        {item.description && <p className="mt-0.5 text-[11.5px] font-normal text-muted-foreground">{item.description}</p>}
      </td>
      <td className="py-2.5 text-right text-[12.5px] font-semibold tabular-nums">{formatMoney(item.plannedAmount)}</td>
      <td className="py-2.5 text-right text-[12.5px] tabular-nums text-muted-foreground">{formatMoney(item.realizedExpense)}</td>
      <td
        className={cn(
          "py-2.5 text-right text-[12.5px] font-semibold tabular-nums",
          Number(item.remainingAmount) < 0 ? "text-destructive" : "",
        )}
      >
        {formatMoney(item.remainingAmount)}
      </td>
      <td className="py-2.5 text-right text-[12.5px] tabular-nums">{percentLabel(item.usagePercentage)}</td>
      <td className="py-2.5 pr-4">
        <div className="flex items-center justify-end gap-2">
          <ProjectBudgetStatusBadge status={item.status} />
          {canManage && !confirmingDelete && (
            <div className="flex items-center gap-2.5">
              <button
                type="button"
                onClick={() => setEditing(true)}
                className="text-[12.5px] font-medium text-primary hover:underline cursor-pointer"
              >
                Düzenle
              </button>
              <button
                type="button"
                onClick={() => setConfirmingDelete(true)}
                className="text-[12.5px] font-medium text-destructive hover:underline cursor-pointer"
              >
                Sil
              </button>
            </div>
          )}
          {canManage && confirmingDelete && (
            <form action={deleteAction} className="flex items-center gap-2">
              <input type="hidden" name="id" value={item.id} />
              <span className="text-[11.5px] text-muted-foreground">Emin misiniz?</span>
              <button
                type="submit"
                disabled={deletePending}
                className="text-[12.5px] font-semibold text-destructive hover:underline cursor-pointer"
              >
                Evet, sil
              </button>
              <button
                type="button"
                onClick={() => setConfirmingDelete(false)}
                disabled={deletePending}
                className="text-[12.5px] text-muted-foreground hover:underline cursor-pointer"
              >
                Vazgeç
              </button>
            </form>
          )}
        </div>
        {deleteState?.error && <p className="mt-1 text-right text-[11px] text-destructive">{deleteState.error}</p>}
      </td>
    </tr>
  );
}
