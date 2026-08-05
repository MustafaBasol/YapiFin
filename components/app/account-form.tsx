"use client";

import { useActionState } from "react";
import { ArrowRight, Loader2 } from "lucide-react";
import { createAccountAction, updateAccountAction } from "@/app/actions/accounts";
import { initialActionState } from "@/lib/action-state";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import { FormAlert } from "@/components/auth/field-error";
import { FINANCIAL_ACCOUNT_TYPE_META, FINANCIAL_ACCOUNT_TYPE_OPTIONS } from "@/components/app/financial-account-type";

interface AccountDefaults {
  id: string;
  name: string;
  type: string;
  bankName: string;
  iban: string;
  openingBalance?: number;
  currency?: string;
}

export function AccountForm({ account }: { account?: AccountDefaults }) {
  const action = account ? updateAccountAction : createAccountAction;
  const [state, formAction, pending] = useActionState(action, initialActionState);

  return (
    <form action={formAction} className="space-y-4">
      {account && <input type="hidden" name="id" value={account.id} />}
      <FormAlert error={state?.error} />

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="name">Hesap adı</Label>
          <Input id="name" name="name" defaultValue={account?.name} required />
        </div>
        {!account && (
          <div className="space-y-1.5">
            <Label htmlFor="type">Tür</Label>
            <select
              id="type"
              name="type"
              defaultValue="CASH"
              className="flex h-10 w-full rounded-lg border border-input bg-card px-3 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {FINANCIAL_ACCOUNT_TYPE_OPTIONS.map((t) => (
                <option key={t} value={t}>
                  {FINANCIAL_ACCOUNT_TYPE_META[t].label}
                </option>
              ))}
            </select>
          </div>
        )}
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="bankName">Banka adı</Label>
          <Input id="bankName" name="bankName" defaultValue={account?.bankName} placeholder="opsiyonel" />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="iban">IBAN</Label>
          <Input id="iban" name="iban" defaultValue={account?.iban} placeholder="TR.. (opsiyonel)" />
        </div>
      </div>

      {!account && (
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="openingBalance">Açılış bakiyesi</Label>
            <Input id="openingBalance" name="openingBalance" type="number" step="0.01" min="0" defaultValue="0" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="currency">Para birimi</Label>
            <Input id="currency" name="currency" defaultValue="TRY" maxLength={3} />
          </div>
        </div>
      )}

      <Button type="submit" disabled={pending} className="gap-2">
        {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
        {account ? "Değişiklikleri kaydet" : "Hesabı oluştur"}
        {!pending && <ArrowRight className="h-4 w-4" />}
      </Button>
    </form>
  );
}
