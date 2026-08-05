"use client";

import { useActionState } from "react";
import { ArrowRight, Loader2 } from "lucide-react";
import { createIncomeAction, updateIncomeAction } from "@/app/actions/incomes";
import { initialActionState } from "@/lib/action-state";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import { FormAlert } from "@/components/auth/field-error";

interface Option {
  id: string;
  name: string;
}

interface IncomeDefaults {
  id: string;
  projectId: string;
  customerId: string;
  categoryId: string;
  documentNumber: string;
  description: string;
  issueDate: string;
  dueDate: string;
  subtotal: number;
  taxRate: number;
}

export function IncomeForm({
  income,
  projects,
  customers,
  categories,
}: {
  income?: IncomeDefaults;
  projects: Option[];
  customers: Option[];
  categories: Option[];
}) {
  const action = income ? updateIncomeAction : createIncomeAction;
  const [state, formAction, pending] = useActionState(action, initialActionState);
  const today = new Date().toISOString().slice(0, 10);

  return (
    <form action={formAction} className="space-y-4">
      {income && <input type="hidden" name="id" value={income.id} />}
      <FormAlert error={state?.error} />

      <div className="space-y-1.5">
        <Label htmlFor="description">Açıklama</Label>
        <Input id="description" name="description" defaultValue={income?.description} required />
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="categoryId">Kategori</Label>
          <select
            id="categoryId"
            name="categoryId"
            required
            defaultValue={income?.categoryId ?? ""}
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
        <div className="space-y-1.5">
          <Label htmlFor="customerId">Müşteri</Label>
          <select
            id="customerId"
            name="customerId"
            defaultValue={income?.customerId ?? ""}
            className="flex h-10 w-full rounded-lg border border-input bg-card px-3 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <option value="">Yok</option>
            {customers.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="projectId">Proje</Label>
          <select
            id="projectId"
            name="projectId"
            defaultValue={income?.projectId ?? ""}
            className="flex h-10 w-full rounded-lg border border-input bg-card px-3 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <option value="">Yok</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="documentNumber">Belge/fatura no</Label>
          <Input id="documentNumber" name="documentNumber" defaultValue={income?.documentNumber} placeholder="opsiyonel" />
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="issueDate">Belge tarihi</Label>
          <Input id="issueDate" name="issueDate" type="date" defaultValue={income?.issueDate ?? today} required />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="dueDate">Vade tarihi</Label>
          <Input id="dueDate" name="dueDate" type="date" defaultValue={income?.dueDate} />
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
            defaultValue={income?.subtotal}
            required
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="taxRate">KDV oranı (%)</Label>
          <Input id="taxRate" name="taxRate" type="number" step="0.01" min="0" max="100" defaultValue={income?.taxRate ?? 20} />
        </div>
      </div>

      <Button type="submit" disabled={pending} className="gap-2">
        {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
        {income ? "Değişiklikleri kaydet" : "Geliri kaydet"}
        {!pending && <ArrowRight className="h-4 w-4" />}
      </Button>
    </form>
  );
}
