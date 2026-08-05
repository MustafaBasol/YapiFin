"use client";

import { useState } from "react";
import Link from "next/link";
import {
  Download,
  Plus,
  Search,
  X,
  ArrowUpRight,
  ArrowDownRight,
  Check,
  CalendarDays,
  HardHat,
  ReceiptText,
  Clock,
} from "lucide-react";
import { TradeIcon, TradePill } from "@/components/app/trade-icon";
import { BudgetActualChart, BudgetBar, SegmentedBar, ProgressRing } from "@/components/app/charts";
import { useLang } from "@/components/i18n/language-provider";
import { cn, formatMoney, formatRelative } from "@/lib/utils";
import {
  projects,
  summary,
  budgetTrend,
  dailyLogs,
  tasks,
  STATUS_META,
  TRADE_META,
  type ProjectStatus,
  type Project,
} from "@/lib/demo/data";

const FILTERS: { key: ProjectStatus | "all"; label: { tr: string; en: string } }[] = [
  { key: "all", label: { tr: "Tümü", en: "All" } },
  { key: "on_track", label: { tr: "Yolunda", en: "On track" } },
  { key: "at_risk", label: { tr: "Riskli", en: "At risk" } },
  { key: "delayed", label: { tr: "Gecikmiş", en: "Delayed" } },
];

function fmtDeadline(iso: string, lang: "tr" | "en") {
  const d = new Date(iso);
  const days = Math.round((d.getTime() - Date.now()) / 86400000);
  const date = d.toLocaleDateString(lang === "tr" ? "tr-TR" : "en-US", { day: "numeric", month: "short" });
  const rel = lang === "tr" ? `${days} gün` : `${days}d`;
  return { date, days, rel };
}

