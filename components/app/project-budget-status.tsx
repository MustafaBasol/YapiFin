import { AlertTriangle } from "lucide-react";
import { cn } from "@/lib/utils";
import { BUDGET_STATUS_LABELS } from "@/server/services/budget-report-service";
import type { BudgetStatus } from "@/server/services/budget-report-service";

/**
 * Durum rozeti yalnızca sunum katmanıdır — eşik/oran hesabı yapmaz, servis
 * katmanından (`getBudgetStatus`, YF-404) gelen `status` değerini görüntüler.
 */
const STATUS_TONE: Record<BudgetStatus, string> = {
  NORMAL: "bg-success/12 text-success",
  CRITICAL: "bg-warning/15 text-warning-foreground",
  OVER_BUDGET: "bg-destructive/10 text-destructive",
  NO_BUDGET: "bg-muted text-muted-foreground",
};

export function ProjectBudgetStatusBadge({ status, className }: { status: BudgetStatus; className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[12px] font-semibold",
        STATUS_TONE[status],
        className,
      )}
    >
      {status === "OVER_BUDGET" && <AlertTriangle className="h-3.5 w-3.5" />}
      {BUDGET_STATUS_LABELS[status]}
    </span>
  );
}
