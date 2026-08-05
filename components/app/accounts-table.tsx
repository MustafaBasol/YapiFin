"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { Landmark, Search } from "lucide-react";
import { cn, formatMoney } from "@/lib/utils";
import { FINANCIAL_ACCOUNT_TYPE_META } from "@/components/app/financial-account-type";
import type { FinancialAccountType } from "@prisma/client";

interface Row {
  id: string;
  name: string;
  type: FinancialAccountType;
  bankName: string | null;
  currency: string;
  balance: string;
  isActive: boolean;
}

export function AccountsTable({ accounts }: { accounts: Row[] }) {
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<"active" | "archived" | "all">("active");
  const [type, setType] = useState<"all" | FinancialAccountType>("all");

  const rows = useMemo(
    () =>
      accounts.filter(
        (a) =>
          (status === "all" || (status === "active" ? a.isActive : !a.isActive)) &&
          (type === "all" || a.type === type) &&
          (!query || a.name.toLowerCase().includes(query.toLowerCase())),
      ),
    [accounts, query, status, type],
  );

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2.5">
        <div className="flex items-center rounded-lg border border-border bg-card p-0.5">
          {(["active", "archived", "all"] as const).map((s) => (
            <button
              key={s}
              onClick={() => setStatus(s)}
              className={cn(
                "rounded-md px-2.5 py-1 text-[12px] font-medium transition-colors",
                status === s ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground",
              )}
            >
              {s === "active" ? "Aktif" : s === "archived" ? "Arşivlenmiş" : "Tümü"}
            </button>
          ))}
        </div>
        <select
          value={type}
          onChange={(e) => setType(e.target.value as "all" | FinancialAccountType)}
          className="h-9 rounded-lg border border-border bg-card px-2.5 text-[13px] text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <option value="all">Tüm türler</option>
          {Object.entries(FINANCIAL_ACCOUNT_TYPE_META).map(([value, meta]) => (
            <option key={value} value={value}>
              {meta.label}
            </option>
          ))}
        </select>
        <div className="flex h-9 items-center gap-2 rounded-lg border border-border bg-card px-3 text-sm">
          <Search className="h-4 w-4 text-muted-foreground" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Hesap ara…"
            className="w-32 bg-transparent text-foreground placeholder:text-muted-foreground/70 focus:outline-none sm:w-44"
          />
        </div>
      </div>

      {rows.length === 0 ? (
        <div className="grid place-items-center rounded-2xl border border-dashed border-border bg-card py-16 text-center">
          <Landmark className="h-8 w-8 text-muted-foreground/50" />
          <p className="mt-3 text-sm text-muted-foreground">
            {accounts.length === 0 ? "Henüz hesap eklenmemiş." : "Bu filtreyle eşleşen hesap yok."}
          </p>
        </div>
      ) : (
        <div className="overflow-hidden rounded-2xl border border-border bg-card shadow-soft">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left">
                  <th className="label-mono py-2.5 pl-4 font-medium text-muted-foreground">Hesap</th>
                  <th className="label-mono py-2.5 font-medium text-muted-foreground">Tür</th>
                  <th className="label-mono py-2.5 font-medium text-muted-foreground">Banka</th>
                  <th className="label-mono py-2.5 font-medium text-muted-foreground">Bakiye</th>
                  <th className="label-mono py-2.5 pr-4 font-medium text-muted-foreground">Durum</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((a) => {
                  const type = FINANCIAL_ACCOUNT_TYPE_META[a.type];
                  const balance = Number(a.balance);
                  return (
                    <tr
                      key={a.id}
                      className="cursor-pointer border-b border-border/60 transition-colors last:border-0 hover:bg-muted/50"
                    >
                      <td className="py-3 pl-4">
                        <Link href={`/accounts/${a.id}`} className="flex items-center gap-3">
                          <span
                            className="grid h-9 w-9 shrink-0 place-items-center rounded-lg text-[11px] font-bold text-white"
                            style={{ backgroundImage: "var(--grad-brand)" }}
                          >
                            {a.name.slice(0, 2).toUpperCase()}
                          </span>
                          <p className="min-w-0 truncate font-semibold leading-tight">{a.name}</p>
                        </Link>
                      </td>
                      <td className="py-3 pr-4">
                        <span className={cn("inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold", type.tone)}>
                          {type.label}
                        </span>
                      </td>
                      <td className="py-3 pr-4 text-[13px] text-muted-foreground">{a.bankName ?? "—"}</td>
                      <td
                        className={cn(
                          "py-3 pr-4 text-[13px] font-semibold tabular-nums",
                          balance < 0 ? "text-destructive" : "text-foreground",
                        )}
                      >
                        {formatMoney(balance, a.currency)}
                      </td>
                      <td className="py-3 pr-4">
                        <span
                          className={cn(
                            "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold",
                            a.isActive ? "bg-success/12 text-success" : "bg-destructive/10 text-destructive",
                          )}
                        >
                          {a.isActive ? "Aktif" : "Arşivlendi"}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
