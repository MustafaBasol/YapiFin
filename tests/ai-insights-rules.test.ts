import { describe, expect, it } from "vitest";
import { runInsightRules, type InsightRuleContext } from "@/server/services/ai-insights-rules";
import { DEFAULT_INSIGHT_THRESHOLDS, type InsightThresholds } from "@/lib/ai/insights/thresholds";
import type {
  BudgetReport,
  CategoryAnalysisRow,
  OverBudgetProjectRow,
  ProjectBudgetRow,
} from "@/server/services/budget-report-service";
import type { MaturityBuckets, OrganizationCashFlowReport, ProjectCashFlowRow } from "@/server/services/cash-flow-report-service";

/**
 * YF-702 — Kural motorunun EŞİK davranışının saf (DB'siz) birim testleri.
 *
 * Neden DB'siz: bir eşiğin tam sınırını (ör. "%40'ta uyarı VAR, %39,99'da
 * YOK") gerçek işlem/tahsilat kaydı kurgulayarak test etmek hem kırılgan hem
 * de yavaştır — ara katmanların yuvarlaması istenen sınır değerini üretmeyi
 * neredeyse imkânsız kılar. Kural motoru kanonik rapor ÇIKTISINI girdi olarak
 * aldığından (bkz. server/services/ai-insights-rules.ts modül başlığı), o
 * çıktıyı doğrudan kurgulamak eşiği KESİN olarak sınayan tek yoldur.
 *
 * Uçtan uca davranış (gerçek Prisma verisi → rapor servisi → sinyal) ayrıca
 * tests/ai-insights.test.ts içinde gerçek bir veritabanına karşı doğrulanır;
 * bu dosya onun yerine GEÇMEZ, eşik sınırlarını tamamlar.
 */

const ZERO_BUCKETS: MaturityBuckets = {
  overdue: "0",
  dueToday: "0",
  next7Days: "0",
  next30Days: "0",
  days31to60: "0",
  days61to90: "0",
  over90Days: "0",
  noDueDate: "0",
};

const RANGE_START = new Date("2026-08-01T00:00:00.000Z");
const RANGE_END = new Date("2026-08-31T23:59:59.999Z");

function budgetReport(overrides: Partial<BudgetReport> = {}): BudgetReport {
  return {
    scope: "ORGANIZATION",
    filter: {} as never,
    projectFilter: null,
    metrics: {
      totalProjectBudget: "0",
      totalRealizedExpenses: "0",
      totalPaidExpenses: "0",
      totalRemainingBudget: "0",
      budgetUsagePercentage: null,
      projectsOverBudgetCount: 0,
      projectsAtRiskCount: 0,
      projectsWithoutBudgetCount: 0,
      averageBudgetUtilization: null,
    },
    projectComparison: [],
    categoryAnalysis: [],
    categoryMonthlyTrend: [],
    projectCategoryMatrix: [],
    projectCategoryMatrixTruncated: false,
    overBudgetProjects: [],
    atRiskProjects: [],
    projectsWithoutBudget: [],
    projectsWithoutBudgetTruncated: false,
    ...overrides,
  } as BudgetReport;
}

function cashFlowReport(overrides: Partial<OrganizationCashFlowReport> = {}): OrganizationCashFlowReport {
  return {
    scope: "ORGANIZATION",
    filter: {} as never,
    rangeStart: RANGE_START,
    rangeEnd: RANGE_END,
    projectFilter: null,
    openingBalance: "0",
    projectedClosingBalance: "0",
    projectedClosingBalanceIsEstimate: true,
    summary: {
      realizedCollections: "0",
      realizedPayments: "0",
      realizedNet: "0",
      scheduledCollections: "0",
      scheduledPayments: "0",
      scheduledNet: "0",
    },
    receivableBuckets: ZERO_BUCKETS,
    payableBuckets: ZERO_BUCKETS,
    monthlyProjection: [],
    receivables: { rows: [], totalOpenCount: 0, truncated: false },
    payables: { rows: [], totalOpenCount: 0, truncated: false },
    receivablesNoDueDate: { rows: [], totalOpenCount: 0, truncated: false },
    payablesNoDueDate: { rows: [], totalOpenCount: 0, truncated: false },
    projectComparison: [],
    projectComparisonTruncated: false,
    ...overrides,
  };
}

function ctx(overrides: Partial<InsightRuleContext> = {}): InsightRuleContext {
  return {
    budget: budgetReport(),
    cashFlow: cashFlowReport(),
    thresholds: DEFAULT_INSIGHT_THRESHOLDS,
    ...overrides,
  };
}

