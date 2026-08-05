"use client";

import { useRouter, useSearchParams, usePathname } from "next/navigation";
import type { DashboardPeriod } from "@/lib/validation/dashboard";

const PERIOD_LABELS: Record<DashboardPeriod, string> = {
  CURRENT_MONTH: "Bu ay",
  CURRENT_YEAR: "Bu yıl",
  LAST_12_MONTHS: "Son 12 ay",
};

export function DashboardFilterBar({
  period,
  projects,
  selectedProjectId,
}: {
  period: DashboardPeriod;
  projects: { id: string; name: string }[];
  selectedProjectId: string | null;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  function updateParam(key: string, value: string) {
    const params = new URLSearchParams(searchParams.toString());
    if (value) params.set(key, value);
    else params.delete(key);
    router.push(`${pathname}?${params.toString()}`);
  }

  return (
    <div className="flex flex-wrap items-center gap-2.5">
      <div className="flex h-9 items-center rounded-lg border border-border bg-card p-0.5">
        {(Object.keys(PERIOD_LABELS) as DashboardPeriod[]).map((key) => (
          <button
            key={key}
            type="button"
            onClick={() => updateParam("period", key)}
            className={
              key === period
                ? "h-full rounded-md bg-primary px-3 text-[12.5px] font-semibold text-primary-foreground"
                : "h-full rounded-md px-3 text-[12.5px] font-medium text-muted-foreground transition-colors hover:text-foreground"
            }
          >
            {PERIOD_LABELS[key]}
          </button>
        ))}
      </div>

      {projects.length > 0 && (
        <select
          value={selectedProjectId ?? ""}
          onChange={(e) => updateParam("projectId", e.target.value)}
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
