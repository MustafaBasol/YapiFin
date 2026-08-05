"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { HardHat, Search } from "lucide-react";
import { cn, formatMoney } from "@/lib/utils";
import { PROJECT_STATUS_META, PROJECT_STATUS_OPTIONS } from "@/components/app/project-status";
import type { ProjectStatus } from "@prisma/client";

interface Row {
  id: string;
  code: string;
  name: string;
  status: ProjectStatus;
  customerName: string | null;
  contractAmount: string;
  memberCount: number;
}

export function ProjectsTable({ projects }: { projects: Row[] }) {
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<ProjectStatus | "all">("all");

  const rows = useMemo(
    () =>
      projects.filter(
        (p) =>
          (status === "all" || p.status === status) &&
          (!query ||
            p.name.toLowerCase().includes(query.toLowerCase()) ||
            p.code.toLowerCase().includes(query.toLowerCase())),
      ),
    [projects, query, status],
  );

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2.5">
        <div className="flex items-center rounded-lg border border-border bg-card p-0.5">
          <button
            onClick={() => setStatus("all")}
            className={cn(
              "rounded-md px-2.5 py-1 text-[12px] font-medium transition-colors",
              status === "all" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground",
            )}
          >
            Tümü
          </button>
          {PROJECT_STATUS_OPTIONS.map((s) => (
            <button
              key={s}
              onClick={() => setStatus(s)}
              className={cn(
                "rounded-md px-2.5 py-1 text-[12px] font-medium transition-colors",
                status === s ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground",
              )}
            >
              {PROJECT_STATUS_META[s].label}
            </button>
          ))}
        </div>
        <div className="flex h-9 items-center gap-2 rounded-lg border border-border bg-card px-3 text-sm">
          <Search className="h-4 w-4 text-muted-foreground" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Proje ara…"
            className="w-32 bg-transparent text-foreground placeholder:text-muted-foreground/70 focus:outline-none sm:w-44"
          />
        </div>
      </div>

      {rows.length === 0 ? (
        <div className="grid place-items-center rounded-2xl border border-dashed border-border bg-card py-16 text-center">
          <HardHat className="h-8 w-8 text-muted-foreground/50" />
          <p className="mt-3 text-sm text-muted-foreground">
            {projects.length === 0 ? "Henüz proje eklenmemiş." : "Bu filtreyle eşleşen proje yok."}
          </p>
        </div>
      ) : (
        <div className="overflow-hidden rounded-2xl border border-border bg-card shadow-soft">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left">
                  <th className="label-mono py-2.5 pl-4 font-medium text-muted-foreground">Proje</th>
                  <th className="label-mono py-2.5 font-medium text-muted-foreground">Müşteri</th>
                  <th className="label-mono py-2.5 font-medium text-muted-foreground">Sözleşme bedeli</th>
                  <th className="label-mono py-2.5 font-medium text-muted-foreground">Ekip</th>
                  <th className="label-mono py-2.5 pr-4 font-medium text-muted-foreground">Durum</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((p) => {
                  const st = PROJECT_STATUS_META[p.status];
                  return (
                    <tr
                      key={p.id}
                      className="cursor-pointer border-b border-border/60 transition-colors last:border-0 hover:bg-muted/50"
                    >
                      <td className="py-3 pl-4">
                        <Link href={`/projects/${p.id}`} className="flex items-center gap-3">
                          <span
                            className="grid h-9 w-9 shrink-0 place-items-center rounded-lg text-[11px] font-bold text-white"
                            style={{ backgroundImage: "var(--grad-brand)" }}
                          >
                            {p.code.slice(0, 2).toUpperCase()}
                          </span>
                          <div className="min-w-0">
                            <p className="font-semibold leading-tight">{p.name}</p>
                            <p className="truncate text-xs text-muted-foreground">{p.code}</p>
                          </div>
                        </Link>
                      </td>
                      <td className="py-3 pr-4 text-[13px] text-muted-foreground">{p.customerName ?? "—"}</td>
                      <td className="tnum py-3 pr-4 text-[13px] font-semibold">{formatMoney(p.contractAmount)}</td>
                      <td className="py-3 pr-4 text-[13px] text-muted-foreground">{p.memberCount} kişi</td>
                      <td className="py-3 pr-4">
                        <span className={cn("inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold", st.tone)}>
                          {st.label}
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
