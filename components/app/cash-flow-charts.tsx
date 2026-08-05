"use client";

import { Bar, ComposedChart, Line, CartesianGrid, XAxis, YAxis, Tooltip, Legend, ResponsiveContainer } from "recharts";
import { formatMoney } from "@/lib/utils";
import type { CashFlowMonthlyPoint } from "@/server/services/cash-flow-report-service";

const IN_COLOR = "#2a78d6";
const OUT_COLOR = "#eb6834";
const BALANCE_COLOR = "#1baf7a";
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

/**
 * Aylık planlanan nakit akışı projeksiyonu. `showRunningBalance` yalnızca
 * organizasyon geneli raporda `true`'dur (PROJECT_MANAGER'da açılış bakiyesi
 * kavramı olmadığından bu seri hiç hesaplanmaz — bkz. cash-flow-report-service.ts).
 */
export function CashFlowProjectionChart({
  data,
  showRunningBalance,
}: {
  data: CashFlowMonthlyPoint[];
  showRunningBalance: boolean;
}) {
  if (data.length === 0) {
    return <p className="py-10 text-center text-[13px] text-muted-foreground">Seçilen dönemde planlanan nakit hareketi yok.</p>;
  }
  const hasData = data.some((d) => d.scheduledIn !== 0 || d.scheduledOut !== 0);

  return (
    <div>
      <div className="h-[280px] w-full">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={data} margin={{ top: 4, right: 8, left: -12, bottom: 0 }}>
            <CartesianGrid stroke={GRID_COLOR} vertical={false} />
            <XAxis dataKey="label" tick={{ fontSize: 11, fill: AXIS_COLOR }} axisLine={{ stroke: GRID_COLOR }} tickLine={false} />
            <YAxis tick={{ fontSize: 11, fill: AXIS_COLOR }} tickFormatter={tickFormatter} axisLine={false} tickLine={false} width={44} />
            <Tooltip content={<MoneyTooltip />} cursor={{ fill: "rgba(0,0,0,0.03)" }} />
            <Legend wrapperStyle={{ fontSize: 12 }} formatter={(v) => <span className="text-muted-foreground">{v}</span>} />
            <Bar dataKey="scheduledIn" name="Planlanan Tahsilatlar" fill={IN_COLOR} radius={[3, 3, 0, 0]} maxBarSize={22} />
            <Bar dataKey="scheduledOut" name="Planlanan Ödemeler" fill={OUT_COLOR} radius={[3, 3, 0, 0]} maxBarSize={22} />
            {showRunningBalance && (
              <Line
                type="monotone"
                dataKey="runningProjectedBalance"
                name="Tahmini Kapanış Bakiyesi"
                stroke={BALANCE_COLOR}
                strokeWidth={2}
                dot={false}
              />
            )}
          </ComposedChart>
        </ResponsiveContainer>
      </div>
      {!hasData && <p className="mt-1 text-center text-[12px] text-muted-foreground">Seçilen dönemde planlanan nakit hareketi yok.</p>}
      <p className="mt-2 text-[11px] text-muted-foreground">
        Bu grafik bir tahmindir; planlanan tahsilat ve ödemeler gerçekleşene kadar garanti nakit değildir.
      </p>
    </div>
  );
}
