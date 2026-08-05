"use client";

import { useActionState } from "react";
import { ArrowRight, Loader2 } from "lucide-react";
import { createProjectAction } from "@/app/actions/projects";
import { initialActionState } from "@/lib/action-state";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import { FormAlert } from "@/components/auth/field-error";

export function ProjectForm() {
  const [state, formAction, pending] = useActionState(createProjectAction, initialActionState);

  return (
    <form action={formAction} className="space-y-4">
      <FormAlert error={state?.error} />

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="code">Proje kodu</Label>
          <Input id="code" name="code" placeholder="ör. PRJ-001" required />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="name">Proje adı</Label>
          <Input id="name" name="name" required />
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="city">İl</Label>
          <Input id="city" name="city" />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="district">İlçe</Label>
          <Input id="district" name="district" />
        </div>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="address">Adres</Label>
        <Input id="address" name="address" />
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="startDate">Başlangıç tarihi</Label>
          <Input id="startDate" name="startDate" type="date" />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="plannedEndDate">Planlanan bitiş tarihi</Label>
          <Input id="plannedEndDate" name="plannedEndDate" type="date" />
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="contractAmount">Sözleşme bedeli (₺)</Label>
          <Input id="contractAmount" name="contractAmount" type="number" min="0" step="0.01" defaultValue="0" />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="estimatedBudget">Tahmini bütçe (₺)</Label>
          <Input id="estimatedBudget" name="estimatedBudget" type="number" min="0" step="0.01" defaultValue="0" />
        </div>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="notes">Açıklama</Label>
        <textarea
          id="notes"
          name="notes"
          rows={3}
          className="flex w-full rounded-lg border border-input bg-card px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
      </div>

      <Button type="submit" disabled={pending} className="gap-2">
        {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
        Projeyi oluştur
        {!pending && <ArrowRight className="h-4 w-4" />}
      </Button>
    </form>
  );
}
