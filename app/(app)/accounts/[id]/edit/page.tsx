import { notFound } from "next/navigation";
import { requireRole } from "@/lib/auth/guard";
import { getAccountForUser } from "@/server/services/account-service";
import { ServiceError } from "@/server/services/errors";
import { AccountForm } from "@/components/app/account-form";

export default async function EditAccountPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await requireRole(["OWNER", "ADMIN", "FINANCE"]);

  let account;
  try {
    account = await getAccountForUser(user, id);
  } catch (err) {
    if (err instanceof ServiceError && err.code === "NOT_FOUND") notFound();
    throw err;
  }

  return (
    <div className="mx-auto max-w-3xl animate-fade-in space-y-6">
      <div>
        <h1 className="font-display text-2xl font-bold tracking-tight">Hesabı düzenle</h1>
        <p className="mt-0.5 text-sm text-muted-foreground">{account.name}</p>
      </div>
      <div className="rounded-2xl border border-border bg-card p-6 shadow-soft">
        <AccountForm
          account={{
            id: account.id,
            name: account.name,
            type: account.type,
            bankName: account.bankName ?? "",
            iban: account.iban ?? "",
          }}
        />
      </div>
    </div>
  );
}
