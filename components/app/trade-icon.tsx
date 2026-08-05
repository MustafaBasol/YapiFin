import { cn } from "@/lib/utils";
import { TRADE_META, type Trade } from "@/lib/demo/data";

/* A small rounded tile with a discipline glyph, colored per trade. All inline
   SVG — no external icon set, no photos. */
const GLYPHS: Record<Trade, React.ReactNode> = {
  // concrete — a cube / slab
  concrete: <path d="M4 8 L12 4 L20 8 L12 12 Z M4 8 V16 L12 20 V12 M20 8 V16 L12 20" />,
  // frame — a corner bracket / stud
  frame: <path d="M5 4 V20 H19 M5 9 H13 V20 M13 9 V14 H19" />,
  // plumb — a pipe elbow
  plumb: <path d="M5 5 V12 a5 5 0 0 0 5 5 H19 M5 5 H9 M15 17 V21" />,
  // elec — a bolt
  elec: <path d="M13 3 L5 13 H11 L9 21 L19 10 H13 Z" />,
  // hvac — a fan
  hvac: <path d="M12 12 m-2 0 a2 2 0 1 0 4 0 a2 2 0 1 0 -4 0 M12 10 V4 M12 14 V20 M10 12 H4 M14 12 H20" />,
  // finish — a paint roller
  finish: <path d="M4 5 H16 V10 H4 Z M16 7 H20 V11 H13 V14 M11 14 H15 V21 H11 Z" />,
};

export function TradeIcon({
  trade,
  size = 28,
  className,
}: {
  trade: Trade;
  size?: number;
  className?: string;
}) {
  const color = TRADE_META[trade].color;
  const inner = size * 0.62;
  return (
    <span
      className={cn("inline-grid shrink-0 place-items-center rounded-lg", className)}
      style={{ width: size, height: size, background: `color-mix(in oklch, ${color} 14%, white)` }}
    >
      <svg
        width={inner}
        height={inner}
        viewBox="0 0 24 24"
        fill="none"
        stroke={color}
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden
      >
        {GLYPHS[trade]}
      </svg>
    </span>
  );
}

/* A flat pill: glyph dot + trade name, for legends. */
export function TradePill({ trade, label }: { trade: Trade; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-[12px] font-medium text-foreground/80">
      <span className="h-2 w-2 rounded-full" style={{ background: TRADE_META[trade].color }} />
      {label}
    </span>
  );
}
