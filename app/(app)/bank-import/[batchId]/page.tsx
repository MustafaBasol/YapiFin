import Link from "next/link";
import { notFound } from "next/navigation";
import { requireRole } from "@/lib/auth/guard";
import { getBatchForUser } from "@/server/services/bank-import-service";
import { ServiceError } from "@/server/services/errors";
import { cn, formatDate, formatMoney } from "@/lib/utils";
import type { BankImportRowStatus } from "@prisma/client";

const STATUS_LABELS: Record<BankImportRowStatus, string> = {
  IMPORTED: "Gözden geçirilmedi",
  CONFIRMING: "Mutabakat sağlanıyor",
  RECONCILED: "Mutabık kılındı",
  IGNORED: "Yok sayıldı",
  ERROR: "Hatalı satır",
};

const STATUS_BADGE: Record<BankImportRowStatus, string> = {
  IMPORTED: "bg-muted text-muted-foreground",
  CONFIRMING: "bg-warning/15 text-warning",
  RECONCILED: "bg-success/15 text-success",
  IGNORED: "bg-muted text-muted-foreground",
  ERROR: "bg-destructive/15 text-destructive",
};

export default async function BankImportBatchPage({ params }: { params: Promise<{ batchId: string }> }) {
  const { batchId } = await params;
  const user = await requireRole(["OWNER", "ADMIN", "FINANCE"]);

  let data;
  try {
    data = await getBatchForUser(user, batchId);
  } catch (err) {
    if (err instanceof ServiceError && err.code === "NOT_FOUND") notFound();
    throw err;
  }
  const { batch, rows } = data;

  return (
    <div className="mx-auto max-w-[1400px] animate-fade-in space-y-6">
      <div>
        <h1 className="font-display text-2xl font-bold tracking-tight">{batch.fileName}</h1>
        <p className="mt-0.5 text-sm text-muted-foreground">
          {batch.importedRowCount} içe aktarıldı · {batch.errorRowCount} hatalı · {batch.duplicateSkippedCount} mükerrer (atlandı)
        </p>
      </div>

      <div className="overflow-hidden rounded-2xl border border-border bg-card shadow-soft">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left">
                <th className="label-mono px-4 py-3 font-medium text-muted-foreground">Tarih</th>
                <th className="label-mono px-4 py-3 font-medium text-muted-foreground">Açıklama</th>
                <th className="label-mono px-4 py-3 text-right font-medium text-muted-foreground">Tutar</th>
                <th className="label-mono px-4 py-3 font-medium text-muted-foreground">Durum</th>
                <th className="label-mono px-4 py-3 font-medium text-muted-foreground"></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-b border-border/60 last:border-0 hover:bg-muted/40">
                  <td className="px-4 py-3 text-[12px] text-muted-foreground whitespace-nowrap">
                    {r.transactionDate ? formatDate(r.transactionDate) : "—"}
                  </td>
                  <td className="max-w-[320px] truncate px-4 py-3" title={r.description}>
                    {r.description || <span className="text-muted-foreground/70">—</span>}
                    {r.errorMessage && <p className="text-[11px] text-destructive">{r.errorMessage}</p>}
                  </td>
                  <td
                    className={cn(
                      "px-4 py-3 text-right tabular-nums font-medium",
                      r.direction === "CREDIT" ? "text-success" : r.direction === "DEBIT" ? "text-destructive" : "",
                    )}
                  >
                    {r.amount ? `${r.direction === "DEBIT" ? "−" : "+"}${formatMoney(r.amount.toString(), r.currency ?? "TRY")}` : "—"}
                  </td>
                  <td className="px-4 py-3">
                    <span className={cn("rounded-full px-2 py-0.5 text-[11px] font-semibold", STATUS_BADGE[r.status])}>
                      {STATUS_LABELS[r.status]}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-right">
                    {r.status === "IMPORTED" && (
                      <Link href={`/bank-import/${batch.id}/rows/${r.id}`} className="text-[12px] font-semibold text-primary hover:underline">
                        İncele
                      </Link>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
