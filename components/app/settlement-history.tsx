import { cn, formatDate, formatMoney } from "@/lib/utils";
import { PAYMENT_METHOD_LABELS } from "@/lib/validation/settlement";
import { CancelReasonForm } from "@/components/app/cancel-reason-form";
import { cancelSettlementAction } from "@/app/actions/settlements";

interface SettlementRow {
  id: string;
  amount: string;
  settlementDate: Date;
  paymentMethod: string;
  referenceNumber: string | null;
  notes: string | null;
  status: "ACTIVE" | "CANCELLED";
  cancellationReason: string | null;
  financialAccount: { name: string };
}

export function SettlementHistory({
  settlements,
  transactionId,
  transactionType,
  canCancel,
  currency,
}: {
  settlements: SettlementRow[];
  transactionId: string;
  transactionType: "INCOME" | "EXPENSE";
  canCancel: boolean;
  currency: string;
}) {
  if (settlements.length === 0) {
    return (
      <p className="mt-2 text-sm text-muted-foreground">
        {transactionType === "INCOME" ? "Henüz tahsilat girilmemiş." : "Henüz ödeme girilmemiş."}
      </p>
    );
  }

  return (
    <ul className="mt-3 space-y-2">
      {settlements.map((s) => (
        <li key={s.id} className="rounded-xl border border-border p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <p className={cn("text-[13px] font-semibold tabular-nums", s.status === "CANCELLED" && "line-through text-muted-foreground")}>
                {formatMoney(s.amount, currency)}
              </p>
              <p className="text-[11px] text-muted-foreground">
                {formatDate(s.settlementDate)} · {s.financialAccount.name} ·{" "}
                {PAYMENT_METHOD_LABELS[s.paymentMethod as keyof typeof PAYMENT_METHOD_LABELS] ?? s.paymentMethod}
                {s.referenceNumber ? ` · ${s.referenceNumber}` : ""}
              </p>
            </div>
            <span
              className={cn(
                "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold",
                s.status === "ACTIVE" ? "bg-success/12 text-success" : "bg-muted text-muted-foreground",
              )}
            >
              {s.status === "ACTIVE" ? "Aktif" : "İptal"}
            </span>
          </div>
          {s.status === "CANCELLED" && s.cancellationReason && (
            <p className="mt-1.5 text-[11px] text-muted-foreground">İptal nedeni: {s.cancellationReason}</p>
          )}
          {s.status === "ACTIVE" && canCancel && (
            <div className="mt-2">
              <CancelReasonForm
                action={cancelSettlementAction}
                hiddenFields={{ id: s.id, transactionType, transactionId }}
                triggerLabel={transactionType === "INCOME" ? "Tahsilatı iptal et" : "Ödemeyi iptal et"}
                confirmLabel="Ters kayıt oluştur"
                warningText="Bu hareket iptal edilecek ve hesap bakiyesi ters kayıtla düzeltilecektir."
              />
            </div>
          )}
        </li>
      ))}
    </ul>
  );
}
