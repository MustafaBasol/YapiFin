"use client";

import { useActionState } from "react";
import { Loader2 } from "lucide-react";
import {
  confirmBankImportRowAsSettlementAction,
  confirmBankImportRowAsTransferAction,
  ignoreBankImportRowAction,
} from "@/app/actions/bank-import";
import { initialActionState } from "@/lib/action-state";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/input";
import { FormAlert } from "@/components/auth/field-error";
import { formatDate, formatMoney } from "@/lib/utils";

interface Candidate {
  id: string;
  description: string;
  documentNumber: string | null;
  issueDate: string;
  dueDate: string | null;
  remaining: string;
}

interface AccountOption {
  id: string;
  name: string;
}

function SettlementCandidateButton({
  batchId,
  rowId,
  candidate,
}: {
  batchId: string;
  rowId: string;
  candidate: Candidate;
}) {
  const [state, formAction, pending] = useActionState(confirmBankImportRowAsSettlementAction, initialActionState);

  return (
    <form action={formAction} className="flex items-center justify-between gap-3 rounded-xl border border-border p-3">
      <input type="hidden" name="batchId" value={batchId} />
      <input type="hidden" name="rowId" value={rowId} />
      <input type="hidden" name="transactionId" value={candidate.id} />
      <div className="min-w-0">
        <p className="truncate text-sm font-medium">{candidate.description}</p>
        <p className="text-xs text-muted-foreground">
          {candidate.documentNumber ? `${candidate.documentNumber} · ` : ""}
          Vade/tarih: {formatDate(candidate.dueDate ?? candidate.issueDate)} · Kalan: {formatMoney(candidate.remaining)}
        </p>
        {state?.error && <p className="mt-1 text-xs text-destructive">{state.error}</p>}
      </div>
      <Button type="submit" disabled={pending} className="h-8 shrink-0 gap-1.5 px-3 text-[12px]">
        {pending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
        Bu kayıtla mutabık kıl
      </Button>
    </form>
  );
}

function TransferReconcileForm({ batchId, rowId, accounts }: { batchId: string; rowId: string; accounts: AccountOption[] }) {
  const [state, formAction, pending] = useActionState(confirmBankImportRowAsTransferAction, initialActionState);

  return (
    <form action={formAction} className="space-y-3 rounded-xl border border-border p-3">
      <input type="hidden" name="batchId" value={batchId} />
      <input type="hidden" name="rowId" value={rowId} />
      <FormAlert error={state?.error} />
      <div className="space-y-1.5">
        <Label htmlFor="counterpartAccountId">Karşı hesap (organizasyonunuzun kendi hesabı)</Label>
        <select
          id="counterpartAccountId"
          name="counterpartAccountId"
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
      <Button type="submit" disabled={pending} variant="outline" className="h-9 gap-1.5 text-[13px]">
        {pending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
        Transfer olarak mutabık kıl
      </Button>
    </form>
  );
}

function IgnoreRowButton({ batchId, rowId }: { batchId: string; rowId: string }) {
  const [state, formAction, pending] = useActionState(ignoreBankImportRowAction, initialActionState);

  return (
    <form action={formAction}>
      <input type="hidden" name="batchId" value={batchId} />
      <input type="hidden" name="rowId" value={rowId} />
      {state?.error && <p className="mb-1 text-xs text-destructive">{state.error}</p>}
      <Button type="submit" disabled={pending} variant="ghost" className="h-9 gap-1.5 text-[13px] text-muted-foreground">
        {pending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
        Bu satırı yok say
      </Button>
    </form>
  );
}

export function BankImportReconcileForm({
  batchId,
  rowId,
  candidates,
  accounts,
}: {
  batchId: string;
  rowId: string;
  candidates: Candidate[];
  accounts: AccountOption[];
}) {
  return (
    <div className="space-y-6">
      <div>
        <h2 className="mb-2 text-sm font-semibold">Olası eşleşmeler</h2>
        {candidates.length === 0 ? (
          <p className="text-sm text-muted-foreground">Açık bir gelir/gider kaydıyla otomatik eşleşme bulunamadı.</p>
        ) : (
          <div className="space-y-2">
            {candidates.map((c) => (
              <SettlementCandidateButton key={c.id} batchId={batchId} rowId={rowId} candidate={c} />
            ))}
          </div>
        )}
      </div>

      <div>
        <h2 className="mb-2 text-sm font-semibold">Ya da hesaplar arası transfer olarak işaretle</h2>
        <TransferReconcileForm batchId={batchId} rowId={rowId} accounts={accounts} />
      </div>

      <div className="border-t border-border pt-4">
        <IgnoreRowButton batchId={batchId} rowId={rowId} />
      </div>
    </div>
  );
}
