"use client";

import { useState } from "react";
import { CalendarRange, ChevronDown } from "lucide-react";
import { TradePill } from "@/components/app/trade-icon";
import { useLang } from "@/components/i18n/language-provider";
import { cn } from "@/lib/utils";
import { projects, STATUS_META, TRADE_META, type Trade } from "@/lib/demo/data";

/* A rolling 10-month window for the Gantt header. */
const MONTHS_TR = ["Oca", "Şub", "Mar", "Nis", "May", "Haz", "Tem", "Ağu", "Eyl", "Eki"];
const MONTHS_EN = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct"];
const WINDOW = 10;

export default function SchedulePage() {
  const { t, lang } = useLang();
  const [open, setOpen] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(projects.map((p, i) => [p.id, i < 3])),
  );
  const months = lang === "tr" ? MONTHS_TR : MONTHS_EN;

  const allTrades = Array.from(
    new Set(projects.flatMap((p) => p.phases.map((ph) => ph.trade))),
  ) as Trade[];

  return (
    <div className="mx-auto max-w-[1500px] animate-fade-in space-y-6">
      {/* Header */}
      <div className="flex flex-wrap items-center gap-3">
        <div>
          <h1 className="font-display text-2xl font-bold tracking-tight">
            {lang === "tr" ? "Program" : "Schedule"}
          </h1>
          <p className="mt-0.5 text-sm text-muted-foreground">
            {lang === "tr"
              ? "Tüm projelerin fazları tek zaman çizelgesinde — gecikmeleri erken yakala."
              : "Every project's phases on one timeline — catch slippage early."}
          </p>
        </div>
        <div className="ml-auto inline-flex items-center gap-2 rounded-lg border border-border bg-card px-3 py-1.5 text-[13px] font-medium text-muted-foreground shadow-pill">
          <CalendarRange className="h-4 w-4 text-primary" />
          {lang === "tr" ? "10 aylık görünüm" : "10-month view"}
        </div>
      </div>

      {/* Trade legend */}
      <div className="flex flex-wrap gap-x-4 gap-y-2 rounded-xl border border-border bg-card px-4 py-3 shadow-soft">
        {allTrades.map((tr) => (
          <TradePill key={tr} trade={tr} label={t(TRADE_META[tr].label)} />
        ))}
      </div>

      {/* Gantt */}
      <div className="overflow-hidden rounded-2xl border border-border bg-card shadow-soft">
        {/* Month header */}
        <div className="grid grid-cols-[minmax(190px,1.1fr)_3fr] border-b border-border">
          <div className="px-4 py-2.5">
            <span className="label-mono text-muted-foreground">{lang === "tr" ? "Proje / faz" : "Project / phase"}</span>
          </div>
          <div className="relative grid border-l border-border" style={{ gridTemplateColumns: `repeat(${WINDOW}, 1fr)` }}>
            {months.map((mo, i) => (
              <div key={i} className="border-r border-border/60 px-2 py-2.5 text-center last:border-0">
                <span className="tnum text-[11px] font-medium text-muted-foreground">{mo}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Project rows */}
        {projects.map((p) => {
          const st = STATUS_META[p.status];
          const isOpen = open[p.id];
          return (
            <div key={p.id} className="border-b border-border/60 last:border-0">
              {/* Project header row */}
              <button
                onClick={() => setOpen((o) => ({ ...o, [p.id]: !o[p.id] }))}
                className="grid w-full grid-cols-[minmax(190px,1.1fr)_3fr] items-center text-left transition-colors hover:bg-muted/40"
              >
                <div className="flex items-center gap-2.5 px-4 py-3">
                  <ChevronDown className={cn("h-4 w-4 shrink-0 text-muted-foreground transition-transform", !isOpen && "-rotate-90")} />
                  <span className="grid h-7 w-7 shrink-0 place-items-center rounded-md text-[10px] font-bold text-white" style={{ backgroundImage: "var(--grad-brand)" }}>
                    {p.name.split(" ").slice(0, 2).map((w) => w[0]).join("")}
                  </span>
                  <div className="min-w-0">
                    <p className="truncate text-[13px] font-semibold leading-tight">{p.name}</p>
                    <span className={cn("inline-flex items-center gap-1 rounded-full px-1.5 py-0 text-[10px] font-semibold", st.tone)}>
                      <span className="h-1 w-1 rounded-full" style={{ background: st.dot }} />
                      {t(st.label)}
                    </span>
                  </div>
                </div>
                {/* Summary bar (overall pct) */}
                <div className="relative h-full border-l border-border px-3 py-3">
                  <div className="relative h-2.5 overflow-hidden rounded-full bg-muted">
                    <div className="h-full rounded-full bg-primary/30" style={{ width: "100%" }} />
                    <div className="absolute top-0 h-full rounded-full bg-primary" style={{ width: `${p.pct}%` }} />
                  </div>
                </div>
              </button>

              {/* Phase rows */}
              {isOpen &&
                p.phases.map((ph, i) => (
                  <div key={i} className="grid grid-cols-[minmax(190px,1.1fr)_3fr] items-center bg-muted/20">
                    <div className="flex items-center gap-2 py-2 pl-12 pr-4">
                      <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: TRADE_META[ph.trade].color }} />
                      <span className="truncate text-[12px] font-medium">{t(ph.name)}</span>
                    </div>
                    <div className="relative grid h-full border-l border-border" style={{ gridTemplateColumns: `repeat(${WINDOW}, 1fr)` }}>
                      {Array.from({ length: WINDOW }).map((_, g) => (
                        <div key={g} className="border-r border-border/40 last:border-0" />
                      ))}
                      {/* The phase bar */}
                      <div
                        className="absolute top-1/2 h-3.5 -translate-y-1/2 overflow-hidden rounded-full"
                        style={{
                          left: `${(ph.start / WINDOW) * 100}%`,
                          width: `${(ph.span / WINDOW) * 100}%`,
                          background: `color-mix(in oklch, ${TRADE_META[ph.trade].color} 28%, white)`,
                        }}
                        title={`${t(ph.name)} · ${ph.pct}%`}
                      >
                        <div
                          className="h-full rounded-full"
                          style={{ width: `${ph.pct}%`, background: TRADE_META[ph.trade].color }}
                        />
                      </div>
                    </div>
                  </div>
                ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}
