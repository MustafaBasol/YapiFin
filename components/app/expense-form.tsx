"use client";

import { useActionState } from "react";
import { ArrowRight, Loader2 } from "lucide-react";
import { createExpenseAction, updateExpenseAction } from "@/app/actions/expenses";
import { initialActionState } from "@/lib/action-state";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import { FormAlert } from "@/components/auth/field-error";

interface Option {
  id: string;
  name: string;
}

interface ExpenseDefaults {
  id: string;
  projectId: string;
  supplierId: string;
  categoryId: string;
  documentNumber: string;
  description: string;
  issueDate: string;
  dueDate: string;
  subtotal: number;
  taxRate: number;
}

export function ExpenseForm({
  expense,
  projects,
  suppliers,
  categories,
  requireProject,
}: {
  expense?: ExpenseDefaults;
  projects: Option[];
  suppliers: Option[];
  categories: Option[];
  requireProject: boolean;
}) {
  const action = expense ? updateExpenseAction : createExpenseAction;
  const [state, formAction, pending] = useActionState(action, initialActionState);
  const today = new Date().toISOString().slice(0, 10);

  return (
    <form action={formAction} className="space-y-4">
      {expense && <input type="hidden" name="id" value={expense.id} />}
      <FormAlert error={state?.error} />

      <div className="space-y-1.5">
        <Label htmlFor="description">Açıklama</Label>
        <Input id="description" name="description" defaultValue={expense?.description} required />
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="categoryId">Kategori</Label>
          <select
            id="categoryId"
            name="categoryId"
            required
            defaultValue={expense?.categoryId ?? ""}
            className="flex h-10 w-full rounded-lg border border-input bg-card px-3 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <option value="" disabled>
              Seçin…
            </option>
            {categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </div>
        {suppliers.length > 0 && (
          <div className="space-y-1.5">
            <Label htmlFor="supplierId">Tedarikçi / Taşeron</Label>
            <select
              id="supplierId"
              name="supplierId"
              defaultValue={expense?.supplierId ?? ""}
              className="flex h-10 w-full rounded-lg border border-input bg-card px-3 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <option value="">Yok</option>
              {suppliers.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </div>
        )}
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="projectId">
            Proje {requireProject && <span className="text-destructive">*</span>}
          </Label>
          <select
            id="projectId"
            name="projectId"
            required={requireProject}
            defaultValue={expense?.projectId ?? ""}
            className="flex h-10 w-full rounded-lg border border-input bg-card px-3 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {!requireProject && <option value="">Yok</option>}
            {requireProject && (
              <option value="" disabled>
                Seçin…
              </option>
            )}
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="documentNumber">Belge/fatura no</Label>
          <Input id="documentNumber" name="documentNumber" defaultValue={expense?.documentNumber} placeholder="opsiyonel" />
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="issueDate">Belge tarihi</Label>
          <Input id="issueDate" name="issueDate" type="date" defaultValue={expense?.issueDate ?? today} required />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="dueDate">Vade tarihi</Label>
          <Input id="dueDate" name="dueDate" type="date" defaultValue={expense?.dueDate} />
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="subtotal">Ara toplam</Label>
          <Input
            id="subtotal"
            name="subtotal"
            type="number"
            step="0.01"
            min="0.01"
            defaultValue={expense?.subtotal}
            required
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="taxRate">KDV oranı (%)</Label>
          <Input id="taxRate" name="taxRate" type="number" step="0.01" min="0" max="100" defaultValue={expense?.taxRate ?? 20} />
        </div>
      </div>

      <Button type="submit" disabled={pending} className="gap-2">
        {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
        {expense ? "Değişiklikleri kaydet" : "Gideri kaydet"}
        {!pending && <ArrowRight className="h-4 w-4" />}
      </Button>
    </form>
  );
}
