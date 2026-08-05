"use client";

import { useActionState, useState } from "react";
import { Loader2 } from "lucide-react";
import { createSettlementAction } from "@/app/actions/settlements";
import { initialActionState } from "@/lib/action-state";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import { FormAlert } from "@/components/auth/field-error";
import { PAYMENT_METHOD_LABELS, paymentMethodEnum } from "@/lib/validation/settlement";

interface AccountOption {
  id: string;
  name: string;
}

export function SettlementForm({
  transactionId,
  transactionType,
  accounts,
  remainingAmount,
}: {
  transactionId: string;
  transactionType: "INCOME" | "EXPENSE";
  accounts: AccountOption[];
  remainingAmount: string;
}) {
  const [state, formAction, pending] = useActionState(createSettlementAction, initialActionState);
  const [idempotencyKey, setIdempotencyKey] = useState(() => crypto.randomUUID());
  const today = new Date().toISOString().slice(0, 10);
  const label = transactionType === "INCOME" ? "Tahsilat ekle" : "Ödeme ekle";

  return (
    <form
      action={formAction}
      onSubmit={() => {
        // Başarılı gönderimden sonra yeni bir kayıt için taze anahtar üret.
        setTimeout(() => setIdempotencyKey(crypto.randomUUID()), 0);
      }}
      className="space-y-3 rounded-xl border border-border bg-muted/30 p-4"
    >
      <input type="hidden" name="transactionId" value={transactionId} />
      <input type="hidden" name="transactionType" value={transactionType} />
      <input type="hidden" name="idempotencyKey" value={idempotencyKey} />
      <h3 className="text-[13px] font-semibold">{label}</h3>
      <FormAlert error={state?.error} success={state?.success} />

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="amount">Tutar</Label>
          <Input
            id="amount"
            name="amount"
            type="number"
            step="0.01"
            min="0.01"
            max={remainingAmount}
            required
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="financialAccountId">Hesap</Label>
          <select
            id="financialAccountId"
            name="financialAccountId"
            required
            defaultValue=""
            className="flex h-10 w-full rounded-lg border border-input bg-card px-3 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <option value="" disabled>
              Seçin…
            </option>
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="settlementDate">Tarih</Label>
          <Input id="settlementDate" name="settlementDate" type="date" defaultValue={today} required />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="paymentMethod">Ödeme yöntemi</Label>
          <select
            id="paymentMethod"
            name="paymentMethod"
            defaultValue="HAVALE_EFT"
            className="flex h-10 w-full rounded-lg border border-input bg-card px-3 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {paymentMethodEnum.options.map((m) => (
              <option key={m} value={m}>
                {PAYMENT_METHOD_LABELS[m]}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="referenceNumber">Referans no</Label>
          <Input id="referenceNumber" name="referenceNumber" placeholder="opsiyonel" />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="notes">Açıklama</Label>
          <Input id="notes" name="notes" placeholder="opsiyonel" />
        </div>
      </div>

      <Button type="submit" size="sm" disabled={pending} className="gap-2">
        {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
        {label}
      </Button>
    </form>
  );
}
