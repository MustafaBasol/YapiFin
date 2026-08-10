import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { requireUser } from "@/lib/auth/guard";
import { getProgressPaymentForUser } from "@/server/services/progress-payment-service";
import { listCategoriesForTransactionForm } from "@/server/services/category-service";
import { ServiceError } from "@/server/services/errors";
import { canManageProgressPayments } from "@/lib/permissions";
import { formatDate, formatMoney } from "@/lib/utils";
import { transactionStatusLabel } from "@/components/app/transaction-status";
import { ProgressPaymentStatusBadge } from "@/components/app/progress-payment-status";
import { ProgressPaymentActions } from "@/components/app/progress-payment-actions";
import { ProgressPaymentEditForm } from "@/components/app/progress-payment-edit-form";
import { ProgressPaymentExtraWorkItems } from "@/components/app/progress-payment-extra-work-items";

export default async function ProgressPaymentDetailPage({
  params,
}: {
  params: Promise<{ id: string; paymentId: string }>;
}) {
  const { id, paymentId } = await params;
  const user = await requireUser();

  let record;
  try {
    record = await getProgressPaymentForUser(user, paymentId);
  } catch (err) {
    if (err instanceof ServiceError && err.code === "NOT_FOUND") notFound();
    throw err;
  }
  if (record.projectId !== id) notFound();

  const canManage = canManageProgressPayments(user.role);
  const canEditDraft = canManage && record.status === "DRAFT";
  const categoryOptions = canEditDraft
    ? (await listCategoriesForTransactionForm(user, "INCOME")).map((c) => ({ id: c.id, name: c.name }))
    : [];

  return (
    <div className="mx-auto max-w-4xl animate-fade-in space-y-6">
      <div>
        <Link
          href={`/projects/${id}/progress-payments`}
          className="inline-flex items-center gap-1.5 text-[12.5px] font-medium text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          Hakediş listesine dön
        </Link>
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <h1 className="font-display text-2xl font-bold tracking-tight">Hakediş {record.sequenceNo}</h1>
          <ProgressPaymentStatusBadge status={record.status} />
        </div>
        <p className="mt-0.5 text-sm text-muted-foreground">{record.project?.name}</p>
      </div>

      <div className="grid gap-6 lg:grid-cols-[1.4fr_1fr]">
        <div className="space-y-6">
          <div className="rounded-2xl border border-border bg-card p-5 shadow-soft">
            <h2 className="font-display text-[15px] font-semibold tracking-tight">Genel bakış</h2>
            {canEditDraft ? (
              <div className="mt-4">
                <ProgressPaymentEditForm
                  id={record.id}
                  categoryId={record.categoryId}
                  periodStartDate={record.periodStartDate}
                  periodEndDate={record.periodEndDate}
                  dueDate={record.dueDate}
                  grossAmount={record.grossAmount}
                  deductionAmount={record.deductionAmount}
                  notes={record.notes}
                  categoryOptions={categoryOptions}
                />
              </div>
            ) : (
              <dl className="mt-4 grid grid-cols-2 gap-4 text-sm">
                <Field label="Kategori" value={record.categoryName} />
                <Field label="Dönem" value={`${formatDate(record.periodStartDate)} – ${formatDate(record.periodEndDate)}`} />
                <Field label="Vade tarihi" value={record.dueDate ? formatDate(record.dueDate) : "—"} />
                <Field label="Not" value={record.notes ?? "—"} />
                {record.status === "REJECTED" && record.rejectionReason && (
                  <Field label="Red nedeni" value={record.rejectionReason} />
                )}
                {record.status === "CANCELLED" && record.cancellationReason && (
                  <Field label="İptal nedeni" value={record.cancellationReason} />
                )}
              </dl>
            )}
          </div>

          <div className="rounded-2xl border border-border bg-card p-5 shadow-soft">
            <h2 className="font-display text-[15px] font-semibold tracking-tight">Ek iş / iş değişikliği kalemleri</h2>
            <p className="mt-1 text-[12px] text-muted-foreground">
              Bilgilendirme amaçlıdır; brüt hakediş tutarına otomatik yansımaz.
            </p>
            <div className="mt-3">
              <ProgressPaymentExtraWorkItems
                projectId={id}
                progressPaymentId={record.id}
                items={record.extraWorkItems}
                canEdit={canEditDraft}
              />
            </div>
          </div>
        </div>

        <div className="space-y-6">
          <div className="rounded-2xl border border-border bg-card p-5 shadow-soft">
            <h2 className="font-display text-[15px] font-semibold tracking-tight">Tutar özeti</h2>
            <dl className="mt-4 space-y-3 text-sm">
              <div className="flex justify-between">
                <dt className="text-muted-foreground">Brüt tutar</dt>
                <dd className="font-medium tabular-nums">{formatMoney(record.grossAmount.toString())}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-muted-foreground">Kesinti</dt>
                <dd className="font-medium tabular-nums">{formatMoney(record.deductionAmount.toString())}</dd>
              </div>
              <div className="flex justify-between border-t border-border pt-3">
                <dt className="font-semibold">Net tutar</dt>
                <dd className="font-semibold tabular-nums">{formatMoney(record.netAmount.toString())}</dd>
              </div>
            </dl>
          </div>

          {record.financialTransaction && (
            <div className="rounded-2xl border border-border bg-card p-5 shadow-soft">
              <h2 className="font-display text-[15px] font-semibold tracking-tight">İlişkili gelir tahakkuku</h2>
              <dl className="mt-4 space-y-3 text-sm">
                <div className="flex justify-between">
                  <dt className="text-muted-foreground">Durum</dt>
                  <dd className="font-medium">{transactionStatusLabel(record.financialTransaction.status, "INCOME")}</dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-muted-foreground">Toplam tutar</dt>
                  <dd className="font-medium tabular-nums">{formatMoney(record.financialTransaction.totalAmount.toString())}</dd>
                </div>
              </dl>
              <Link
                href={`/income/${record.financialTransaction.id}`}
                className="mt-3 inline-block text-[12.5px] font-medium text-primary hover:underline"
              >
                Gelir kaydını görüntüle →
              </Link>
            </div>
          )}

          {canManage && (
            <div className="rounded-2xl border border-border bg-card p-5 shadow-soft">
              <h2 className="font-display text-[15px] font-semibold tracking-tight">İşlemler</h2>
              <div className="mt-3">
                <ProgressPaymentActions id={record.id} status={record.status} />
              </div>
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
