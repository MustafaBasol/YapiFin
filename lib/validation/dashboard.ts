import { z } from "zod";

/**
 * Dashboard filtre modeli — YF-401. Kasıtlı olarak sınırlı: yalnızca bu ay,
 * bu yıl, son 12 ay ve rol güvenli proje filtresi desteklenir (bkz. görev
 * talimatları "Do not create a full report-builder interface"). Tarih
 * aralığı ve proje kimliği her zaman sunucuda doğrulanır; istemciden gelen
 * serbest metin kabul edilmez.
 */
export const DASHBOARD_PERIODS = ["CURRENT_MONTH", "CURRENT_YEAR", "LAST_12_MONTHS"] as const;
export type DashboardPeriod = (typeof DASHBOARD_PERIODS)[number];

const emptyToUndefined = (v: unknown) => (v === "" || v == null ? undefined : v);

export const dashboardFilterSchema = z.object({
  period: z.preprocess(emptyToUndefined, z.enum(DASHBOARD_PERIODS).optional()).default("LAST_12_MONTHS"),
  projectId: z.preprocess(emptyToUndefined, z.string().min(1).optional()),
});
export type DashboardFilterInput = z.infer<typeof dashboardFilterSchema>;

/** searchParams her zaman string|string[]|undefined olabilir; ilk değeri alıp güvenli şekilde ayrıştırır. */
export function parseDashboardFilter(searchParams: Record<string, string | string[] | undefined>): DashboardFilterInput {
  const pick = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
  const result = dashboardFilterSchema.safeParse({
    period: pick(searchParams.period),
    projectId: pick(searchParams.projectId),
  });
  if (result.success) return result.data;
  return { period: "LAST_12_MONTHS", projectId: undefined };
}
