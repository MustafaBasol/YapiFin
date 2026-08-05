"use client";

import { useActionState, useState } from "react";
import { renameCategoryAction, archiveCategoryAction, reactivateCategoryAction } from "@/app/actions/categories";
import { initialActionState } from "@/lib/action-state";
import { cn } from "@/lib/utils";

export interface CategoryRowData {
  id: string;
  name: string;
  isSystem: boolean;
  isActive: boolean;
  depth: number;
  usageCount: number;
}

export function CategoryRow({ category, canManage }: { category: CategoryRowData; canManage: boolean }) {
  const [editing, setEditing] = useState(false);
  const [renameState, renameAction, renamePending] = useActionState(renameCategoryAction, initialActionState);
  const [toggleState, toggleAction, togglePending] = useActionState(
    category.isActive ? archiveCategoryAction : reactivateCategoryAction,
    initialActionState,
  );

  const canEdit = canManage && !category.isSystem;

  return (
    <tr className="border-b border-border/60 last:border-0">
      <td className="py-2.5 pl-4" style={{ paddingLeft: `${16 + category.depth * 20}px` }}>
        {editing ? (
          <form action={renameAction} className="flex items-center gap-2" onSubmit={() => setEditing(false)}>
            <input type="hidden" name="id" value={category.id} />
            <input
              name="name"
              defaultValue={category.name}
              autoFocus
              className="h-8 w-40 rounded-md border border-input bg-card px-2 text-[13px] text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
            <button type="submit" disabled={renamePending} className="text-[12px] font-medium text-primary hover:underline cursor-pointer">
              Kaydet
            </button>
            <button
              type="button"
              onClick={() => setEditing(false)}
              className="text-[12px] text-muted-foreground hover:underline cursor-pointer"
            >
              Vazgeç
            </button>
          </form>
        ) : (
          <span className="text-[13px] font-medium">{category.name}</span>
        )}
        {renameState?.error && <p className="mt-1 text-[11px] text-destructive">{renameState.error}</p>}
      </td>
      <td className="py-2.5 pr-4">
        {category.isSystem ? (
          <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[11px] font-semibold text-muted-foreground">
            Sistem
          </span>
        ) : (
          <span className="inline-flex items-center gap-1 rounded-full bg-primary/10 px-2 py-0.5 text-[11px] font-semibold text-primary">
            Özel
          </span>
        )}
      </td>
      <td className="py-2.5 pr-4 text-[13px] text-muted-foreground">{category.usageCount > 0 ? `${category.usageCount} kayıt` : "—"}</td>
      <td className="py-2.5 pr-4">
        <span
          className={cn(
            "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold",
            category.isActive ? "bg-success/12 text-success" : "bg-destructive/10 text-destructive",
          )}
        >
          {category.isActive ? "Aktif" : "Pasif"}
        </span>
      </td>
      <td className="py-2.5 pr-4 text-right">
        {canEdit && !editing && (
          <div className="flex items-center justify-end gap-3">
            <button
              type="button"
              onClick={() => setEditing(true)}
              className="text-[12.5px] font-medium text-primary hover:underline cursor-pointer"
            >
              Düzenle
            </button>
            <form action={toggleAction}>
              <input type="hidden" name="id" value={category.id} />
              <button type="submit" disabled={togglePending} className="text-[12.5px] font-medium text-muted-foreground hover:underline cursor-pointer">
                {category.isActive ? "Pasifleştir" : "Etkinleştir"}
              </button>
            </form>
          </div>
        )}
        {toggleState?.error && <p className="mt-1 text-[11px] text-destructive">{toggleState.error}</p>}
      </td>
    </tr>
  );
}
