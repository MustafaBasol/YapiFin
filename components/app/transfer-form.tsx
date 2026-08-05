"use client";

import { useActionState, useState } from "react";
import { ArrowRight, Loader2 } from "lucide-react";
import { createTransferAction } from "@/app/actions/transfers";
import { initialActionState } from "@/lib/action-state";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import { FormAlert } from "@/components/auth/field-error";

interface AccountOption {
  id: string;
  name: string;
  currency: string;
}

export function TransferForm({ accounts }: { accounts: AccountOption[] }) {
  const [state, formAction, pending] = useActionState(createTransferAction, initialActionState);
  const [idempotencyKey] = useState(() => crypto.randomUUID());
  const today = new Date().toISOString().slice(0, 10);

  return (
    <form action={formAction} className="space-y-4">
      <input type="hidden" name="idempotencyKey" value={idempotencyKey} />
      <FormAlert error={state?.error} success={state?.success} />

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="fromAccountId">Kaynak hesap</Label>
          <select
            id="fromAccountId"
            name="fromAccountId"
            required
            className="flex h-10 w-full rounded-lg border border-input bg-card px-3 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <option value="">Seçin…</option>
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="toAccountId">Hedef hesap</Label>
          <select
            id="toAccountId"
            name="toAccountId"
            required
            className="flex h-10 w-full rounded-lg border border-input bg-card px-3 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <option value="">Seçin…</option>
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="amount">Tutar</Label>
          <Input id="amount" name="amount" type="number" step="0.01" min="0.01" required />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="transferDate">Tarih</Label>
          <Input id="transferDate" name="transferDate" type="date" defaultValue={today} required />
        </div>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="description">Açıklama</Label>
        <Input id="description" name="description" placeholder="opsiyonel" />
      </div>

      <Button type="submit" disabled={pending} className="gap-2">
        {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
        Transferi kaydet
        {!pending && <ArrowRight className="h-4 w-4" />}
      </Button>
    </form>
  );
}
