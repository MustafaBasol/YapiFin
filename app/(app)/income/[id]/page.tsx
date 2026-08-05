import Link from "next/link";
import { notFound } from "next/navigation";
import { Pencil } from "lucide-react";
import { requireUser } from "@/lib/auth/guard";
import { getTransactionForUser } from "@/server/services/transaction-service";
import { listActiveAccountsForUser } from "@/server/services/account-service";
import { ServiceError } from "@/server/services/errors";
import { canCancelFinancialRecord, canManageIncome, canRecordSettlement } from "@/lib/permissions";
import { TRANSACTION_STATUS_META, transactionStatusLabel } from "@/components/app/transaction-status";
import { SettlementForm } from "@/components/app/settlement-form";
import { SettlementHistory } from "@/components/app/settlement-history";
import { CancelReasonForm } from "@/components/app/cancel-reason-form";
import { cancelIncomeAction } from "@/app/actions/incomes";
import { cn, formatDate, formatMoney } from "@/lib/utils";

export default async function IncomeDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await requireUser();

  let record;
  try {
    record = await getTransactionForUser(user, id, "INCOME");
  } catch (err) {
    if (err instanceof ServiceError && err.code === "NOT_FOUND") notFound();
    throw err;
  }

  const status = TRANSACTION_STATUS_META[record.status];
  const canEdit = canManageIncome(user.role) && record.status !== "CANCELLED" && record.settledAmount.isZero();
  const canCancel = canCancelFinancialRecord(user.role) && record.status !== "CANCELLED" && record.settledAmount.isZero();
  const canSettle = canRecordSettlement(user.role) && record.status !== "CANCELLED" && record.remainingAmount.greaterThan(0);

  const accounts = canSettle ? await listActiveAccountsForUser(user) : [];

  return (
    <div className="mx-auto max-w-4xl animate-fade-in space-y-6">
      <div className="flex flex-wrap items-start gap-3">
        <div>
          <h1 className="font-display text-2xl font-bold tracking-tight">{record.description}</h1>
          <div className="mt-1 flex items-center gap-2">
            <span className={cn("inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[12px] font-semibold", status.tone)}>
              {transactionStatusLabel(record.status, "INCOME")}
            </span>
            {record.documentNumber && <span className="text-[12px] text-muted-foreground">{record.documentNumber}</span>}
          </div>
        </div>
        {canEdit && (
          <Link
            href={`/income/${record.id}/edit`}
            className="ml-auto inline-flex h-9 items-center gap-1.5 rounded-lg border border-border bg-card px-3.5 text-[13px] font-semibold text-foreground shadow-sm transition-colors hover:bg-muted"
          >
            <Pencil className="h-3.5 w-3.5" />
            Düzenle
          </Link>
        )}
      </div>

      <div className="grid gap-6 lg:grid-cols-[1.4fr_1fr]">
        <div className="space-y-6">
          <div className="rounded-2xl border border-border bg-card p-5 shadow-soft">
            <h2 className="font-display text-[15px] font-semibold tracking-tight">Genel bakış</h2>
            <dl className="mt-4 grid grid-cols-2 gap-4 text-sm">
              <Field label="Kategori" value={record.category.name} />
              <Field label="Müşteri" value={record.customer?.name ?? "—"} />
              <Field label="Proje" value={record.project?.name ?? "—"} />
              <Field label="Belge tarihi" value={formatDate(record.issueDate)} />
              <Field label="Vade tarihi" value={record.dueDate ? formatDate(record.dueDate) : "—"} />
            </dl>
            {record.status === "CANCELLED" && record.cancellationReason && (
              <p className="mt-4 rounded-lg bg-muted px-3 py-2 text-[12px] text-muted-foreground">
                İptal nedeni: {record.cancellationReason}
              </p>
            )}
          </div>

          <div className="rounded-2xl border border-border bg-card p-5 shadow-soft">
            <h2 className="font-display text-[15px] font-semibold tracking-tight">Tahsilatlar</h2>
            {canSettle && (
              <div className="mt-3">
                <SettlementForm
                  transactionId={record.id}
                  transactionType="INCOME"
                  accounts={accounts.map((a) => ({ id: a.id, name: a.name }))}
                  remainingAmount={record.remainingAmount.toString()}
                />
              </div>
            )}
            <SettlementHistory
              settlements={record.settlements.map((s) => ({ ...s, amount: s.amount.toString() }))}
              transactionId={record.id}
              transactionType="INCOME"
              canCancel={canCancelFinancialRecord(user.role)}
              currency={record.currency}
            />
          </div>
        </div>

        <div className="space-y-6">
          <div className="rounded-2xl border border-border bg-card p-5 shadow-soft">
            <h2 className="font-display text-[15px] font-semibold tracking-tight">Tutar özeti</h2>
            <dl className="mt-4 space-y-3 text-sm">
              <div className="flex justify-between">
                <dt className="text-muted-foreground">Ara toplam</dt>
                <dd className="font-medium tabular-nums">{formatMoney(record.subtotal.toString(), record.currency)}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-muted-foreground">KDV (%{Number(record.taxRate)})</dt>
                <dd className="font-medium tabular-nums">{formatMoney(record.taxAmount.toString(), record.currency)}</dd>
              </div>
              <div className="flex justify-between border-t border-border pt-3">
                <dt className="font-semibold">Genel toplam</dt>
                <dd className="font-semibold tabular-nums">{formatMoney(record.totalAmount.toString(), record.currency)}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-muted-foreground">Tahsil edilen</dt>
                <dd className="font-medium tabular-nums text-success">{formatMoney(record.settledAmount.toString(), record.currency)}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-muted-foreground">Kalan alacak</dt>
                <dd className="font-semibold tabular-nums">{formatMoney(record.remainingAmount.toString(), record.currency)}</dd>
              </div>
            </dl>
          </div>

          {canCancelFinancialRecord(user.role) && record.status !== "CANCELLED" && (
            <div className="rounded-2xl border border-border bg-card p-5 shadow-soft">
              <h2 className="font-display text-[15px] font-semibold tracking-tight">Kayıt durumu</h2>
              {canCancel ? (
                <div className="mt-3">
                  <CancelReasonForm
                    action={cancelIncomeAction}
                    hiddenFields={{ id: record.id }}
                    triggerLabel="İptal et"
                    confirmLabel="Kaydı iptal et"
                    warningText="Bu gelir kaydı iptal edilecektir. İptal edilen kayıt aktif toplamlara dahil edilmez."
                  />
                </div>
              ) : (
                <p className="mt-2 text-[12px] text-muted-foreground">
                  Bu kayda tahsilat girildiği için doğrudan iptal edilemez; önce tahsilatları iptal edin.
                </p>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-[11px] text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 font-medium">{value}</dd>
    </div>
  );
}
