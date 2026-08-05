import Link from "next/link";
import { Plus } from "lucide-react";
import { requireRole } from "@/lib/auth/guard";
import { listAccountsForUser } from "@/server/services/account-service";
import { canManageAccounts } from "@/lib/permissions";
import { AccountsTable } from "@/components/app/accounts-table";

export default async function AccountsPage() {
  const user = await requireRole(["OWNER", "ADMIN", "FINANCE"]);
  const accounts = await listAccountsForUser(user);

  const rows = accounts.map((a) => ({
    id: a.id,
    name: a.name,
    type: a.type,
    bankName: a.bankName,
    currency: a.currency,
    balance: a.balance.toString(),
    isActive: a.isActive,
  }));

  return (
    <div className="mx-auto max-w-[1500px] animate-fade-in space-y-6">
      <div className="flex flex-wrap items-center gap-3">
        <div>
          <h1 className="font-display text-2xl font-bold tracking-tight">Kasa ve Banka</h1>
          <p className="mt-0.5 text-sm text-muted-foreground">Nakit, banka ve diğer finansal hesaplar.</p>
        </div>
        <div className="ml-auto flex gap-2">
          <Link
            href="/accounts/transfer"
            className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-border bg-card px-3.5 text-[13px] font-semibold text-foreground shadow-sm transition-colors hover:bg-muted"
          >
            Hesaplar arası transfer
          </Link>
          {canManageAccounts(user.role) && (
            <Link
              href="/accounts/new"
              className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-primary px-3.5 text-[13px] font-semibold text-primary-foreground shadow-sm transition-opacity hover:opacity-90"
            >
              <Plus className="h-4 w-4" />
              Yeni hesap
            </Link>
          )}
        </div>
      </div>

      <AccountsTable accounts={rows} />
    </div>
  );
}
