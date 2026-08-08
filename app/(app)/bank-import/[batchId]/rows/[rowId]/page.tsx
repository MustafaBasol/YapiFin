import { notFound } from "next/navigation";
import { requireRole } from "@/lib/auth/guard";
import { getBankImportRowForUser, suggestMatchesForRow } from "@/server/services/bank-import-service";
import { listActiveAccountsForUser } from "@/server/services/account-service";
import { ServiceError } from "@/server/services/errors";
import { formatDate, formatMoney } from "@/lib/utils";
import { BankImportReconcileForm } from "@/components/app/bank-import-reconcile-form";

export default async function BankImportRowReviewPage({
  params,
}: {
  params: Promise<{ batchId: string; rowId: string }>;
}) {
  const { batchId, rowId } = await params;
  const user = await requireRole(["OWNER", "ADMIN", "FINANCE"]);

  let row;
  try {
    row = await getBankImportRowForUser(user, rowId);
  } catch (err) {
    if (err instanceof ServiceError && err.code === "NOT_FOUND") notFound();
    throw err;
  }
  if (row.status !== "IMPORTED") notFound();

  const [candidates, accounts] = await Promise.all([suggestMatchesForRow(user, row.id), listActiveAccountsForUser(user)]);

  return (
    <div className="mx-auto max-w-2xl animate-fade-in space-y-6">
      <div>
        <h1 className="font-display text-2xl font-bold tracking-tight">Banka satırını gözden geçir</h1>
        <p className="mt-0.5 text-sm text-muted-foreground">
          Bu satır henüz hiçbir finansal kayda bağlı değil. Aşağıdan mevcut bir kayıtla mutabık kılın, transfer olarak
          işaretleyin veya yok sayın.
        </p>
      </div>

      <div className="rounded-2xl border border-border bg-card p-6 shadow-soft">
        <div className="mb-4 grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
          <div>
            <p className="text-xs text-muted-foreground">Tarih</p>
            <p className="font-medium">{row.transactionDate ? formatDate(row.transactionDate) : "—"}</p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Tutar</p>
            <p className={`font-medium ${row.direction === "DEBIT" ? "text-destructive" : "text-success"}`}>
              {row.amount ? `${row.direction === "DEBIT" ? "−" : "+"}${formatMoney(row.amount.toString(), row.currency ?? "TRY")}` : "—"}
            </p>
          </div>
          <div className="col-span-2">
            <p className="text-xs text-muted-foreground">Açıklama</p>
            <p className="truncate font-medium" title={row.description}>
              {row.description || "—"}
            </p>
          </div>
        </div>

        <BankImportReconcileForm
          batchId={batchId}
          rowId={row.id}
          candidates={candidates.map((c) => ({
            id: c.id,
            description: c.description,
            documentNumber: c.documentNumber,
            issueDate: c.issueDate.toISOString(),
            dueDate: c.dueDate ? c.dueDate.toISOString() : null,
            remaining: c.remaining,
          }))}
          accounts={accounts.filter((a) => a.id !== row.financialAccountId).map((a) => ({ id: a.id, name: a.name }))}
        />
      </div>
    </div>
  );
}
