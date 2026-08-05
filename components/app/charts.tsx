"use client";

import { useId } from "react";

/* ── Dual area chart: budget (faint) vs actual (solid) — bespoke inline SVG ─── */
export function BudgetActualChart({
  budget,
  actual,
  labels,
  height = 160,
}: {
  budget: number[];
  actual: number[];
  labels?: string[];
  height?: number;
}) {
  const id = useId().replace(/:/g, "");
  const w = 520;
  const h = height;
  const padX = 6;
  const padTop = 12;
  const padBottom = labels ? 22 : 8;
  const all = [...budget, ...actual];
  const max = Math.max(...all);
  const min = Math.min(...all) * 0.88;
  const span = max - min || 1;
  const step = (w - padX * 2) / (budget.length - 1);

  const toPts = (data: number[]) =>
    data.map((v, i) => {
      const x = padX + i * step;
      const y = padTop + (1 - (v - min) / span) * (h - padTop - padBottom);
      return [x, y] as const;
    });

  const aPts = toPts(actual);
  const bPts = toPts(budget);
  const path = (pts: readonly (readonly [number, number])[]) =>
    pts.map(([x, y], i) => `${i === 0 ? "M" : "L"}${x.toFixed(1)} ${y.toFixed(1)}`).join(" ");
  const baseY = h - padBottom;
  const aLine = path(aPts);
  const aArea = `${aLine} L${aPts[aPts.length - 1][0].toFixed(1)} ${baseY} L${aPts[0][0].toFixed(1)} ${baseY} Z`;

  return (
    <svg viewBox={`0 0 ${w} ${h}`} style={{ width: "100%", height }} preserveAspectRatio="none">
      <defs>
        <linearGradient id={`afill-${id}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="var(--color-primary)" stopOpacity="0.20" />
          <stop offset="100%" stopColor="var(--color-primary)" stopOpacity="0" />
        </linearGradient>
      </defs>
      {[0.25, 0.5, 0.75].map((g) => (
        <line key={g} x1={padX} x2={w - padX} y1={padTop + g * (h - padTop - padBottom)} y2={padTop + g * (h - padTop - padBottom)} stroke="var(--color-border)" strokeWidth="1" />
      ))}
      {/* budget — dashed muted reference line */}
      <path d={path(bPts)} fill="none" stroke="var(--color-muted-foreground)" strokeWidth="1.6" strokeDasharray="4 4" strokeLinecap="round" vectorEffect="non-scaling-stroke" opacity="0.7" />
      {/* actual — solid amber with fill */}
      <path d={aArea} fill={`url(#afill-${id})`} />
      <path d={aLine} fill="none" stroke="var(--color-primary)" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
      {aPts.map(([x, y], i) => (
        <circle key={i} cx={x} cy={y} r={i === aPts.length - 1 ? 3.2 : 2.2} fill="var(--color-card)" stroke="var(--color-primary)" strokeWidth="1.6" />
      ))}
      {labels &&
        labels.map((lab, i) => (
          <text key={lab} x={padX + i * step} y={h - 6} textAnchor="middle" fontSize="9.5" fill="var(--color-muted-foreground)" fontFamily="var(--font-mono)">
            {lab}
          </text>
        ))}
    </svg>
  );
}

/* ── Mini sparkline (drawer mini-cards) ────────────────────────────────────── */
export function MiniLineChart({
  data,
  color = "var(--color-primary)",
  height = 48,
  className,
}: {
  data: number[];
  color?: string;
  height?: number;
  className?: string;
}) {
  const id = useId().replace(/:/g, "");
  const w = 200;
  const h = height;
  const pad = 4;
  const max = Math.max(...data);
  const min = Math.min(...data);
  const span = max - min || 1;
  const step = (w - pad * 2) / (data.length - 1);
  const pts = data.map((v, i) => {
    const x = pad + i * step;
    const y = pad + (1 - (v - min) / span) * (h - pad * 2);
    return [x, y] as const;
  });
  const line = pts.map(([x, y], i) => `${i === 0 ? "M" : "L"}${x.toFixed(1)} ${y.toFixed(1)}`).join(" ");
  const area = `${line} L${pts[pts.length - 1][0].toFixed(1)} ${h - pad} L${pts[0][0].toFixed(1)} ${h - pad} Z`;

  return (
    <svg viewBox={`0 0 ${w} ${h}`} className={className} preserveAspectRatio="none" style={{ width: "100%", height }}>
      <defs>
        <linearGradient id={`fill-${id}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.22" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={area} fill={`url(#fill-${id})`} />
      <path d={line} fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
      <circle cx={pts[pts.length - 1][0]} cy={pts[pts.length - 1][1]} r="2.6" fill={color} />
    </svg>
  );
}

/* ── Budget bar: actual fill over budget track, turns red on overrun ───────── */
export function BudgetBar({
  budget,
  actual,
  className,
}: {
  budget: number;
  actual: number;
  className?: string;
}) {
  const ratio = budget > 0 ? actual / budget : 0;
  const over = actual > budget;
  const width = Math.min(ratio, 1) * 100;
  return (
    <div className={className}>
      <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
        <div
          className="h-full rounded-full transition-all"
          style={{
            width: `${width}%`,
            background: over ? "var(--color-destructive)" : "var(--color-primary)",
          }}
        />
      </div>
    </div>
  );
}

/* ── Multi-color segmented allocation bar (budget by trade) ─────────────────── */
export function SegmentedBar({
  segments,
  className,
}: {
  segments: { label: string; value: number; color: string }[];
  className?: string;
}) {
  const total = segments.reduce((s, x) => s + x.value, 0) || 1;
  return (
    <div className={className}>
      <div className="flex h-2.5 w-full overflow-hidden rounded-full bg-muted">
        {segments.map((s, i) => (
          <span
            key={s.label}
            title={`${s.label} · ${Math.round((s.value / total) * 100)}%`}
            style={{ width: `${(s.value / total) * 100}%`, background: s.color, marginLeft: i === 0 ? 0 : 1.5 }}
            className="h-full first:rounded-l-full last:rounded-r-full"
          />
        ))}
      </div>
      <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1.5">
        {segments.map((s) => (
          <span key={s.label} className="inline-flex items-center gap-1.5 text-[11.5px] text-muted-foreground">
            <span className="h-2 w-2 rounded-full" style={{ background: s.color }} />
            {s.label}
            <span className="tnum text-foreground/70">{Math.round((s.value / total) * 100)}%</span>
          </span>
        ))}
      </div>
    </div>
  );
}

/* ── Radial percent ring (project % complete) ──────────────────────────────── */
export function ProgressRing({
  pct,
  size = 44,
  stroke = 5,
  color = "var(--color-primary)",
}: {
  pct: number;
  size?: number;
  stroke?: number;
  color?: string;
}) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const offset = c * (1 - pct / 100);
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="shrink-0">
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--color-muted)" strokeWidth={stroke} />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        stroke={color}
        strokeWidth={stroke}
        strokeLinecap="round"
        strokeDasharray={c}
        strokeDashoffset={offset}
        transform={`rotate(-90 ${size / 2} ${size / 2})`}
      />
      <text x="50%" y="50%" textAnchor="middle" dominantBaseline="central" fontSize={size * 0.26} fontWeight="700" fill="var(--color-foreground)" fontFamily="var(--font-mono)">
        {pct}
      </text>
    </svg>
  );
}
