import { CalendarClock } from "lucide-react";
import { formatDate, formatMoney } from "@/lib/utils";
import type { UpcomingItem } from "@/server/services/dashboard-service";

export function DashboardUpcomingList({ items, emptyLabel }: { items: UpcomingItem[]; emptyLabel: string }) {
  if (items.length === 0) {
    return (
      <div className="grid place-items-center py-10 text-center">
        <CalendarClock className="h-6 w-6 text-muted-foreground/50" />
        <p className="mt-2.5 text-[13px] text-muted-foreground">{emptyLabel}</p>
      </div>
    );
  }

  return (
    <ul className="divide-y divide-border/60">
      {items.map((item) => (
        <li key={item.id} className="flex items-center gap-3 py-2.5">
          <div className="min-w-0 flex-1">
            <p className="truncate text-[13px] font-medium leading-tight">{item.description}</p>
            <p className="truncate text-[11.5px] text-muted-foreground">
              {[item.counterpartName, item.projectName].filter(Boolean).join(" · ") || "—"}
            </p>
          </div>
          <div className="shrink-0 text-right">
            <p className="tnum text-[13px] font-semibold">{formatMoney(item.remainingAmount, item.currency)}</p>
            <p className="text-[11px] text-muted-foreground">{formatDate(item.dueDate)}</p>
          </div>
        </li>
      ))}
    </ul>
  );
}
