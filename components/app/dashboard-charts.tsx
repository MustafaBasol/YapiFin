"use client";

import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { formatMoney } from "@/lib/utils";

/**
 * Grafik renkleri — dataviz skill doğrulayıcısından (validate_palette.js)
 * geçmiş, belgelenmiş varsayılan kategorik palet (slot 1 mavi / slot 2
 * turuncu) ve mavi↔kırmızı diverging çift kullanılır. Uygulamanın tek açık
 * temalı yüzeyinde (app/globals.css, koyu tema yok) doğrulanmıştır.
 */
const COLLECTED_COLOR = "#2a78d6";
const PAID_COLOR = "#eb6834";
const POSITIVE_COLOR = "#2a78d6";
const NEGATIVE_COLOR = "#e34948";
const CATEGORY_COLORS = ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300"];
const OTHER_COLOR = "#9a9890";

const GRID_COLOR = "#e1e0d9";
const AXIS_COLOR = "#898781";

function tickFormatter(value: number) {
  if (Math.abs(value) >= 1_000_000) return `${(value / 1_000_000).toFixed(1)} Mn`;
  if (Math.abs(value) >= 1_000) return `${(value / 1_000).toFixed(0)} B`;
  return String(value);
}

function MoneyTooltip({ active, payload, label }: { active?: boolean; payload?: { name: string; value: number; color: string }[]; label?: string }) {
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

export function MonthlyCashFlowChart({
  data,
}: {
  data: { key: string; label: string; collected: number; paid: number }[];
}) {
  const hasData = data.some((d) => d.collected !== 0 || d.paid !== 0);
  return (
    <div>
      <div className="h-[260px] w-full">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data} margin={{ top: 4, right: 8, left: -12, bottom: 0 }} barGap={3}>
            <CartesianGrid stroke={GRID_COLOR} vertical={false} />
            <XAxis dataKey="label" tick={{ fontSize: 11, fill: AXIS_COLOR }} axisLine={{ stroke: GRID_COLOR }} tickLine={false} />
            <YAxis tick={{ fontSize: 11, fill: AXIS_COLOR }} tickFormatter={tickFormatter} axisLine={false} tickLine={false} width={44} />
            <Tooltip content={<MoneyTooltip />} cursor={{ fill: "rgba(0,0,0,0.03)" }} />
            <Legend wrapperStyle={{ fontSize: 12 }} formatter={(v) => <span className="text-muted-foreground">{v}</span>} />
            <Bar dataKey="collected" name="Tahsilat" fill={COLLECTED_COLOR} radius={[3, 3, 0, 0]} maxBarSize={22} />
            <Bar dataKey="paid" name="Ödeme" fill={PAID_COLOR} radius={[3, 3, 0, 0]} maxBarSize={22} />
          </BarChart>
        </ResponsiveContainer>
      </div>
      {!hasData && (
        <p className="mt-1 text-center text-[12px] text-muted-foreground">Seçilen dönemde tahsilat veya ödeme kaydı yok.</p>
      )}
      <TableDisclosure
        headers={["Ay", "Tahsilat", "Ödeme"]}
        rows={data.map((d) => [d.label, formatMoney(d.collected), formatMoney(d.paid)])}
      />
    </div>
  );
}

export function AccrualTrendChart({
  data,
}: {
  data: { key: string; label: string; income: number; expense: number }[];
}) {
  const hasData = data.some((d) => d.income !== 0 || d.expense !== 0);
  return (
    <div>
      <div className="h-[260px] w-full">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data} margin={{ top: 4, right: 8, left: -12, bottom: 0 }} barGap={3}>
            <CartesianGrid stroke={GRID_COLOR} vertical={false} />
            <XAxis dataKey="label" tick={{ fontSize: 11, fill: AXIS_COLOR }} axisLine={{ stroke: GRID_COLOR }} tickLine={false} />
            <YAxis tick={{ fontSize: 11, fill: AXIS_COLOR }} tickFormatter={tickFormatter} axisLine={false} tickLine={false} width={44} />
            <Tooltip content={<MoneyTooltip />} cursor={{ fill: "rgba(0,0,0,0.03)" }} />
            <Legend wrapperStyle={{ fontSize: 12 }} formatter={(v) => <span className="text-muted-foreground">{v}</span>} />
            <Bar dataKey="income" name="Gelir" fill={COLLECTED_COLOR} radius={[3, 3, 0, 0]} maxBarSize={22} />
            <Bar dataKey="expense" name="Gider" fill={PAID_COLOR} radius={[3, 3, 0, 0]} maxBarSize={22} />
          </BarChart>
        </ResponsiveContainer>
      </div>
      {!hasData && <p className="mt-1 text-center text-[12px] text-muted-foreground">Seçilen dönemde gelir/gider kaydı yok.</p>}
      <TableDisclosure
        headers={["Ay", "Gelir", "Gider"]}
        rows={data.map((d) => [d.label, formatMoney(d.income), formatMoney(d.expense)])}
      />
    </div>
  );
}

