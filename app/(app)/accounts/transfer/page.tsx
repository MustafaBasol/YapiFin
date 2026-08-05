import { requireRole } from "@/lib/auth/guard";
import { listActiveAccountsForUser } from "@/server/services/account-service";
import { TransferForm } from "@/components/app/transfer-form";

export default async function NewTransferPage() {
  const user = await requireRole(["OWNER", "ADMIN", "FINANCE"]);
  const accounts = await listActiveAccountsForUser(user);

  return (
    <div className="mx-auto max-w-3xl animate-fade-in space-y-6">
      <div>
        <h1 className="font-display text-2xl font-bold tracking-tight">Hesaplar arası transfer</h1>
        <p className="mt-0.5 text-sm text-muted-foreground">
          Kaynak ve hedef hesap farklı olmalıdır; transfer her iki hesapta atomik olarak işlenir.
        </p>
      </div>
      <div className="rounded-2xl border border-border bg-card p-6 shadow-soft">
        <TransferForm accounts={accounts.map((a) => ({ id: a.id, name: a.name, currency: a.currency }))} />
      </div>
    </div>
  );
}
