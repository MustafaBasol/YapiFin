"use client";

import { Line, LineChart, CartesianGrid, XAxis, YAxis, Tooltip, Legend, ResponsiveContainer } from "recharts";
import { formatMoney } from "@/lib/utils";
import type { CategoryMonthlyTrendSeries } from "@/server/services/budget-report-service";

const SERIES_COLORS = ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4"];
const GRID_COLOR = "#e1e0d9";
const AXIS_COLOR = "#898781";

function tickFormatter(value: number) {
  if (Math.abs(value) >= 1_000_000) return `${(value / 1_000_000).toFixed(1)} Mn`;
  if (Math.abs(value) >= 1_000) return `${(value / 1_000).toFixed(0)} B`;
  return String(value);
}

function MoneyTooltip({
  active,
  payload,
  label,
}: {
  active?: boolean;
  payload?: { name: string; value: number; color: string }[];
  label?: string;
}) {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-lg border border-border bg-card px-3 py-2 text-[12px] shadow-pop">
      {label && <p className="mb-1 font-semibold">{label}</p>}
      {payload.map((p) => (
        <p key={p.name} className="flex items-center gap-1.5">
          <span className="inline-block h-2 w-2 rounded-full" style={{ backgroundColor: p.color }} />
          <span className="text-muted-foreground">{p.name}:</span>
          <span className="font-medium tabular-nums">{formatMoney(p.value)}</span>
        </p>
      ))}
    </div>
  );
}

export function BudgetCategoryTrendChart({ series }: { series: CategoryMonthlyTrendSeries[] }) {
  if (series.length === 0) {
    return <p className="py-10 text-center text-[13px] text-muted-foreground">Seçilen aralıkta gider kaydı yok.</p>;
  }

  const months = series[0].points.map((p) => ({ key: p.key, label: p.label }));
  const chartData = months.map((m, i) => {
    const row: Record<string, string | number> = { label: m.label };
    for (const s of series) row[s.name] = s.points[i]?.amount ?? 0;
    return row;
  });

  return (
    <div className="h-[280px] w-full">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={chartData} margin={{ top: 4, right: 8, left: -12, bottom: 0 }}>
          <CartesianGrid stroke={GRID_COLOR} vertical={false} />
          <XAxis dataKey="label" tick={{ fontSize: 11, fill: AXIS_COLOR }} axisLine={{ stroke: GRID_COLOR }} tickLine={false} />
          <YAxis tick={{ fontSize: 11, fill: AXIS_COLOR }} tickFormatter={tickFormatter} axisLine={false} tickLine={false} width={44} />
          <Tooltip content={<MoneyTooltip />} />
          <Legend wrapperStyle={{ fontSize: 12 }} formatter={(v) => <span className="text-muted-foreground">{v}</span>} />
          {series.map((s, i) => (
            <Line
              key={s.categoryId}
              type="monotone"
              dataKey={s.name}
              name={s.name}
              stroke={SERIES_COLORS[i % SERIES_COLORS.length]}
              strokeWidth={2}
              dot={false}
            />
          ))}
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
