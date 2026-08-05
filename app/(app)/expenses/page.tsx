import Link from "next/link";
import { Plus } from "lucide-react";
import { requireUser } from "@/lib/auth/guard";
import { listTransactionsForUser } from "@/server/services/transaction-service";
import { canCreateExpense } from "@/lib/permissions";
import { TransactionsTable } from "@/components/app/transactions-table";

export default async function ExpensesPage() {
  const user = await requireUser();
  const records = await listTransactionsForUser(user, "EXPENSE");

  const rows = records.map((r) => ({
    id: r.id,
    description: r.description,
    counterpartName: r.supplier?.name ?? null,
    projectName: r.project?.name ?? null,
    categoryName: r.category.name,
    totalAmount: r.totalAmount.toString(),
    remainingAmount: r.remainingAmount.toString(),
    dueDate: r.dueDate,
    status: r.status,
    currency: r.currency,
  }));

  return (
    <div className="mx-auto max-w-[1500px] animate-fade-in space-y-6">
      <div className="flex flex-wrap items-center gap-3">
        <div>
          <h1 className="font-display text-2xl font-bold tracking-tight">Giderler</h1>
          <p className="mt-0.5 text-sm text-muted-foreground">Gider kayıtları ve borç durumu.</p>
        </div>
        {canCreateExpense(user.role) && (
          <Link
            href="/expenses/new"
            className="ml-auto inline-flex h-9 items-center gap-1.5 rounded-lg bg-primary px-3.5 text-[13px] font-semibold text-primary-foreground shadow-sm transition-opacity hover:opacity-90"
          >
            <Plus className="h-4 w-4" />
            Yeni gider
          </Link>
        )}
      </div>

      <TransactionsTable rows={rows} basePath="/expenses" type="EXPENSE" counterpartLabel="Tedarikçi" />
    </div>
  );
}
