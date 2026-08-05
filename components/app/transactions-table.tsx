"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { Search, TrendingDown, TrendingUp } from "lucide-react";
import { cn, formatDate, formatMoney } from "@/lib/utils";
import { TRANSACTION_STATUS_META, transactionStatusLabel } from "@/components/app/transaction-status";
import type { TransactionStatus } from "@prisma/client";

interface Row {
  id: string;
  description: string;
  counterpartName: string | null;
  projectName: string | null;
  categoryName: string;
  totalAmount: string;
  remainingAmount: string;
  dueDate: Date | null;
  status: TransactionStatus;
  currency: string;
}

export function TransactionsTable({
  rows: allRows,
  basePath,
  type,
  counterpartLabel,
}: {
  rows: Row[];
  basePath: string;
  type: "INCOME" | "EXPENSE";
  counterpartLabel: string;
}) {
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<"all" | TransactionStatus>("all");

  const rows = useMemo(
    () =>
      allRows.filter(
        (r) =>
          (status === "all" || r.status === status) &&
          (!query ||
            r.description.toLowerCase().includes(query.toLowerCase()) ||
            (r.counterpartName ?? "").toLowerCase().includes(query.toLowerCase())),
      ),
    [allRows, query, status],
  );

  const Icon = type === "INCOME" ? TrendingUp : TrendingDown;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2.5">
        <select
          value={status}
          onChange={(e) => setStatus(e.target.value as "all" | TransactionStatus)}
          className="h-9 rounded-lg border border-border bg-card px-2.5 text-[13px] text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <option value="all">Tüm durumlar</option>
          {Object.entries(TRANSACTION_STATUS_META).map(([value, meta]) => (
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
            placeholder="Açıklama veya isimde ara…"
            className="w-40 bg-transparent text-foreground placeholder:text-muted-foreground/70 focus:outline-none sm:w-56"
          />
        </div>
      </div>

      {rows.length === 0 ? (
        <div className="grid place-items-center rounded-2xl border border-dashed border-border bg-card py-16 text-center">
          <Icon className="h-8 w-8 text-muted-foreground/50" />
          <p className="mt-3 text-sm text-muted-foreground">
            {allRows.length === 0 ? "Henüz kayıt eklenmemiş." : "Bu filtreyle eşleşen kayıt yok."}
          </p>
        </div>
      ) : (
        <div className="overflow-hidden rounded-2xl border border-border bg-card shadow-soft">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left">
                  <th className="label-mono py-2.5 pl-4 font-medium text-muted-foreground">Açıklama</th>
                  <th className="label-mono py-2.5 font-medium text-muted-foreground">{counterpartLabel}</th>
                  <th className="label-mono py-2.5 font-medium text-muted-foreground">Proje</th>
                  <th className="label-mono py-2.5 font-medium text-muted-foreground">Vade</th>
                  <th className="label-mono py-2.5 font-medium text-muted-foreground">Toplam</th>
                  <th className="label-mono py-2.5 font-medium text-muted-foreground">Kalan</th>
                  <th className="label-mono py-2.5 pr-4 font-medium text-muted-foreground">Durum</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const st = TRANSACTION_STATUS_META[r.status];
                  return (
                    <tr
                      key={r.id}
                      className="cursor-pointer border-b border-border/60 transition-colors last:border-0 hover:bg-muted/50"
                    >
                      <td className="py-3 pl-4">
                        <Link href={`${basePath}/${r.id}`} className="block min-w-0">
                          <p className="truncate font-semibold leading-tight">{r.description}</p>
                          <p className="text-[11px] text-muted-foreground">{r.categoryName}</p>
                        </Link>
                      </td>
                      <td className="py-3 pr-4 text-[13px] text-muted-foreground">{r.counterpartName ?? "—"}</td>
                      <td className="py-3 pr-4 text-[13px] text-muted-foreground">{r.projectName ?? "—"}</td>
                      <td className="py-3 pr-4 text-[13px] text-muted-foreground">
                        {r.dueDate ? formatDate(r.dueDate) : "—"}
                      </td>
                      <td className="py-3 pr-4 text-[13px] font-semibold tabular-nums">
                        {formatMoney(r.totalAmount, r.currency)}
                      </td>
                      <td className="py-3 pr-4 text-[13px] font-semibold tabular-nums">
                        {formatMoney(r.remainingAmount, r.currency)}
                      </td>
                      <td className="py-3 pr-4">
                        <span className={cn("inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold", st.tone)}>
                          {transactionStatusLabel(r.status, type)}
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
