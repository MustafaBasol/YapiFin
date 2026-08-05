export function ChartCard({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-2xl border border-border bg-card p-5 shadow-soft">
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="font-display text-[15px] font-semibold tracking-tight">{title}</h2>
        {subtitle && <span className="text-[11.5px] text-muted-foreground">{subtitle}</span>}
      </div>
      {children}
    </div>
  );
}
