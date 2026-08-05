"use client";

import { useState } from "react";
import { useRouter, useSearchParams, usePathname } from "next/navigation";
import { CASH_FLOW_RANGES, CASH_FLOW_SCENARIOS, type CashFlowRange, type CashFlowScenario } from "@/lib/validation/reports";

const RANGE_LABELS: Record<CashFlowRange, string> = {
  CURRENT_MONTH: "Bu ay",
  NEXT_30_DAYS: "Gelecek 30 gün",
  NEXT_90_DAYS: "Gelecek 90 gün",
  CURRENT_YEAR: "Bu yıl",
  CUSTOM: "Özel aralık",
};

const SCENARIO_LABELS: Record<CashFlowScenario, string> = {
  ON_DUE_DATE: "Vade tarihinde gerçekleşir",
  COLLECTIONS_DELAYED_7D: "Senaryo: Tahsilatlar 7 gün gecikir",
  PAYMENTS_DELAYED_7D: "Senaryo: Ödemeler 7 gün gecikir",
};

function toInputDate(d: Date) {
  return d.toISOString().slice(0, 10);
}

export function CashFlowFilterBar({
  range,
  scenario,
  startDate,
  endDate,
  projects,
  selectedProjectId,
}: {
  range: CashFlowRange;
  scenario: CashFlowScenario;
  startDate?: Date;
  endDate?: Date;
  projects: { id: string; name: string }[];
  selectedProjectId: string | null;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [customStart, setCustomStart] = useState(startDate ? toInputDate(startDate) : "");
  const [customEnd, setCustomEnd] = useState(endDate ? toInputDate(endDate) : "");

  function updateParams(next: Record<string, string | undefined>) {
    const params = new URLSearchParams(searchParams.toString());
    for (const [key, value] of Object.entries(next)) {
      if (value) params.set(key, value);
      else params.delete(key);
    }
    router.push(`${pathname}?${params.toString()}`);
  }

  function applyCustomRange() {
    if (!customStart || !customEnd) return;
    updateParams({ range: "CUSTOM", startDate: customStart, endDate: customEnd });
  }

  return (
    <div className="flex flex-wrap items-center gap-2.5">
      <div className="flex h-9 flex-wrap items-center rounded-lg border border-border bg-card p-0.5">
        {CASH_FLOW_RANGES.map((key) => (
          <button
            key={key}
            type="button"
            onClick={() => updateParams({ range: key, startDate: undefined, endDate: undefined })}
            className={
              key === range
                ? "h-full rounded-md bg-primary px-3 text-[12.5px] font-semibold text-primary-foreground"
                : "h-full rounded-md px-3 text-[12.5px] font-medium text-muted-foreground transition-colors hover:text-foreground"
            }
          >
            {RANGE_LABELS[key]}
          </button>
        ))}
      </div>

      {range === "CUSTOM" && (
        <div className="flex items-center gap-1.5">
          <input
            type="date"
            value={customStart}
            onChange={(e) => setCustomStart(e.target.value)}
            className="h-9 rounded-lg border border-border bg-card px-2 text-[13px] text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
          <span className="text-muted-foreground">–</span>
          <input
            type="date"
            value={customEnd}
            onChange={(e) => setCustomEnd(e.target.value)}
            className="h-9 rounded-lg border border-border bg-card px-2 text-[13px] text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
          <button
            type="button"
            onClick={applyCustomRange}
            className="h-9 rounded-lg bg-primary px-3 text-[12.5px] font-semibold text-primary-foreground"
          >
            Uygula
          </button>
        </div>
      )}

      <select
        value={scenario}
        onChange={(e) => updateParams({ scenario: e.target.value })}
        className="h-9 rounded-lg border border-border bg-card px-2.5 text-[13px] text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {CASH_FLOW_SCENARIOS.map((key) => (
          <option key={key} value={key}>
            {SCENARIO_LABELS[key]}
          </option>
        ))}
      </select>

      {projects.length > 0 && (
        <select
          value={selectedProjectId ?? ""}
          onChange={(e) => updateParams({ projectId: e.target.value || undefined })}
          className="h-9 rounded-lg border border-border bg-card px-2.5 text-[13px] text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <option value="">Tüm projeler</option>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      )}
    </div>
  );
}
