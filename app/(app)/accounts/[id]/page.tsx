import Link from "next/link";
import { notFound } from "next/navigation";
import { Pencil } from "lucide-react";
import { requireRole } from "@/lib/auth/guard";
import { getAccountForUser } from "@/server/services/account-service";
import { ServiceError } from "@/server/services/errors";
import { canManageAccounts } from "@/lib/permissions";
import { FINANCIAL_ACCOUNT_TYPE_META } from "@/components/app/financial-account-type";
import { AccountArchiveForm } from "@/components/app/account-archive-form";
import { AccountMovements } from "@/components/app/account-movements";
import { cn, formatMoney } from "@/lib/utils";

export default async function AccountDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await requireRole(["OWNER", "ADMIN", "FINANCE"]);

  let account;
  try {
    account = await getAccountForUser(user, id);
  } catch (err) {
    if (err instanceof ServiceError && err.code === "NOT_FOUND") notFound();
    throw err;
  }

  const type = FINANCIAL_ACCOUNT_TYPE_META[account.type];
  const canManage = canManageAccounts(user.role);
  const balance = Number(account.balance);

  return (
    <div className="mx-auto max-w-4xl animate-fade-in space-y-6">
      <div className="flex flex-wrap items-start gap-3">
        <div>
          <h1 className="font-display text-2xl font-bold tracking-tight">{account.name}</h1>
          <div className="mt-1 flex items-center gap-2">
            <span className={cn("inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[12px] font-semibold", type.tone)}>
              {type.label}
            </span>
            <span
              className={cn(
                "inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[12px] font-semibold",
                account.isActive ? "bg-success/12 text-success" : "bg-destructive/10 text-destructive",
              )}
            >
              {account.isActive ? "Aktif" : "Arşivlendi"}
            </span>
          </div>
        </div>
        {canManage && (
          <Link
            href={`/accounts/${account.id}/edit`}
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
            <h2 className="font-display text-[15px] font-semibold tracking-tight">Hesap hareketleri</h2>
            <AccountMovements
              movements={account.movements.map((m) => ({ ...m, amount: m.amount.toString() }))}
              currency={account.currency}
            />
          </div>

          {canManage && (
            <div className="rounded-2xl border border-border bg-card p-5 shadow-soft">
              <h2 className="font-display text-[15px] font-semibold tracking-tight">Kayıt durumu</h2>
              <p className="mt-1 text-sm text-muted-foreground">
                {account.isActive
                  ? "Bu hesap arşivlenirse yeni tahsilat, ödeme veya transferde seçilemez."
                  : "Bu hesap arşivde; yeniden etkinleştirebilirsiniz."}
              </p>
              <div className="mt-3">
                <AccountArchiveForm accountId={account.id} isActive={account.isActive} />
              </div>
            </div>
          )}
        </div>

        <div className="rounded-2xl border border-border bg-card p-5 shadow-soft">
          <h2 className="font-display text-[15px] font-semibold tracking-tight">Bakiye</h2>
          <p className={cn("mt-2 text-2xl font-bold tabular-nums", balance < 0 ? "text-destructive" : "text-foreground")}>
            {formatMoney(balance, account.currency)}
          </p>
          <dl className="mt-4 space-y-3 text-sm">
            <div className="flex justify-between">
              <dt className="text-muted-foreground">Açılış bakiyesi</dt>
              <dd className="font-medium tabular-nums">{formatMoney(account.openingBalance.toString(), account.currency)}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-muted-foreground">Banka</dt>
              <dd className="font-medium">{account.bankName ?? "—"}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-muted-foreground">IBAN</dt>
              <dd className="font-medium">{account.iban ?? "—"}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-muted-foreground">Para birimi</dt>
              <dd className="font-medium">{account.currency}</dd>
            </div>
          </dl>
        </div>
      </div>
    </div>
  );
}