function category(overrides: Partial<CategoryAnalysisRow> = {}): CategoryAnalysisRow {
  return {
    categoryId: "cat-1",
    name: "Malzeme",
    recordedExpense: "0",
    paidExpense: "0",
    shareOfTotal: "0",
    projectCount: 1,
    transactionCount: 1,
    ...overrides,
  };
}

function projectCashRow(overrides: Partial<ProjectCashFlowRow> = {}): ProjectCashFlowRow {
  return {
    projectId: "p-1",
    name: "Proje 1",
    code: "P1",
    scheduledInflow: "0",
    scheduledOutflow: "0",
    projectedNet: "0",
    overdueReceivable: "0",
    overduePayable: "0",
    ...overrides,
  };
}

function projectBudgetRow(overrides: Partial<ProjectBudgetRow> = {}): ProjectBudgetRow {
  return {
    projectId: "p-1",
    name: "Proje 1",
    code: "P1",
    estimatedBudget: "1000",
    realizedExpenses: "1500",
    paidExpenses: "0",
    remainingBudget: "-500",
    usagePercentage: "150",
    status: "OVER_BUDGET",
    ...overrides,
  };
}

function overBudgetRow(overrides: Partial<OverBudgetProjectRow> = {}): OverBudgetProjectRow {
  return {
    ...projectBudgetRow(),
    overrunAmount: "500",
    overrunPercentage: "50",
    topCategories: [],
    ...overrides,
  };
}

describe("YF-702 kural motoru — gider yoğunlaşması eşiği", () => {
  it("pay tam eşikteyken (%40) sinyal üretilir", () => {
    const signals = runInsightRules(
      ctx({
        budget: budgetReport({
          metrics: { ...budgetReport().metrics, totalRealizedExpenses: "10000" },
          categoryAnalysis: [
            category({ categoryId: "a", recordedExpense: "4000", shareOfTotal: "40" }),
            category({ categoryId: "b", recordedExpense: "6000", shareOfTotal: "60" }),
          ],
        }),
      }),
    );
    const signal = signals.find((s) => s.type === "EXPENSE_CONCENTRATION");
    expect(signal).toBeDefined();
    expect(signal!.severity).toBe("MEDIUM");
  });

  it("pay eşiğin hemen ALTINDAYKEN (%39,99) sinyal ÜRETİLMEZ", () => {
    const signals = runInsightRules(
      ctx({
        budget: budgetReport({
          categoryAnalysis: [
            category({ categoryId: "a", recordedExpense: "3999", shareOfTotal: "39.99" }),
            category({ categoryId: "b", recordedExpense: "6001", shareOfTotal: "60.01" }),
          ],
        }),
      }),
    );
    expect(signals.filter((s) => s.type === "EXPENSE_CONCENTRATION")).toHaveLength(0);
  });

  it("pay HIGH eşiğine ulaşınca (%60) önem derecesi yükselir", () => {
    const signals = runInsightRules(
      ctx({
        budget: budgetReport({
          categoryAnalysis: [
            category({ categoryId: "a", recordedExpense: "6000", shareOfTotal: "60" }),
            category({ categoryId: "b", recordedExpense: "4000", shareOfTotal: "40" }),
          ],
        }),
      }),
    );
    expect(signals.find((s) => s.type === "EXPENSE_CONCENTRATION")!.severity).toBe("HIGH");
  });

  it("yetersiz veri: tek kategorili organizasyonda %100 pay bile sinyal ÜRETMEZ", () => {
    const signals = runInsightRules(
      ctx({
        budget: budgetReport({
          categoryAnalysis: [category({ categoryId: "a", recordedExpense: "10000", shareOfTotal: "100" })],
        }),
      }),
    );
    expect(signals.filter((s) => s.type === "EXPENSE_CONCENTRATION")).toHaveLength(0);
  });

  it("eşikler enjekte edilebilir: eşik %70'e çekilince %60'lık pay artık sinyal üretmez", () => {
    const strict: InsightThresholds = { ...DEFAULT_INSIGHT_THRESHOLDS, expenseConcentrationMinSharePercent: "70" };
    const budget = budgetReport({
      categoryAnalysis: [
        category({ categoryId: "a", recordedExpense: "6000", shareOfTotal: "60" }),
        category({ categoryId: "b", recordedExpense: "4000", shareOfTotal: "40" }),
      ],
    });
    expect(runInsightRules(ctx({ budget })).filter((s) => s.type === "EXPENSE_CONCENTRATION")).toHaveLength(1);
    expect(runInsightRules(ctx({ budget, thresholds: strict })).filter((s) => s.type === "EXPENSE_CONCENTRATION")).toHaveLength(0);
  });
});

