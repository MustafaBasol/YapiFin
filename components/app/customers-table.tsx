"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { Search, Users } from "lucide-react";
import { cn } from "@/lib/utils";
import { CUSTOMER_TYPE_META } from "@/components/app/customer-type";

interface Row {
  id: string;
  type: string;
  name: string;
  contactName: string | null;
  phone: string | null;
  city: string | null;
  isActive: boolean;
  projectCount: number;
}

export function CustomersTable({ customers }: { customers: Row[] }) {
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<"active" | "archived" | "all">("active");

  const rows = useMemo(
    () =>
      customers.filter(
        (c) =>
          (status === "all" || (status === "active" ? c.isActive : !c.isActive)) &&
          (!query ||
            c.name.toLowerCase().includes(query.toLowerCase()) ||
            (c.contactName ?? "").toLowerCase().includes(query.toLowerCase())),
      ),
    [customers, query, status],
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
        <div className="flex h-9 items-center gap-2 rounded-lg border border-border bg-card px-3 text-sm">
          <Search className="h-4 w-4 text-muted-foreground" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Müşteri ara…"
            className="w-32 bg-transparent text-foreground placeholder:text-muted-foreground/70 focus:outline-none sm:w-44"
          />
        </div>
      </div>

      {rows.length === 0 ? (
        <div className="grid place-items-center rounded-2xl border border-dashed border-border bg-card py-16 text-center">
          <Users className="h-8 w-8 text-muted-foreground/50" />
          <p className="mt-3 text-sm text-muted-foreground">
            {customers.length === 0 ? "Henüz müşteri eklenmemiş." : "Bu filtreyle eşleşen müşteri yok."}
          </p>
        </div>
      ) : (
        <div className="overflow-hidden rounded-2xl border border-border bg-card shadow-soft">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left">
                  <th className="label-mono py-2.5 pl-4 font-medium text-muted-foreground">Müşteri</th>
                  <th className="label-mono py-2.5 font-medium text-muted-foreground">Tür</th>
                  <th className="label-mono py-2.5 font-medium text-muted-foreground">İlgili kişi</th>
                  <th className="label-mono py-2.5 font-medium text-muted-foreground">Telefon</th>
                  <th className="label-mono py-2.5 font-medium text-muted-foreground">Proje</th>
                  <th className="label-mono py-2.5 pr-4 font-medium text-muted-foreground">Durum</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((c) => {
                  const type = CUSTOMER_TYPE_META[c.type] ?? { label: c.type, tone: "bg-muted text-muted-foreground" };
                  return (
                    <tr
                      key={c.id}
                      className="cursor-pointer border-b border-border/60 transition-colors last:border-0 hover:bg-muted/50"
                    >
                      <td className="py-3 pl-4">
                        <Link href={`/customers/${c.id}`} className="flex items-center gap-3">
                          <span
                            className="grid h-9 w-9 shrink-0 place-items-center rounded-lg text-[11px] font-bold text-white"
                            style={{ backgroundImage: "var(--grad-brand)" }}
                          >
                            {c.name.slice(0, 2).toUpperCase()}
                          </span>
                          <p className="min-w-0 truncate font-semibold leading-tight">{c.name}</p>
                        </Link>
                      </td>
                      <td className="py-3 pr-4">
                        <span className={cn("inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold", type.tone)}>
                          {type.label}
                        </span>
                      </td>
                      <td className="py-3 pr-4 text-[13px] text-muted-foreground">{c.contactName ?? "—"}</td>
                      <td className="py-3 pr-4 text-[13px] text-muted-foreground">{c.phone ?? "—"}</td>
                      <td className="py-3 pr-4 text-[13px] text-muted-foreground">{c.projectCount} proje</td>
                      <td className="py-3 pr-4">
                        <span
                          className={cn(
                            "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold",
                            c.isActive ? "bg-success/12 text-success" : "bg-destructive/10 text-destructive",
                          )}
                        >
                          {c.isActive ? "Aktif" : "Arşivlendi"}
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