export function NetCashFlowChart({ data }: { data: { key: string; label: string; net: number }[] }) {
  const hasData = data.some((d) => d.net !== 0);
  return (
    <div>
      <div className="h-[220px] w-full">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data} margin={{ top: 4, right: 8, left: -12, bottom: 0 }}>
            <CartesianGrid stroke={GRID_COLOR} vertical={false} />
            <XAxis dataKey="label" tick={{ fontSize: 11, fill: AXIS_COLOR }} axisLine={{ stroke: GRID_COLOR }} tickLine={false} />
            <YAxis tick={{ fontSize: 11, fill: AXIS_COLOR }} tickFormatter={tickFormatter} axisLine={false} tickLine={false} width={44} />
            <Tooltip content={<MoneyTooltip />} cursor={{ fill: "rgba(0,0,0,0.03)" }} />
            <Bar dataKey="net" name="Net nakit akışı" radius={[3, 3, 3, 3]} maxBarSize={26}>
              {data.map((d) => (
                <Cell key={d.key} fill={d.net >= 0 ? POSITIVE_COLOR : NEGATIVE_COLOR} />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>
      {!hasData && <p className="mt-1 text-center text-[12px] text-muted-foreground">Seçilen dönemde nakit hareketi yok.</p>}
      <TableDisclosure headers={["Ay", "Net nakit akışı"]} rows={data.map((d) => [d.label, formatMoney(d.net)])} />
    </div>
  );
}

export function CategoryDistributionChart({ data }: { data: { categoryId: string; name: string; amount: string }[] }) {
  if (data.length === 0) {
    return <p className="py-10 text-center text-[13px] text-muted-foreground">Seçilen dönemde gider kaydı yok.</p>;
  }

  const TOP_N = 6;
  const sorted = [...data].sort((a, b) => Number(b.amount) - Number(a.amount));
  const top = sorted.slice(0, TOP_N);
  const rest = sorted.slice(TOP_N);
  const otherAmount = rest.reduce((sum, r) => sum + Number(r.amount), 0);
  const chartRows = [
    ...top.map((r, i) => ({ name: r.name, amount: Number(r.amount), color: CATEGORY_COLORS[i] })),
    ...(otherAmount > 0 ? [{ name: "Diğer", amount: otherAmount, color: OTHER_COLOR }] : []),
  ];
  const maxAmount = Math.max(...chartRows.map((r) => r.amount), 1);

  return (
    <div className="space-y-2.5">
      {chartRows.map((row) => (
        <div key={row.name} className="flex items-center gap-2.5">
          <span className="w-28 shrink-0 truncate text-[12.5px] text-muted-foreground" title={row.name}>
            {row.name}
          </span>
          <div className="h-5 flex-1 overflow-hidden rounded-md bg-muted">
            <div
              className="h-full rounded-md"
              style={{ width: `${Math.max((row.amount / maxAmount) * 100, 2)}%`, backgroundColor: row.color }}
            />
          </div>
          <span className="w-24 shrink-0 text-right text-[12.5px] font-semibold tabular-nums">{formatMoney(row.amount)}</span>
        </div>
      ))}
      <TableDisclosure headers={["Kategori", "Tutar"]} rows={chartRows.map((r) => [r.name, formatMoney(r.amount)])} />
    </div>
  );
}

export function ProjectComparisonChart({
  data,
}: {
  data: { projectId: string; name: string; code: string; result: string }[];
}) {
  if (data.length === 0) {
    return <p className="py-10 text-center text-[13px] text-muted-foreground">Karşılaştırılacak proje geliri/gideri yok.</p>;
  }
  const rows = data.map((d) => ({ ...d, resultNum: Number(d.result) }));
  const maxAbs = Math.max(...rows.map((r) => Math.abs(r.resultNum)), 1);

  return (
    <div className="space-y-2.5">
      {rows.map((row) => (
        <div key={row.projectId} className="flex items-center gap-2.5">
          <span className="w-32 shrink-0 truncate text-[12.5px] text-muted-foreground" title={row.name}>
            {row.name}
          </span>
          <div className="relative h-5 flex-1 overflow-hidden rounded-md bg-muted">
            <div
              className="absolute top-0 h-full rounded-md"
              style={{
                width: `${Math.max((Math.abs(row.resultNum) / maxAbs) * 100, 2)}%`,
                backgroundColor: row.resultNum >= 0 ? POSITIVE_COLOR : NEGATIVE_COLOR,
                left: row.resultNum >= 0 ? "0" : undefined,
                right: row.resultNum < 0 ? "0" : undefined,
              }}
            />
          </div>
          <span className="w-24 shrink-0 text-right text-[12.5px] font-semibold tabular-nums">{formatMoney(row.resultNum)}</span>
        </div>
      ))}
      <TableDisclosure headers={["Proje", "Tahakkuk sonucu"]} rows={rows.map((r) => [`${r.name} (${r.code})`, formatMoney(r.resultNum)])} />
    </div>
  );
}

function TableDisclosure({ headers, rows }: { headers: string[]; rows: string[][] }) {
  if (rows.length === 0) return null;
  return (
    <details className="mt-2 text-[12px]">
      <summary className="cursor-pointer text-muted-foreground hover:text-foreground">Tablo görünümü</summary>
      <div className="mt-2 overflow-x-auto rounded-lg border border-border">
        <table className="w-full text-left">
          <thead>
            <tr className="border-b border-border bg-muted/50">
              {headers.map((h) => (
                <th key={h} className="px-3 py-1.5 font-medium text-muted-foreground">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => (
              <tr key={i} className="border-b border-border/60 last:border-0">
                {row.map((cell, j) => (
                  <td key={j} className="px-3 py-1.5 tabular-nums">
                    {cell}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}