describe("YF-702 kural motoru — nakit akışı baskısı eşiği", () => {
  it("negatif tahmini kapanış bakiyesi CRITICAL üretir", () => {
    const signals = runInsightRules(
      ctx({ cashFlow: cashFlowReport({ openingBalance: "1000", projectedClosingBalance: "-1" }) }),
    );
    const signal = signals.find((s) => s.type === "CASH_FLOW_PRESSURE");
    expect(signal!.severity).toBe("CRITICAL");
  });

  it("kapanış bakiyesi açılışın %20'sinin ALTINDAYSA HIGH üretir", () => {
    const signals = runInsightRules(
      ctx({ cashFlow: cashFlowReport({ openingBalance: "1000", projectedClosingBalance: "199" }) }),
    );
    expect(signals.find((s) => s.type === "CASH_FLOW_PRESSURE")!.severity).toBe("HIGH");
  });

  it("kapanış bakiyesi tam eşikteyse (açılışın %20'si) sinyal ÜRETİLMEZ", () => {
    const signals = runInsightRules(
      ctx({ cashFlow: cashFlowReport({ openingBalance: "1000", projectedClosingBalance: "200" }) }),
    );
    expect(signals.filter((s) => s.type === "CASH_FLOW_PRESSURE")).toHaveLength(0);
  });

  it("açılış bakiyesi sıfırken (veri yok) pozitif projeksiyonda uyarı UYDURULMAZ", () => {
    const signals = runInsightRules(ctx({ cashFlow: cashFlowReport({ openingBalance: "0", projectedClosingBalance: "0" }) }));
    expect(signals.filter((s) => s.type === "CASH_FLOW_PRESSURE")).toHaveLength(0);
  });

  it("kanıt: fark ve yüzde değişim Decimal doğruluğuyla hesaplanır, dönem etiketi taşınır", () => {
    const signals = runInsightRules(
      ctx({ cashFlow: cashFlowReport({ openingBalance: "1000", projectedClosingBalance: "-500" }) }),
    );
    const evidence = signals.find((s) => s.type === "CASH_FLOW_PRESSURE")!.evidence;
    expect(evidence.currentValue).toEqual({ label: "Tahmini kapanış bakiyesi", value: "-500", kind: "MONEY" });
    expect(evidence.comparisonValue).toEqual({ label: "Güncel kasa/banka bakiyesi", value: "1000", kind: "MONEY" });
    expect(evidence.difference).toEqual({ label: "Beklenen bakiye değişimi", value: "-1500", kind: "MONEY" });
    expect(evidence.percentageChange).toBe("-150");
    expect(evidence.period).toBe("01.08.2026 - 01.09.2026");
  });
});

describe("YF-702 kural motoru — vadesi geçmiş alacak eşiği", () => {
  it("oran tam eşikteyken (%30) HIGH üretir", () => {
    const signals = runInsightRules(
      ctx({ cashFlow: cashFlowReport({ receivableBuckets: { ...ZERO_BUCKETS, overdue: "300", next30Days: "700" } }) }),
    );
    const signal = signals.find((s) => s.id === "overdue_receivables:org");
    expect(signal!.severity).toBe("HIGH");
    expect(signal!.evidence.comparisonValue).toEqual({ label: "Toplam açık alacak", value: "1000", kind: "MONEY" });
    expect(signal!.evidence.details).toEqual([{ label: "Vadesi geçmiş alacak oranı", value: "30", kind: "PERCENT" }]);
  });

  it("oran eşiğin altındayken MEDIUM üretir", () => {
    const signals = runInsightRules(
      ctx({ cashFlow: cashFlowReport({ receivableBuckets: { ...ZERO_BUCKETS, overdue: "299", next30Days: "701" } }) }),
    );
    expect(signals.find((s) => s.id === "overdue_receivables:org")!.severity).toBe("MEDIUM");
  });

  it("vadesi geçmiş alacak sıfırken sinyal ÜRETİLMEZ", () => {
    const signals = runInsightRules(ctx({ cashFlow: cashFlowReport({ receivableBuckets: { ...ZERO_BUCKETS, next30Days: "5000" } }) }));
    expect(signals.filter((s) => s.type === "OVERDUE_RECEIVABLES")).toHaveLength(0);
  });

  it("proje bazlı sinyal sayısı eşikle sınırlanır", () => {
    const rows = Array.from({ length: 8 }, (_, i) =>
      projectCashRow({ projectId: `p-${i}`, name: `Proje ${i}`, overdueReceivable: String(1000 - i) }),
    );
    const signals = runInsightRules(ctx({ cashFlow: cashFlowReport({ projectComparison: rows }) }));
    expect(signals.filter((s) => s.type === "OVERDUE_RECEIVABLES" && s.affectedProjectId)).toHaveLength(
      DEFAULT_INSIGHT_THRESHOLDS.maxOverdueProjectSignals,
    );
  });
});

