import Link from "next/link";
import { notFound } from "next/navigation";
import { requireRole } from "@/lib/auth/guard";
import { getTransferForUser } from "@/server/services/transfer-service";
import { ServiceError } from "@/server/services/errors";
import { canCancelFinancialRecord } from "@/lib/permissions";
import { CancelReasonForm } from "@/components/app/cancel-reason-form";
import { cancelTransferAction } from "@/app/actions/transfers";
import { cn, formatDate, formatMoney } from "@/lib/utils";

export default async function TransferDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await requireRole(["OWNER", "ADMIN", "FINANCE"]);

  let transfer;
  try {
    transfer = await getTransferForUser(user, id);
  } catch (err) {
    if (err instanceof ServiceError && err.code === "NOT_FOUND") notFound();
    throw err;
  }

  return (
    <div className="mx-auto max-w-2xl animate-fade-in space-y-6">
      <div>
        <Link href="/accounts" className="text-sm text-muted-foreground hover:text-foreground">
          ← Kasa ve Banka
        </Link>
        <h1 className="mt-1 font-display text-2xl font-bold tracking-tight">Transfer</h1>
      </div>

      <div className="rounded-2xl border border-border bg-card p-5 shadow-soft">
        <dl className="grid grid-cols-2 gap-4 text-sm">
          <div>
            <dt className="text-[11px] text-muted-foreground">Kaynak hesap</dt>
            <dd className="mt-0.5 font-medium">{transfer.fromAccount.name}</dd>
          </div>
          <div>
            <dt className="text-[11px] text-muted-foreground">Hedef hesap</dt>
            <dd className="mt-0.5 font-medium">{transfer.toAccount.name}</dd>
          </div>
          <div>
            <dt className="text-[11px] text-muted-foreground">Tutar</dt>
            <dd className="mt-0.5 font-semibold tabular-nums">{formatMoney(transfer.amount.toString())}</dd>
          </div>
          <div>
            <dt className="text-[11px] text-muted-foreground">Tarih</dt>
            <dd className="mt-0.5 font-medium">{formatDate(transfer.transferDate)}</dd>
          </div>
          <div>
            <dt className="text-[11px] text-muted-foreground">Durum</dt>
            <dd className="mt-0.5">
              <span
                className={cn(
                  "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold",
                  transfer.status === "ACTIVE" ? "bg-success/12 text-success" : "bg-muted text-muted-foreground",
                )}
              >
                {transfer.status === "ACTIVE" ? "Aktif" : "İptal"}
              </span>
            </dd>
          </div>
          {transfer.description && (
            <div className="col-span-2">
              <dt className="text-[11px] text-muted-foreground">Açıklama</dt>
              <dd className="mt-0.5 font-medium">{transfer.description}</dd>
            </div>
          )}
          {transfer.status === "CANCELLED" && (
            <div className="col-span-2">
              <dt className="text-[11px] text-muted-foreground">İptal nedeni</dt>
              <dd className="mt-0.5 font-medium">{transfer.cancellationReason}</dd>
            </div>
          )}
        </dl>

        {transfer.status === "ACTIVE" && canCancelFinancialRecord(user.role) && (
          <div className="mt-5 border-t border-border pt-4">
            <CancelReasonForm
              action={cancelTransferAction}
              hiddenFields={{ id: transfer.id }}
              triggerLabel="Transferi iptal et"
              confirmLabel="Ters kayıt oluştur"
              warningText="Bu transfer iptal edilecek ve her iki hesapta ters kayıtla düzeltilecektir."
            />
          </div>
        )}
      </div>
    </div>
  );
}
