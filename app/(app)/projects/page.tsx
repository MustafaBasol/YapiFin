"use client";

import { useMemo, useState } from "react";
import {
  Search,
  Plus,
  HardHat,
  Users,
  ArrowUpRight,
  LayoutGrid,
  List,
} from "lucide-react";
import { TradeIcon } from "@/components/app/trade-icon";
import { ProgressRing, BudgetBar } from "@/components/app/charts";
import { useLang } from "@/components/i18n/language-provider";
import { cn, formatMoney } from "@/lib/utils";
import {
  projects,
  STATUS_META,
  TRADE_META,
  type ProjectStatus,
} from "@/lib/demo/data";

const FILTERS: { key: ProjectStatus | "all"; label: { tr: string; en: string } }[] = [
  { key: "all", label: { tr: "Tümü", en: "All" } },
  { key: "on_track", label: { tr: "Yolunda", en: "On track" } },
  { key: "at_risk", label: { tr: "Riskli", en: "At risk" } },
  { key: "delayed", label: { tr: "Gecikmiş", en: "Delayed" } },
];

export default function ProjectsPage() {
  const { t, lang } = useLang();
  const [filter, setFilter] = useState<ProjectStatus | "all">("all");
  const [query, setQuery] = useState("");
  const [view, setView] = useState<"grid" | "list">("grid");

  const rows = useMemo(
    () =>
      projects.filter(
        (p) =>
          (filter === "all" || p.status === filter) &&
          (!query ||
            p.name.toLowerCase().includes(query.toLowerCase()) ||
            p.client.toLowerCase().includes(query.toLowerCase())),
      ),
    [filter, query],
  );

  return (
    <div className="mx-auto max-w-[1500px] animate-fade-in space-y-6">
      {/* Header */}
      <div className="flex flex-wrap items-center gap-3">
        <div>
          <h1 className="font-display text-2xl font-bold tracking-tight">
            {lang === "tr" ? "Projeler" : "Projects"}
          </h1>
          <p className="mt-0.5 text-sm text-muted-foreground">
            {lang === "tr"
              ? "Tüm aktif inşaatlar, taşeronlar ve bütçeleriyle."
              : "Every active build, with its subcontractors and budget."}
          </p>
        </div>
        <button className="ml-auto inline-flex h-9 items-center gap-1.5 rounded-lg bg-primary px-3.5 text-[13px] font-semibold text-primary-foreground shadow-sm transition-opacity hover:opacity-90">
          <Plus className="h-4 w-4" />
          {lang === "tr" ? "Yeni proje" : "New project"}
        </button>
      </div>

      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-2.5">
        <div className="flex items-center rounded-lg border border-border bg-card p-0.5">
          {FILTERS.map((f) => (
            <button
              key={f.key}
              onClick={() => setFilter(f.key)}
              className={cn(
                "rounded-md px-2.5 py-1 text-[12px] font-medium transition-colors",
                filter === f.key ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground",
              )}
            >
              {lang === "tr" ? f.label.tr : f.label.en}
            </button>
          ))}
        </div>
        <div className="flex h-9 items-center gap-2 rounded-lg border border-border bg-card px-3 text-sm">
          <Search className="h-4 w-4 text-muted-foreground" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={lang === "tr" ? "Proje ara…" : "Search…"}
            className="w-32 bg-transparent text-foreground placeholder:text-muted-foreground/70 focus:outline-none sm:w-44"
          />
        </div>
        <div className="ml-auto flex items-center rounded-lg border border-border bg-card p-0.5">
          <button
            onClick={() => setView("grid")}
            aria-label="Grid view"
            className={cn("grid h-7 w-7 place-items-center rounded-md transition-colors", view === "grid" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground")}
          >
            <LayoutGrid className="h-4 w-4" />
          </button>
          <button
            onClick={() => setView("list")}
            aria-label="List view"
            className={cn("grid h-7 w-7 place-items-center rounded-md transition-colors", view === "list" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground")}
          >
            <List className="h-4 w-4" />
          </button>
        </div>
      </div>

      {/* Grid view */}
      {view === "grid" ? (
        <div className="grid gap-5 sm:grid-cols-2 xl:grid-cols-3">
          {rows.map((p) => {
            const st = STATUS_META[p.status];
            const over = p.spent > p.budget;
            return (
              <div key={p.id} className="flex flex-col rounded-2xl border border-border bg-card p-5 shadow-soft transition-shadow hover:shadow-pop">
                <div className="flex items-start gap-3">
                  <ProgressRing pct={p.pct} size={44} />
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-semibold leading-tight">{p.name}</p>
                    <p className="truncate text-xs text-muted-foreground">{p.client} · {t(p.type)}</p>
                  </div>
                  <span className={cn("inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold", st.tone)}>
                    <span className="h-1.5 w-1.5 rounded-full" style={{ background: st.dot }} />
                    {t(st.label)}
                  </span>
                </div>

                <div className="mt-4">
                  <div className="flex items-center justify-between text-[12px]">
                    <span className="text-muted-foreground">{lang === "tr" ? "Bütçe vs gerçek" : "Budget vs actual"}</span>
                    <span className={cn("tnum font-semibold", over ? "text-destructive" : "text-foreground")}>
                      {formatMoney(p.spent)} / {formatMoney(p.budget)}
                    </span>
                  </div>
                  <BudgetBar budget={p.budget} actual={p.spent} className="mt-1.5" />
                </div>

                <div className="mt-4 flex items-center gap-1.5">
                  {p.subs.slice(0, 5).map((s) => (
                    <TradeIcon key={s.id} trade={s.trade} size={26} />
                  ))}
                  <span className="ml-1 inline-flex items-center gap-1 text-[11px] text-muted-foreground">
                    <Users className="h-3.5 w-3.5" />
                    {p.subs.length} {lang === "tr" ? "taşeron" : "subs"}
                  </span>
                </div>

                <button className="mt-4 inline-flex items-center justify-center gap-1 rounded-lg border border-border py-2 text-[13px] font-medium text-foreground transition-colors hover:bg-muted">
                  {lang === "tr" ? "Projeyi aç" : "Open project"}
                  <ArrowUpRight className="h-3.5 w-3.5" />
                </button>
              </div>
            );
          })}
        </div>
      ) : (
        /* List view */
        <div className="overflow-hidden rounded-2xl border border-border bg-card shadow-soft">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left">
                  <th className="label-mono py-2.5 pl-4 font-medium text-muted-foreground">{lang === "tr" ? "Proje" : "Project"}</th>
                  <th className="label-mono py-2.5 font-medium text-muted-foreground">{lang === "tr" ? "İlerleme" : "Progress"}</th>
                  <th className="label-mono py-2.5 font-medium text-muted-foreground">{lang === "tr" ? "Bütçe / harcanan" : "Budget / spent"}</th>
                  <th className="label-mono py-2.5 font-medium text-muted-foreground">{lang === "tr" ? "Taşeron" : "Subs"}</th>
                  <th className="label-mono py-2.5 pr-4 font-medium text-muted-foreground">{lang === "tr" ? "Durum" : "Status"}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((p) => {
                  const st = STATUS_META[p.status];
                  const over = p.spent > p.budget;
                  return (
                    <tr key={p.id} className="border-b border-border/60 transition-colors last:border-0 hover:bg-muted/50">
                      <td className="py-3 pl-4">
                        <div className="flex items-center gap-3">
                          <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg text-[11px] font-bold text-white" style={{ backgroundImage: "var(--grad-brand)" }}>
                            {p.name.split(" ").slice(0, 2).map((w) => w[0]).join("")}
                          </span>
                          <div className="min-w-0">
                            <p className="font-semibold leading-tight">{p.name}</p>
                            <p className="truncate text-xs text-muted-foreground">{p.client}</p>
                          </div>
                        </div>
                      </td>
                      <td className="py-3 pr-4">
                        <div className="flex items-center gap-2.5">
                          <div className="h-1.5 w-24 overflow-hidden rounded-full bg-muted">
                            <div className="h-full rounded-full bg-primary" style={{ width: `${p.pct}%` }} />
                          </div>
                          <span className="tnum text-xs font-semibold">{p.pct}%</span>
                        </div>
                      </td>
                      <td className="py-3 pr-4">
                        <p className="tnum text-[13px] font-semibold">{formatMoney(p.spent)}</p>
                        <p className={cn("tnum text-[11px]", over ? "text-destructive" : "text-muted-foreground")}>/ {formatMoney(p.budget)}</p>
                      </td>
                      <td className="py-3 pr-4">
                        <div className="flex items-center gap-1">
                          {p.subs.slice(0, 4).map((s) => (
                            <TradeIcon key={s.id} trade={s.trade} size={22} />
                          ))}
                        </div>
                      </td>
                      <td className="py-3 pr-4">
                        <span className={cn("inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold", st.tone)}>
                          <span className="h-1.5 w-1.5 rounded-full" style={{ background: st.dot }} />
                          {t(st.label)}
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

      {rows.length === 0 && (
        <div className="grid place-items-center rounded-2xl border border-dashed border-border bg-card py-16 text-center">
          <HardHat className="h-8 w-8 text-muted-foreground/50" />
          <p className="mt-3 text-sm text-muted-foreground">
            {lang === "tr" ? "Bu filtreyle eşleşen proje yok." : "No projects match this filter."}
          </p>
        </div>
      )}
    </div>
  );
}