describe("YF-702 kural motoru — birleşik risk ve kanıt bütünlüğü", () => {
  it("proje kötüleşmesi HEM bütçe baskısı HEM vadesi geçmiş alacak gerektirir", () => {
    // Yalnızca bütçe baskısı — birleşik risk sinyali YOK.
    const budgetOnly = runInsightRules(
      ctx({ budget: budgetReport({ projectComparison: [projectBudgetRow({ status: "OVER_BUDGET" })] }) }),
    );
    expect(budgetOnly.filter((s) => s.type === "PROJECT_DETERIORATION")).toHaveLength(0);

    // İkisi birlikte — sinyal VAR.
    const both = runInsightRules(
      ctx({
        budget: budgetReport({ projectComparison: [projectBudgetRow({ status: "OVER_BUDGET" })] }),
        cashFlow: cashFlowReport({ projectComparison: [projectCashRow({ overdueReceivable: "2000" })] }),
      }),
    );
    const signal = both.find((s) => s.type === "PROJECT_DETERIORATION");
    expect(signal).toBeDefined();
    expect(signal!.severity).toBe("CRITICAL");
    // Ham enum ("OVER_BUDGET") kullanıcıya sızmaz — Türkçe etiket kullanılır.
    expect(signal!.evidence.details).toContainEqual({ label: "Bütçe durumu", value: "Bütçe aşımı", kind: "TEXT" });
    expect(signal!.facts).not.toContain("OVER_BUDGET");
  });

  it("tüm kanıt etiketleri Türkçedir ve ham camelCase alan adı içermez", () => {
    const signals = runInsightRules(
      ctx({
        budget: budgetReport({
          overBudgetProjects: [overBudgetRow()],
          categoryAnalysis: [
            category({ categoryId: "a", recordedExpense: "6000", shareOfTotal: "60" }),
            category({ categoryId: "b", recordedExpense: "4000", shareOfTotal: "40" }),
          ],
        }),
        cashFlow: cashFlowReport({
          openingBalance: "1000",
          projectedClosingBalance: "-500",
          receivableBuckets: { ...ZERO_BUCKETS, overdue: "300", next30Days: "700" },
          projectComparison: [projectCashRow({ overdueReceivable: "300" })],
        }),
      }),
    );
    expect(signals.length).toBeGreaterThan(0);

    const labels = signals.flatMap((s) =>
      [s.evidence.currentValue, s.evidence.comparisonValue, s.evidence.difference, ...s.evidence.details]
        .filter((e) => e !== null)
        .map((e) => e!.label),
    );
    expect(labels.length).toBeGreaterThan(0);
    for (const label of labels) {
      // camelCase bir alan adı ("estimatedBudget") küçük harfle başlayıp büyük
      // harf içerir; Türkçe etiketler her zaman büyük harfle başlar.
      expect(label).not.toMatch(/^[a-z]+[A-Z]/);
      expect(label[0]).toBe(label[0].toLocaleUpperCase("tr-TR"));
    }
  });

  it("bütçe sinyallerinde dönem alanı null'dır — bütçe raporu bir tarih aralığı tanımlamaz, uydurulmaz", () => {
    const signals = runInsightRules(ctx({ budget: budgetReport({ overBudgetProjects: [overBudgetRow()] }) }));
    const signal = signals.find((s) => s.type === "BUDGET_OVERRUN")!;
    expect(signal.evidence.period).toBeNull();
  });

  it("sinyaller önem derecesine göre azalan, eşitlikte kimliğe göre artan sırada döner", () => {
    const signals = runInsightRules(
      ctx({
        budget: budgetReport({
          overBudgetProjects: [overBudgetRow({ projectId: "p-crit", name: "Kritik Proje" })],
          atRiskProjects: [
            { ...projectBudgetRow({ projectId: "p-risk", status: "CRITICAL" }), remainingAmount: "100", recentTrend: [] },
          ],
        }),
        cashFlow: cashFlowReport({ receivableBuckets: { ...ZERO_BUCKETS, overdue: "100", next30Days: "900" } }),
      }),
    );
    const ranks = { CRITICAL: 3, HIGH: 2, MEDIUM: 1, LOW: 0 } as const;
    for (let i = 1; i < signals.length; i++) {
      expect(ranks[signals[i - 1].severity]).toBeGreaterThanOrEqual(ranks[signals[i].severity]);
    }
  });
});
