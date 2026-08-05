import { z } from "zod";

/**
 * Nakit akışı raporu filtre modeli — YF-403. Dashboard filtresiyle aynı
 * ilkeyi izler (bkz. lib/validation/dashboard.ts): kasıtlı olarak sınırlı,
 * sabit bir seçenek listesi + doğrulanmış özel aralık. Tarih aralığı ve
 * proje kimliği her zaman sunucuda (server/services/cash-flow-report-service.ts)
 * yeniden doğrulanır; istemciden gelen serbest metin tek başına güvenilmez.
 */
export const CASH_FLOW_RANGES = ["CURRENT_MONTH", "NEXT_30_DAYS", "NEXT_90_DAYS", "CURRENT_YEAR", "CUSTOM"] as const;
export type CashFlowRange = (typeof CASH_FLOW_RANGES)[number];

/** Özel tarih aralığı için üst sınır — sınırsız geçmiş/gelecek taramasını engeller. */
export const CASH_FLOW_MAX_CUSTOM_RANGE_DAYS = 366;

/**
 * Sunum amaçlı, deterministik senaryolar (YF-403 "Scenario support"). Hiçbir
 * senaryo işlem/vade tarihini değiştirmez; yalnızca projeksiyon hesabında
 * karşılaştırma tarihini kaydırır.
 */
export const CASH_FLOW_SCENARIOS = ["ON_DUE_DATE", "COLLECTIONS_DELAYED_7D", "PAYMENTS_DELAYED_7D"] as const;
export type CashFlowScenario = (typeof CASH_FLOW_SCENARIOS)[number];

const emptyToUndefined = (v: unknown) => (v === "" || v == null ? undefined : v);

export const cashFlowFilterSchema = z
  .object({
    range: z.preprocess(emptyToUndefined, z.enum(CASH_FLOW_RANGES).optional()).default("NEXT_30_DAYS"),
    startDate: z.preprocess(emptyToUndefined, z.coerce.date().optional()),
    endDate: z.preprocess(emptyToUndefined, z.coerce.date().optional()),
    projectId: z.preprocess(emptyToUndefined, z.string().min(1).optional()),
    scenario: z.preprocess(emptyToUndefined, z.enum(CASH_FLOW_SCENARIOS).optional()).default("ON_DUE_DATE"),
  })
  .superRefine((val, ctx) => {
    if (val.range !== "CUSTOM") return;
    if (!val.startDate || !val.endDate) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["startDate"],
        message: "Özel tarih aralığı için başlangıç ve bitiş tarihi zorunludur",
      });
      return;
    }
    if (val.endDate <= val.startDate) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["endDate"],
        message: "Bitiş tarihi başlangıç tarihinden sonra olmalıdır",
      });
      return;
    }
    const spanDays = (val.endDate.getTime() - val.startDate.getTime()) / (24 * 60 * 60 * 1000);
    if (spanDays > CASH_FLOW_MAX_CUSTOM_RANGE_DAYS) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["endDate"],
        message: `Özel tarih aralığı en fazla ${CASH_FLOW_MAX_CUSTOM_RANGE_DAYS} gün olabilir`,
      });
    }
  });
export type CashFlowFilterInput = z.infer<typeof cashFlowFilterSchema>;

/** searchParams her zaman string|string[]|undefined olabilir; ilk değeri alıp güvenli şekilde ayrıştırır. */
export function parseCashFlowFilter(
  searchParams: Record<string, string | string[] | undefined>,
): { success: true; data: CashFlowFilterInput } | { success: false; error: string } {
  const pick = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
  const result = cashFlowFilterSchema.safeParse({
    range: pick(searchParams.range),
    startDate: pick(searchParams.startDate),
    endDate: pick(searchParams.endDate),
    projectId: pick(searchParams.projectId),
    scenario: pick(searchParams.scenario),
  });
  if (result.success) return { success: true, data: result.data };
  return { success: false, error: result.error.issues[0]?.message ?? "Geçersiz filtre" };
}

/**
 * Bütçe raporu filtre modeli — YF-404. `categoryId` verilirse aylık kategori
 * trendi tek kategoriye odaklanır; verilmezse en yüksek harcamalı ilk N
 * kategori gösterilir (bkz. BUDGET_TREND_TOP_N, budget-report-service.ts).
 */
const budgetFilterSchemaBase = z.object({
  projectId: z.preprocess(emptyToUndefined, z.string().min(1).optional()),
  categoryId: z.preprocess(emptyToUndefined, z.string().min(1).optional()),
});
export const budgetFilterSchema = budgetFilterSchemaBase;
export type BudgetFilterInput = z.infer<typeof budgetFilterSchema>;

export function parseBudgetFilter(
  searchParams: Record<string, string | string[] | undefined>,
): BudgetFilterInput {
  const pick = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
  const result = budgetFilterSchema.safeParse({
    projectId: pick(searchParams.projectId),
    categoryId: pick(searchParams.categoryId),
  });
  if (result.success) return result.data;
  return { projectId: undefined, categoryId: undefined };
}
