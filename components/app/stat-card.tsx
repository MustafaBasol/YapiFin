import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

type Tone = "neutral" | "success" | "warning" | "destructive";

const valueTone: Record<Tone, string> = {
  neutral: "",
  success: "text-success",
  warning: "text-warning-foreground",
  destructive: "text-destructive",
};

export function StatCard({
  icon: Icon,
  label,
  value,
  hint,
  tone = "neutral",
}: {
  icon: LucideIcon;
  label: string;
  value: string;
  hint?: string;
  tone?: Tone;
}) {
  return (
    <div className="rounded-2xl border border-border bg-card p-5 shadow-soft">
      <div className="flex items-center justify-between">
        <p className="text-[12.5px] font-medium text-muted-foreground">{label}</p>
        <span className="grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary">
          <Icon className="h-4 w-4" />
        </span>
      </div>
      <p className={cn("mt-2.5 tnum text-[26px] font-bold leading-none", valueTone[tone])}>{value}</p>
      {hint && <p className="mt-1.5 text-[11px] text-muted-foreground">{hint}</p>}
    </div>
  );
}