export default function DashboardPage() {
  const { t, lang } = useLang();
  const [selected, setSelected] = useState<string | null>("p1");
  const [drawerOpen, setDrawerOpen] = useState(true);
  const [filter, setFilter] = useState<ProjectStatus | "all">("all");
  const [query, setQuery] = useState("");

  const rows = projects.filter(
    (p) =>
      (filter === "all" || p.status === filter) &&
      (!query ||
        p.name.toLowerCase().includes(query.toLowerCase()) ||
        p.client.toLowerCase().includes(query.toLowerCase())),
  );

  const active = projects.find((p) => p.id === selected) ?? projects[0];
  const variance = summary.budgetVsActual.budget - summary.budgetVsActual.actual;
  const variancePct = (variance / summary.budgetVsActual.budget) * 100;

  return (
    <div className="mx-auto max-w-[1500px] animate-fade-in">
      <div className={cn("grid gap-6", drawerOpen ? "xl:grid-cols-[1fr_380px]" : "grid-cols-1")}>
        {/* ── Main column ──────────────────────────────────────────── */}
        <div className="min-w-0 space-y-6">
          {/* Page header */}
          <div className="flex flex-wrap items-center gap-3">
            <div>
              <h1 className="font-display text-2xl font-bold tracking-tight">
                {lang === "tr" ? "Şantiye paneli" : "Build cockpit"}
              </h1>
              <p className="mt-0.5 text-sm text-muted-foreground">
                {lang === "tr"
                  ? "Tüm projeler, programlar, bütçeler ve hakedişler tek bakışta."
                  : "Every project, schedule, budget and progress payment at a glance."}
              </p>
            </div>
            <div className="ml-auto flex items-center gap-2">
              <button className="inline-flex h-9 items-center gap-2 rounded-lg border border-border bg-card px-3.5 text-[13px] font-medium text-foreground shadow-pill transition-colors hover:bg-muted">
                <Download className="h-4 w-4 text-muted-foreground" />
                {lang === "tr" ? "Rapor indir" : "Export report"}
              </button>
              <button className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-primary px-3.5 text-[13px] font-semibold text-primary-foreground shadow-sm transition-opacity hover:opacity-90">
                <Plus className="h-4 w-4" />
                {lang === "tr" ? "Yeni proje" : "New project"}
              </button>
            </div>
          </div>

          {/* Stat row */}
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {/* Active projects */}
            <div className="rounded-2xl border border-border bg-card p-5 shadow-soft">
              <div className="flex items-center justify-between">
                <p className="text-[12.5px] font-medium text-muted-foreground">{t(summary.activeProjects.label)}</p>
                <span className="grid h-7 w-7 place-items-center rounded-lg bg-primary/10 text-primary">
                  <HardHat className="h-4 w-4" />
                </span>
              </div>
              <p className="mt-2.5 tnum text-[26px] font-bold leading-none">{summary.activeProjects.value}</p>
              <p className="mt-1.5 text-[11px] text-muted-foreground">{t(summary.activeProjects.hint)}</p>
            </div>

            {/* Budget vs actual */}
            <div className="rounded-2xl border border-border bg-card p-5 shadow-soft">
              <div className="flex items-center justify-between">
                <p className="text-[12.5px] font-medium text-muted-foreground">{t(summary.budgetVsActual.label)}</p>
                <span className={cn("inline-flex items-center gap-0.5 text-[11px] font-semibold", variancePct >= 0 ? "text-success" : "text-destructive")}>
                  {variancePct >= 0 ? <ArrowUpRight className="h-3 w-3" /> : <ArrowDownRight className="h-3 w-3" />}
                  {Math.abs(variancePct).toFixed(1)}%
                </span>
              </div>
              <p className="mt-2.5 tnum text-[26px] font-bold leading-none">{formatMoney(summary.budgetVsActual.actual)}</p>
              <p className="mt-1.5 tnum text-[11px] text-muted-foreground">
                {lang === "tr" ? "bütçe" : "of"} {formatMoney(summary.budgetVsActual.budget)}
              </p>
            </div>

            {/* Progress billing due */}
            <div className="rounded-2xl border border-border bg-card p-5 shadow-soft">
              <div className="flex items-center justify-between">
                <p className="text-[12.5px] font-medium text-muted-foreground">{t(summary.billingDue.label)}</p>
                <span className="inline-flex items-center gap-1 rounded-full bg-success/10 px-2 py-0.5 text-[11px] font-semibold text-success">
                  {summary.billingDue.count}
                </span>
              </div>
              <p className="mt-2.5 tnum text-[26px] font-bold leading-none">{formatMoney(summary.billingDue.value)}</p>
              <p className="mt-1.5 text-[11px] text-muted-foreground">{lang === "tr" ? "fatura edilmeye hazır" : "ready to invoice"}</p>
            </div>

            {/* Open RFIs/tasks */}
            <div className="rounded-2xl border border-border bg-card p-5 shadow-soft">
              <div className="flex items-center justify-between">
                <p className="text-[12.5px] font-medium text-muted-foreground">{t(summary.openItems.label)}</p>
                <span className="inline-flex items-center gap-0.5 text-[11px] font-semibold text-success">
                  <ArrowDownRight className="h-3 w-3" />
                  {Math.abs(summary.openItems.delta)}
                </span>
              </div>
              <p className="mt-2.5 tnum text-[26px] font-bold leading-none">{summary.openItems.value}</p>
              <p className="mt-1.5 text-[11px] text-muted-foreground">{lang === "tr" ? "bu hafta açılan" : "open this week"}</p>
            </div>
          </div>

          {/* Projects list */}
          <div className="overflow-hidden rounded-2xl border border-border bg-card shadow-soft">
            <div className="flex flex-wrap items-center gap-2.5 border-b border-border p-4">
              <h2 className="font-display text-[15px] font-semibold tracking-tight">
                {lang === "tr" ? "Projeler" : "Projects"}
              </h2>
              <div className="ml-auto flex flex-wrap items-center gap-2">
                {/* Status filter (useState) */}
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
                    className="w-28 bg-transparent text-foreground placeholder:text-muted-foreground/70 focus:outline-none sm:w-36"
                  />
                </div>
              </div>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-left">
                    <th className="label-mono py-2.5 pl-4 font-medium text-muted-foreground">{lang === "tr" ? "Proje" : "Project"}</th>
                    <th className="label-mono py-2.5 font-medium text-muted-foreground">{lang === "tr" ? "İlerleme" : "Progress"}</th>
                    <th className="label-mono py-2.5 font-medium text-muted-foreground">{lang === "tr" ? "Bütçe / harcanan" : "Budget / spent"}</th>
                    <th className="label-mono py-2.5 font-medium text-muted-foreground">{lang === "tr" ? "Durum" : "Status"}</th>
                    <th className="label-mono py-2.5 pr-4 text-right font-medium text-muted-foreground">{lang === "tr" ? "Teslim" : "Deadline"}</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((p) => {
                    const isSel = p.id === selected;
                    const st = STATUS_META[p.status];
                    const dl = fmtDeadline(p.deadline, lang);
                    const over = p.spent > p.budget;
                    return (
                      <tr
                        key={p.id}
                        onClick={() => {
                          setSelected(p.id);
                          setDrawerOpen(true);
                        }}
                        className={cn(
                          "cursor-pointer border-b border-border/60 transition-colors last:border-0",
                          isSel ? "bg-primary/[0.04]" : "hover:bg-muted/50",
                        )}
                      >
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
                            <div className="h-1.5 w-20 overflow-hidden rounded-full bg-muted">
                              <div className="h-full rounded-full bg-primary" style={{ width: `${p.pct}%` }} />
                            </div>
                            <span className="tnum text-xs font-semibold">{p.pct}%</span>
                          </div>
                        </td>
                        <td className="py-3 pr-4">
                          <p className="tnum text-[13px] font-semibold">{formatMoney(p.spent)}</p>
                          <p className={cn("tnum text-[11px]", over ? "text-destructive" : "text-muted-foreground")}>
                            / {formatMoney(p.budget)}
                          </p>
                        </td>
                        <td className="py-3 pr-4">
                          <span className={cn("inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold", st.tone)}>
                            <span className="h-1.5 w-1.5 rounded-full" style={{ background: st.dot }} />
                            {t(st.label)}
                          </span>
                        </td>
                        <td className="py-3 pr-4 text-right">
                          <p className="tnum text-[13px] font-medium">{dl.date}</p>
                          <p className={cn("tnum text-[11px]", dl.days < 21 ? "text-warning-foreground" : "text-muted-foreground")}>{dl.rel}</p>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>

          {/* Budget vs actual chart */}
          <div className="rounded-2xl border border-border bg-card p-5 shadow-soft">
            <div className="flex items-start justify-between">
              <div>
                <h3 className="font-display text-[15px] font-semibold tracking-tight">{t(budgetTrend.title)}</h3>
                <p className="text-xs text-muted-foreground">{t(budgetTrend.subtitle)}</p>
              </div>
              <div className="flex items-center gap-3 text-[11px] text-muted-foreground">
                <span className="inline-flex items-center gap-1.5">
                  <span className="h-2 w-3 rounded-full bg-primary" /> {lang === "tr" ? "Gerçek" : "Actual"}
                </span>
                <span className="inline-flex items-center gap-1.5">
                  <span className="h-0 w-3 border-t-2 border-dashed border-muted-foreground" /> {lang === "tr" ? "Bütçe" : "Budget"}
                </span>
              </div>
            </div>
            <div className="mt-4">
              <BudgetActualChart budget={budgetTrend.budget} actual={budgetTrend.actual} labels={budgetTrend.labels} height={170} />
            </div>
          </div>

          {/* Subcontractors + Tasks */}
          <div className="grid gap-6 lg:grid-cols-[1.4fr_1fr]">
            {/* Subcontractors panel */}
            <div className="overflow-hidden rounded-2xl border border-border bg-card shadow-soft">
              <div className="flex items-center justify-between border-b border-border p-4">
                <h3 className="font-display text-[15px] font-semibold tracking-tight">{lang === "tr" ? "Taşeronlar" : "Subcontractors"}</h3>
                <Link href="/projects" className="inline-flex items-center gap-1 text-[13px] font-medium text-primary hover:underline">
                  {lang === "tr" ? "Tümü" : "View all"}
                  <ArrowUpRight className="h-3.5 w-3.5" />
                </Link>
              </div>
              <div className="divide-y divide-border/60">
                {active.subs.map((sub) => (
                  <div key={sub.id} className="flex items-center gap-3 px-4 py-3">
                    <TradeIcon trade={sub.trade} size={30} />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-semibold leading-tight">{sub.name}</p>
                      <p className="text-xs text-muted-foreground">{t(TRADE_META[sub.trade].label)} · {formatMoney(sub.contract)}</p>
                    </div>
                    {sub.tasks > 0 && (
                      <span className="tnum rounded-full bg-muted px-2 py-0.5 text-[11px] font-semibold text-muted-foreground">
                        {sub.tasks} {lang === "tr" ? "görev" : "tasks"}
                      </span>
                    )}
                    <SubStatus status={sub.status} lang={lang} />
                  </div>
                ))}
              </div>
            </div>

            {/* Daily logs / tasks panel */}
            <div className="rounded-2xl border border-border bg-card p-5 shadow-soft">
              <div className="flex items-center justify-between">
                <h3 className="font-display text-[15px] font-semibold tracking-tight">{lang === "tr" ? "Bugünün görevleri" : "Today's tasks"}</h3>
                <span className="tnum rounded-full bg-primary/10 px-2 py-0.5 text-[11px] font-semibold text-primary">
                  {tasks.filter((x) => !x.done).length} {lang === "tr" ? "açık" : "open"}
                </span>
              </div>
              <div className="mt-3.5 space-y-2.5">
                {tasks.map((task) => (
                  <div key={task.id} className="flex items-start gap-2.5">
                    <span className={cn("mt-0.5 grid h-4 w-4 shrink-0 place-items-center rounded-[5px] border", task.done ? "border-success bg-success text-success-foreground" : "border-border bg-card")}>
                      {task.done && <Check className="h-3 w-3" strokeWidth={3} />}
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className={cn("text-[13px] leading-snug", task.done && "text-muted-foreground line-through")}>{t(task.label)}</p>
                      <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                        <TradePill trade={task.trade} label={task.project} />
                        <span>·</span>
                        <span className="inline-flex items-center gap-0.5"><Clock className="h-3 w-3" />{t(task.due)}</span>
                      </p>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* Daily log feed */}
          <div className="overflow-hidden rounded-2xl border border-border bg-card shadow-soft">
            <div className="flex items-center justify-between border-b border-border p-4">
              <h3 className="font-display text-[15px] font-semibold tracking-tight">{lang === "tr" ? "Şantiye günlüğü" : "Daily log"}</h3>
              <CalendarDays className="h-4 w-4 text-muted-foreground" />
            </div>
            <div className="divide-y divide-border/60">
              {dailyLogs.map((log) => (
                <div key={log.id} className="flex items-start gap-2.5 px-4 py-3">
                  <span
                    className={cn(
                      "mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full",
                      log.tone === "success" ? "bg-success" : log.tone === "warning" ? "bg-warning" : log.tone === "info" ? "bg-info" : "bg-muted-foreground",
                    )}
                  />
                  <div className="min-w-0 flex-1 text-[13px]">
                    <p className="leading-snug">
                      <span className="font-semibold">{log.who}</span>{" "}
                      <span className="text-muted-foreground">{t(log.action)}</span>{" "}
                      <span className="font-medium">{log.target}</span>
                    </p>
                    <p className="text-[11px] text-muted-foreground">{log.project} · {formatRelative(log.at)}</p>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* ── Right detail drawer ──────────────────────────────────── */}
        {drawerOpen && <ProjectDrawer project={active} onClose={() => setDrawerOpen(false)} lang={lang} t={t} />}
      </div>
    </div>
  );
}

/* ── The project detail drawer ─────────────────────────────────────────────── */
function ProjectDrawer({
  project,
  onClose,
  lang,
  t,
}: {
  project: Project;
  onClose: () => void;
  lang: "tr" | "en";
  t: (v: { tr: string; en: string }) => string;
}) {
  const st = STATUS_META[project.status];
  const windowSpan = Math.max(...project.phases.map((p) => p.start + p.span));
  const billed = project.milestones.filter((m) => m.status === "billed").reduce((s, m) => s + (m.value * m.pct) / 100, 0);
  const ready = project.milestones.filter((m) => m.status === "ready").reduce((s, m) => s + (m.value * m.pct) / 100, 0);
  const retained = (billed * project.retainage) / 100;

  const tradeSegments = project.budgetLines.map((l) => ({
    label: t(TRADE_META[l.trade].label),
    value: l.budget,
    color: TRADE_META[l.trade].color,
  }));

  return (
    <aside className="animate-float-up xl:sticky xl:top-2 xl:self-start">
      <div className="space-y-5 rounded-2xl border border-border bg-card p-5 shadow-soft">
        {/* Header */}
        <div className="flex items-center justify-between">
          <h2 className="font-display text-[15px] font-semibold tracking-tight">{lang === "tr" ? "Proje detayı" : "Project detail"}</h2>
          <button
            onClick={onClose}
            aria-label={lang === "tr" ? "Kapat" : "Close"}
            className="grid h-7 w-7 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Project header */}
        <div className="flex items-center gap-3 rounded-xl border border-border bg-muted/40 p-3">
          <ProgressRing pct={project.pct} size={48} />
          <div className="min-w-0">
            <p className="truncate font-semibold leading-tight">{project.name}</p>
            <p className="truncate text-xs text-muted-foreground">{project.client} · {t(project.type)}</p>
          </div>
        </div>

        {/* Status + budget summary */}
        <div className="grid grid-cols-2 gap-3">
          <div className="rounded-xl border border-border p-3">
            <p className="text-[11px] text-muted-foreground">{lang === "tr" ? "Durum" : "Status"}</p>
            <span className={cn("mt-1.5 inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold", st.tone)}>
              <span className="h-1.5 w-1.5 rounded-full" style={{ background: st.dot }} />
              {t(st.label)}
            </span>
          </div>
          <div className="rounded-xl border border-border p-3">
            <p className="text-[11px] text-muted-foreground">{lang === "tr" ? "Kalan bütçe" : "Budget left"}</p>
            <p className={cn("mt-1 tnum text-sm font-bold", project.spent > project.budget ? "text-destructive" : "text-foreground")}>
              {formatMoney(project.budget - project.spent)}
            </p>
          </div>
        </div>

        {/* Schedule (Gantt-style) */}
        <div>
          <p className="label-mono mb-2.5 text-muted-foreground">{lang === "tr" ? "Program" : "Schedule"}</p>
          <div className="space-y-2">
            {project.phases.map((ph) => (
              <div key={t(ph.name)} className="grid grid-cols-[1fr_2.2fr] items-center gap-2.5">
                <span className="flex items-center gap-1.5 truncate text-[12px] font-medium">
                  <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: TRADE_META[ph.trade].color }} />
                  <span className="truncate">{t(ph.name)}</span>
                </span>
                <div className="relative h-4 overflow-hidden rounded-full bg-muted">
                  <div
                    className="absolute top-0 h-full rounded-full"
                    style={{
                      left: `${(ph.start / windowSpan) * 100}%`,
                      width: `${(ph.span / windowSpan) * 100}%`,
                      background: `color-mix(in oklch, ${TRADE_META[ph.trade].color} 30%, white)`,
                    }}
                  />
                  <div
                    className="absolute top-0 h-full rounded-full"
                    style={{
                      left: `${(ph.start / windowSpan) * 100}%`,
                      width: `${((ph.span * ph.pct) / 100 / windowSpan) * 100}%`,
                      background: TRADE_META[ph.trade].color,
                    }}
                  />
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Budget breakdown by trade */}
        <div>
          <p className="label-mono mb-2.5 text-muted-foreground">{lang === "tr" ? "Bütçe dağılımı" : "Budget breakdown"}</p>
          <SegmentedBar segments={tradeSegments} />
          <div className="mt-3.5 space-y-2">
            {project.budgetLines.map((l) => {
              const over = l.actual > l.budget;
              return (
                <div key={l.code} className="grid grid-cols-[auto_1fr] items-center gap-2.5">
                  <span className="tnum w-12 text-[10.5px] text-muted-foreground">{l.code}</span>
                  <div className="min-w-0">
                    <div className="flex items-center justify-between text-[12px]">
                      <span className="truncate font-medium">{t(l.label)}</span>
                      <span className={cn("tnum", over ? "text-destructive font-semibold" : "text-muted-foreground")}>{formatMoney(l.actual)}</span>
                    </div>
                    <BudgetBar budget={l.budget} actual={l.actual} className="mt-1" />
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Subcontractors */}
        <div>
          <p className="label-mono mb-2.5 text-muted-foreground">{lang === "tr" ? "Taşeronlar" : "Subcontractors"}</p>
          <div className="space-y-1.5">
            {project.subs.map((s) => (
              <div key={s.id} className="flex items-center gap-2.5 rounded-lg border border-border px-2.5 py-2">
                <TradeIcon trade={s.trade} size={24} />
                <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium">{s.name}</span>
                <SubStatus status={s.status} lang={lang} />
              </div>
            ))}
          </div>
        </div>

        {/* Progress billing / hakediş milestones */}
        <div>
          <p className="label-mono mb-2.5 text-muted-foreground">{lang === "tr" ? "Hakediş kalemleri" : "Progress billing"}</p>
          <div className="space-y-2.5">
            {project.milestones.map((m) => (
              <div key={m.id}>
                <div className="flex items-center justify-between text-[12px]">
                  <span className="flex items-center gap-1.5 font-medium">
                    <MilestoneDot status={m.status} />
                    {t(m.label)}
                  </span>
                  <span className="tnum text-muted-foreground">{m.pct}%</span>
                </div>
                <div className="mt-1 flex items-center gap-2">
                  <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
                    <div
                      className="h-full rounded-full"
                      style={{ width: `${m.pct}%`, background: m.status === "billed" ? "var(--color-success)" : m.status === "ready" ? "var(--color-primary)" : "var(--color-muted-foreground)" }}
                    />
                  </div>
                  <span className="tnum text-[11px] text-muted-foreground">{formatMoney(m.value)}</span>
                </div>
              </div>
            ))}
          </div>
          <div className="mt-3.5 grid grid-cols-3 gap-2 rounded-xl border border-border bg-muted/40 p-3 text-center">
            <div>
              <p className="text-[10px] text-muted-foreground">{lang === "tr" ? "Faturalandı" : "Billed"}</p>
              <p className="tnum text-[13px] font-bold text-success">{formatMoney(billed)}</p>
            </div>
            <div>
              <p className="text-[10px] text-muted-foreground">{lang === "tr" ? "Hazır" : "Ready"}</p>
              <p className="tnum text-[13px] font-bold text-primary">{formatMoney(ready)}</p>
            </div>
            <div>
              <p className="text-[10px] text-muted-foreground">{lang === "tr" ? "Teminat" : "Retainage"}</p>
              <p className="tnum text-[13px] font-bold text-foreground">{formatMoney(retained)}</p>
            </div>
          </div>
        </div>

        <button className="flex w-full items-center justify-center gap-1.5 rounded-lg bg-primary py-2.5 text-[13px] font-semibold text-primary-foreground transition-opacity hover:opacity-90">
          <ReceiptText className="h-4 w-4" />
          {lang === "tr" ? "Hakediş hazırla" : "Draft progress invoice"}
        </button>
      </div>
    </aside>
  );
}

function SubStatus({ status, lang }: { status: string; lang: "tr" | "en" }) {
  const map: Record<string, { tr: string; en: string; cls: string }> = {
    active: { tr: "çalışıyor", en: "active", cls: "text-success bg-success/10" },
    scheduled: { tr: "planlandı", en: "scheduled", cls: "text-info bg-info/10" },
    done: { tr: "bitti", en: "done", cls: "text-muted-foreground bg-muted" },
    overdue: { tr: "gecikmiş", en: "overdue", cls: "text-destructive bg-destructive/10" },
  };
  const s = map[status] ?? map.scheduled;
  return (
    <span className={cn("inline-flex rounded-full px-1.5 py-0.5 text-[10px] font-semibold", s.cls)}>
      {lang === "tr" ? s.tr : s.en}
    </span>
  );
}

function MilestoneDot({ status }: { status: string }) {
  const color = status === "billed" ? "var(--color-success)" : status === "ready" ? "var(--color-primary)" : "var(--color-muted-foreground)";
  return <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: color, opacity: status === "pending" ? 0.4 : 1 }} />;
}
