import { describe, expect, it } from "vitest";
import { Prisma } from "@prisma/client";
import { runInsightRules, type InsightRuleContext, type SettlementPeriodTotals } from "@/server/services/ai-insights-rules";
import { DEFAULT_INSIGHT_THRESHOLDS, type InsightThresholds } from "@/lib/ai/insights/thresholds";
import type {
  BudgetReport,
  CategoryAnalysisRow,
  OverBudgetProjectRow,
  ProjectBudgetRow,
} from "@/server/services/budget-report-service";
import type { MaturityBuckets, OrganizationCashFlowReport, ProjectCashFlowRow } from "@/server/services/cash-flow-report-service";
import type { ProjectMarginComparison, ProjectMarginComparisonRow } from "@/server/services/project-margin-service";

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

function settlementTotals(overrides: Partial<SettlementPeriodTotals> = {}): SettlementPeriodTotals {
  return {
    collected: "0",
    paid: "0",
    net: "0",
    rangeStart: RANGE_START,
    rangeEnd: RANGE_END,
    ...overrides,
  };
}

/**
 * Tahsilat/ödeme çiftinden bağlam kurar. `net` kanonik serviste
 * `collected - paid` olarak üretildiğinden burada da aynı ilişkiyle
 * kurgulanır — kural bu değeri YENİDEN türetmez, kanıt olarak taşır.
 */
function settlementCtx(collected: string, paid: string, thresholds: InsightThresholds = DEFAULT_INSIGHT_THRESHOLDS) {
  const net = new Prisma.Decimal(collected).minus(new Prisma.Decimal(paid)).toString();
  return ctx({ settlement: settlementTotals({ collected, paid, net }), thresholds });
}

/** YF-702-F3 — Marj karşılaştırmasının dönemleri; `getDateRange` gibi YARI AÇIK (`end` hariç). */
const MARGIN_CURRENT_PERIOD = { start: new Date("2026-08-01T00:00:00.000+03:00"), end: new Date("2026-09-01T00:00:00.000+03:00") };
const MARGIN_PRIOR_PERIOD = { start: new Date("2026-07-01T00:00:00.000+03:00"), end: new Date("2026-08-01T00:00:00.000+03:00") };

/**
 * YF-702-F3 — Tek bir dönemin marj bloğu, İSTENEN marj değerinden kurgulanır.
 *
 * Gelir/gider kurgulayıp marjın tam `%20,00` çıkmasını ummak yerine marj
 * doğrudan verilir, kâr ve gider ondan TUTARLI biçimde türetilir
 * (`kâr = gelir × marj / 100`, `gider = gelir − kâr`) — eşiğin tam sınırı
 * (`5` puan VAR, `4,99` puan YOK) ancak böyle KESİN olarak sınanabilir.
 * `marginPercent === null`, F2'nin "gelir sıfır/negatif → marj tanımsız"
 * semantiğini temsil eder.
 */
function periodMargin(revenue: string, marginPercent: string | null): ProjectMarginComparisonRow["current"] {
  if (marginPercent === null) {
    return { revenue, expense: "0", profit: revenue, margin: null, marginAvailable: false };
  }
  const profit = new Prisma.Decimal(revenue).mul(marginPercent).div(100);
  return {
    revenue,
    expense: new Prisma.Decimal(revenue).minus(profit).toString(),
    profit: profit.toString(),
    margin: marginPercent,
    marginAvailable: true,
  };
}

function marginRow(overrides: Partial<ProjectMarginComparisonRow> = {}): ProjectMarginComparisonRow {
  return {
    projectId: "p-1",
    projectName: "Proje 1",
    projectCode: "P1",
    current: periodMargin("100000", "20"),
    prior: periodMargin("100000", "20"),
    ...overrides,
  };
}

function projectMarginComparison(rows: ProjectMarginComparisonRow[] = []): ProjectMarginComparison {
  return {
    period: "CURRENT_MONTH",
    scope: "ORGANIZATION",
    currentPeriod: MARGIN_CURRENT_PERIOD,
    priorPeriod: MARGIN_PRIOR_PERIOD,
    rows,
  };
}

function ctx(overrides: Partial<InsightRuleContext> = {}): InsightRuleContext {
  return {
    budget: budgetReport(),
    cashFlow: cashFlowReport(),
    settlement: settlementTotals(),
    projectMargin: projectMarginComparison(),
    thresholds: DEFAULT_INSIGHT_THRESHOLDS,
    ...overrides,
  };
}

/** Yalnızca marj gerilemesi sinyallerini üretir — diğer kurallar boş bağlamla sessiz kalır. */
function marginSignals(rows: ProjectMarginComparisonRow[], thresholds: InsightThresholds = DEFAULT_INSIGHT_THRESHOLDS) {
  return runInsightRules(ctx({ projectMargin: projectMarginComparison(rows), thresholds })).filter(
    (s) => s.type === "PROJECT_MARGIN_DETERIORATION",
  );
}

/**
 * `prior → current` marj çifti; iki dönemin de geliri varsayılan olarak
 * gürültü tabanının ÇOK üstündedir. Marj `null` verilirse gelir de `0` alınır
 * — F2'de marj YALNIZCA gelir sıfır/negatifken tanımsızdır, "yüksek gelir +
 * tanımsız marj" gerçekte oluşamayacak bir kurgu olurdu.
 */
function decline(priorMargin: string | null, currentMargin: string | null, overrides: Partial<ProjectMarginComparisonRow> = {}) {
  return marginRow({
    prior: periodMargin(priorMargin === null ? "0" : "100000", priorMargin),
    current: periodMargin(currentMargin === null ? "0" : "100000", currentMargin),
    ...overrides,
  });
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

describe("YF-702-F1 kural motoru — tahsilat/ödeme dengesizliği", () => {
  const imbalance = (signals: ReturnType<typeof runInsightRules>) =>
    signals.filter((s) => s.type === "COLLECTION_PAYMENT_IMBALANCE");

  it("karşılama oranı eşiğin altındayken sinyal üretilir ve tek bir sinyal döner", () => {
    const signals = imbalance(runInsightRules(settlementCtx("60000", "100000")));
    expect(signals).toHaveLength(1);
    expect(signals[0].id).toBe("collection_payment_imbalance:org");
    expect(signals[0].severity).toBe("MEDIUM");
  });

  it("karşılama oranı tam eşikteyken (%80) sinyal ÜRETİLİR", () => {
    expect(imbalance(runInsightRules(settlementCtx("80000", "100000")))).toHaveLength(1);
  });

  it("karşılama oranı eşiğin hemen ÜSTÜNDEYKEN (%80,01) sinyal ÜRETİLMEZ", () => {
    expect(imbalance(runInsightRules(settlementCtx("80010", "100000")))).toHaveLength(0);
  });

  it("karşılama oranı HIGH eşiğine düşünce (%50) önem derecesi yükselir", () => {
    expect(imbalance(runInsightRules(settlementCtx("50000", "100000")))[0].severity).toBe("HIGH");
    expect(imbalance(runInsightRules(settlementCtx("50100", "100000")))[0].severity).toBe("MEDIUM");
  });

  it("mutlak gürültü tabanı: net çıkış tam eşikteyken (10.000 TL) sinyal VAR, hemen altındayken YOK", () => {
    // Her iki kurguda da karşılama oranı tam %80'dir; tek değişken net çıkış tutarıdır.
    expect(imbalance(runInsightRules(settlementCtx("40000", "50000")))).toHaveLength(1);
    expect(imbalance(runInsightRules(settlementCtx("39999.96", "49999.95")))).toHaveLength(0);
  });

  it("tahsilat sıfırken sinyal üretilir; sapma −%100 olarak raporlanır", () => {
    const signal = imbalance(runInsightRules(settlementCtx("0", "20000")))[0];
    expect(signal.severity).toBe("HIGH");
    expect(signal.evidence.percentageChange).toBe("-100");
    expect(signal.evidence.details).toEqual([
      { label: "Tahsilatın ödemeleri karşılama oranı", value: "0", kind: "PERCENT" },
    ]);
  });

  it("ödeme sıfırken sinyal ÜRETİLMEZ — oran tanımsızdır, sıfıra bölme yapılmaz", () => {
    expect(imbalance(runInsightRules(settlementCtx("20000", "0")))).toHaveLength(0);
  });

  it("her iki taraf da sıfırken (veri yok) uyarı UYDURULMAZ", () => {
    expect(imbalance(runInsightRules(settlementCtx("0", "0")))).toHaveLength(0);
  });

  it("tahsilat ödemeyi aşıyorsa (sağlıklı dönem) sinyal ÜRETİLMEZ", () => {
    expect(imbalance(runInsightRules(settlementCtx("150000", "100000")))).toHaveLength(0);
  });

  it("kanıt alanları eksiksiz ve doğrudur; dönem etiketi taşınır", () => {
    const signal = imbalance(runInsightRules(settlementCtx("60000", "100000")))[0];
    expect(signal.evidence.currentValue).toEqual({ label: "Dönemde gerçekleşen tahsilat", value: "60000", kind: "MONEY" });
    expect(signal.evidence.comparisonValue).toEqual({ label: "Dönemde gerçekleşen ödeme", value: "100000", kind: "MONEY" });
    expect(signal.evidence.difference).toEqual({ label: "Net nakit akışı", value: "-40000", kind: "MONEY" });
    expect(signal.evidence.percentageChange).toBe("-40");
    expect(signal.evidence.details).toEqual([
      { label: "Tahsilatın ödemeleri karşılama oranı", value: "60", kind: "PERCENT" },
    ]);
    expect(signal.evidence.period).toBe("01.08.2026 - 01.09.2026");
    expect(signal.affectedProjectId).toBeNull();
  });

  it("Decimal doğruluğu: kayan nokta hatası (0,3 − 0,1) kanıta veya olgu cümlesine sızmaz", () => {
    const precise: InsightThresholds = { ...DEFAULT_INSIGHT_THRESHOLDS, collectionPaymentImbalanceMinNetOutflow: "0.1" };
    const signal = imbalance(runInsightRules(settlementCtx("0.1", "0.3", precise)))[0];
    // JS float aritmetiğinde 0.3 - 0.1 = 0.19999999999999998 olurdu.
    expect(signal.facts).toContain("0.2 TL aştı");
    expect(signal.facts).not.toContain("0.19999");
    expect(signal.evidence.percentageChange).toBe("-66.7");
    expect(signal.evidence.details[0].value).toBe("33.3");
  });

  it("eşikler enjekte edilebilir: oran eşiği %50'ye çekilince %60'lık karşılama artık sinyal üretmez", () => {
    const strict: InsightThresholds = { ...DEFAULT_INSIGHT_THRESHOLDS, collectionPaymentImbalanceMaxCoverageRatio: "0.5" };
    expect(imbalance(runInsightRules(settlementCtx("60000", "100000")))).toHaveLength(1);
    expect(imbalance(runInsightRules(settlementCtx("60000", "100000", strict)))).toHaveLength(0);
  });

  it("gürültü tabanı enjekte edilebilir: taban yükseltilince aynı dönem sinyal üretmez", () => {
    const strict: InsightThresholds = { ...DEFAULT_INSIGHT_THRESHOLDS, collectionPaymentImbalanceMinNetOutflow: "50000" };
    expect(imbalance(runInsightRules(settlementCtx("60000", "100000", strict)))).toHaveLength(0);
  });

  it("dengesizlik sinyali mevcut diğer sinyalleri etkilemez (regresyon)", () => {
    const base = runInsightRules(ctx({ cashFlow: cashFlowReport({ openingBalance: "1000", projectedClosingBalance: "-500" }) }));
    const withImbalance = runInsightRules(
      ctx({
        cashFlow: cashFlowReport({ openingBalance: "1000", projectedClosingBalance: "-500" }),
        settlement: settlementTotals({ collected: "60000", paid: "100000", net: "-40000" }),
      }),
    );
    expect(base.filter((s) => s.type === "CASH_FLOW_PRESSURE")).toHaveLength(1);
    expect(withImbalance.filter((s) => s.type === "CASH_FLOW_PRESSURE")).toEqual(
      base.filter((s) => s.type === "CASH_FLOW_PRESSURE"),
    );
    expect(withImbalance).toHaveLength(base.length + 1);
  });
});

describe("YF-702-F3 kural motoru — proje kâr marjı gerilemesi (yön ve eşik)", () => {
  it("maddi gerileme (24 → 14 = 10 puan) MEDIUM sinyal üretir", () => {
    const signals = marginSignals([decline("24", "14")]);
    expect(signals).toHaveLength(1);
    expect(signals[0].severity).toBe("MEDIUM");
    expect(signals[0].id).toBe("project_margin_deterioration:p-1");
    expect(signals[0].affectedProjectId).toBe("p-1");
    expect(signals[0].affectedProjectName).toBe("Proje 1");
  });

  it("HIGH eşiğini aşan gerileme (30 → 10 = 20 puan) HIGH üretir", () => {
    expect(marginSignals([decline("30", "10")])[0].severity).toBe("HIGH");
  });

  it("sabit marj sinyal üretmez", () => {
    expect(marginSignals([decline("20", "20")])).toHaveLength(0);
  });

  it("iyileşen marj sinyal üretmez", () => {
    expect(marginSignals([decline("20", "25")])).toHaveLength(0);
  });

  it("eşiğin altındaki gerileme (20 → 16 = 4 puan) sinyal üretmez", () => {
    expect(marginSignals([decline("20", "16")])).toHaveLength(0);
  });
});

describe("YF-702-F3 kural motoru — eşik sınırları ve Decimal hassasiyeti", () => {
  it("tam eşikte (5 puan) sinyal VAR, hemen altında (4,99 puan) YOK", () => {
    expect(marginSignals([decline("20", "15")])).toHaveLength(1);
    expect(marginSignals([decline("20", "15.01")])).toHaveLength(0);
  });

  it("tam HIGH eşiğinde (15 puan) HIGH, hemen altında (14,99 puan) MEDIUM", () => {
    expect(marginSignals([decline("20", "5")])[0].severity).toBe("HIGH");
    expect(marginSignals([decline("20", "5.01")])[0].severity).toBe("MEDIUM");
  });

  it("iki ondalıklı marjlarda kayan nokta hatası eşiği kaydırmaz", () => {
    // 20.01 − 15.00 = 5.01 (>= 5) VAR; 20.00 − 15.01 = 4.99 (< 5) YOK.
    expect(marginSignals([decline("20.01", "15")])).toHaveLength(1);
    expect(marginSignals([decline("20", "15.01")])).toHaveLength(0);
    // Kuruş düzeyinde marj farkı: 0,01 puanlık gerileme asla sinyal üretmez.
    expect(marginSignals([decline("20.01", "20")])).toHaveLength(0);
  });

  it("eşikler enjekte edilebilir — aynı veri, farklı eşikte sessizleşir", () => {
    const strict: InsightThresholds = { ...DEFAULT_INSIGHT_THRESHOLDS, projectMarginDeteriorationMinPoints: "11" };
    expect(marginSignals([decline("24", "14")])).toHaveLength(1);
    expect(marginSignals([decline("24", "14")], strict)).toHaveLength(0);
  });
});

describe("YF-702-F3 kural motoru — gelir gürültü tabanı", () => {
  it("cari dönem geliri tabanın altındaysa (9.999,99 TL) sinyal üretilmez", () => {
    const row = marginRow({ prior: periodMargin("100000", "40"), current: periodMargin("9999.99", "10") });
    expect(marginSignals([row])).toHaveLength(0);
  });

  it("cari dönem geliri tam tabandaysa (10.000 TL) sinyal üretilir", () => {
    const row = marginRow({ prior: periodMargin("100000", "40"), current: periodMargin("10000", "10") });
    expect(marginSignals([row])).toHaveLength(1);
  });

  it("önceki dönem geliri tabanın altındaysa sinyal üretilmez — anlamsız bir tabandan gerileme iddia edilmez", () => {
    // 1 TL gelirle "%100 marj" gerçek bir kârlılık göstergesi değildir.
    const row = marginRow({ prior: periodMargin("1", "100"), current: periodMargin("500000", "20") });
    expect(marginSignals([row])).toHaveLength(0);
  });
});

describe("YF-702-F3 kural motoru — tanımsız marj asla 0 sayılmaz", () => {
  it("önceki dönem marjı tanımsızsa sinyal üretilmez", () => {
    expect(marginSignals([decline(null, "10")])).toHaveLength(0);
  });

  it("cari dönem marjı tanımsızsa sinyal üretilmez", () => {
    expect(marginSignals([decline("40", null)])).toHaveLength(0);
  });

  it("iki dönem de tanımsızsa sinyal üretilmez", () => {
    expect(marginSignals([decline(null, null)])).toHaveLength(0);
  });

  it("cari dönemde hiç hareket yoksa (gelir 0) 'marj %0'a düştü' UYDURULMAZ", () => {
    // F2 bu satırı gelir/gider 0 ve margin null olarak üretir; naif bir
    // uygulama bunu "%40 → %0 = 40 puan" sanıp CRITICAL bir uyarı basardı.
    const row = marginRow({ prior: periodMargin("100000", "40"), current: periodMargin("0", null) });
    expect(marginSignals([row])).toHaveLength(0);
  });
});

describe("YF-702-F3 kural motoru — negatif marj semantiği", () => {
  it("pozitiften negatife geçiş (5 → -10 = 15 puan) HIGH üretir", () => {
    const signals = marginSignals([decline("5", "-10")]);
    expect(signals).toHaveLength(1);
    expect(signals[0].severity).toBe("HIGH");
    expect(signals[0].evidence.difference).toEqual({ label: "Marj değişimi", value: "-15", kind: "PERCENTAGE_POINT" });
  });

  it("negatiften daha negatife (-10 → -30 = 20 puan) sinyal üretir — zarar derinleşmesi de gerilemedir", () => {
    expect(marginSignals([decline("-10", "-30")])[0].severity).toBe("HIGH");
  });

  it("negatiften daha az negatife (-30 → -10) sinyal ÜRETMEZ — bu bir iyileşmedir", () => {
    expect(marginSignals([decline("-30", "-10")])).toHaveLength(0);
  });
});

describe("YF-702-F3 kural motoru — üst sınır ve deterministik sıralama", () => {
  /** `n` projelik, gerilemesi giderek artan bir kapsam üretir (p-01 en zayıf gerileme). */
  function ladder(n: number): ProjectMarginComparisonRow[] {
    return Array.from({ length: n }, (_, i) => {
      const id = `p-${String(i + 1).padStart(2, "0")}`;
      return decline("50", String(45 - i), { projectId: id, projectName: `Proje ${id}` });
    });
  }

  it("aday sayısı üst sınırı aşarsa yalnızca en sert gerileyen projeler raporlanır", () => {
    const signals = marginSignals(ladder(8));
    expect(signals).toHaveLength(DEFAULT_INSIGHT_THRESHOLDS.maxProjectMarginSignals);
    // 45..38 aralığında en sert gerileme en KÜÇÜK cari marjdır → p-04..p-08.
    expect(signals.map((s) => s.affectedProjectId).sort()).toEqual(["p-04", "p-05", "p-06", "p-07", "p-08"]);
  });

  it("üst sınır enjekte edilebilir", () => {
    const capped: InsightThresholds = { ...DEFAULT_INSIGHT_THRESHOLDS, maxProjectMarginSignals: 2 };
    expect(marginSignals(ladder(8), capped)).toHaveLength(2);
  });

  it("eşit gerilemede daha büyük cari gelirli proje seçilir", () => {
    const small = marginRow({
      projectId: "p-small",
      prior: periodMargin("100000", "30"),
      current: periodMargin("50000", "20"),
    });
    const big = marginRow({
      projectId: "p-big",
      prior: periodMargin("100000", "30"),
      current: periodMargin("900000", "20"),
    });
    const capped: InsightThresholds = { ...DEFAULT_INSIGHT_THRESHOLDS, maxProjectMarginSignals: 1 };
    expect(marginSignals([small, big], capped)[0].affectedProjectId).toBe("p-big");
    // Girdi sırası sonucu DEĞİŞTİRMEZ.
    expect(marginSignals([big, small], capped)[0].affectedProjectId).toBe("p-big");
  });

  it("gerileme ve gelir de eşitse proje kimliği kararlı bir son sıralama ölçütüdür", () => {
    const rows = ["p-c", "p-a", "p-b"].map((id) => decline("30", "20", { projectId: id }));
    const capped: InsightThresholds = { ...DEFAULT_INSIGHT_THRESHOLDS, maxProjectMarginSignals: 1 };
    expect(marginSignals(rows, capped)[0].affectedProjectId).toBe("p-a");
    expect(marginSignals([...rows].reverse(), capped)[0].affectedProjectId).toBe("p-a");
  });

  it("veritabanı satır sırası çıktıyı ETKİLEMEZ", () => {
    const rows = ladder(8);
    const forward = marginSignals(rows).map((s) => s.id);
    const reversed = marginSignals([...rows].reverse()).map((s) => s.id);
    expect(reversed).toEqual(forward);
  });
});

describe("YF-702-F3 kural motoru — kanıt eşlemesi", () => {
  const signal = () => marginSignals([decline("24", "14")])[0];

  it("cari/önceki marj yüzde, fark ise YÜZDE PUAN olarak taşınır", () => {
    const evidence = signal().evidence;
    expect(evidence.currentValue).toEqual({ label: "Cari dönem kâr marjı", value: "14", kind: "PERCENT" });
    expect(evidence.comparisonValue).toEqual({ label: "Önceki dönem kâr marjı", value: "24", kind: "PERCENT" });
    expect(evidence.difference).toEqual({ label: "Marj değişimi", value: "-10", kind: "PERCENTAGE_POINT" });
  });

  it("percentageChange null'dır — göreli marj kaybı (%41,67) puan farkıyla karıştırılmaz", () => {
    expect(signal().evidence.percentageChange).toBeNull();
  });

  it("dönem etiketleri yarı açık aralığın SON GÜNÜNÜ gösterir", () => {
    const evidence = signal().evidence;
    expect(evidence.period).toBe("01.08.2026 - 31.08.2026");
    expect(evidence.details).toContainEqual({ label: "Önceki dönem", value: "01.07.2026 - 31.07.2026", kind: "TEXT" });
  });

  it("kanıt, marjı açıklayan gelir ve kâr rakamlarını taşır", () => {
    const details = signal().evidence.details;
    expect(details).toContainEqual({ label: "Cari dönem geliri", value: "100000", kind: "MONEY" });
    expect(details).toContainEqual({ label: "Cari dönem kârı", value: "14000", kind: "MONEY" });
    expect(details).toContainEqual({ label: "Önceki dönem geliri", value: "100000", kind: "MONEY" });
    expect(details).toContainEqual({ label: "Önceki dönem kârı", value: "24000", kind: "MONEY" });
  });

  it("olgu cümlesi düşüşün YÜZDE PUAN cinsinden olduğunu açıkça söyler", () => {
    const facts = signal().facts;
    expect(facts).toContain("yüzde puan");
    expect(facts).toContain("10 yüzde puanlık gerileme");
    // Göreli kayıp (%41,67) metinde GEÇMEZ — iki metrik karıştırılmaz.
    expect(facts).not.toContain("41");
  });

  it("kanıt etiketleri Türkçedir, ham alan adı veya tenant bilgisi taşımaz", () => {
    const s = signal();
    const entries = [s.evidence.currentValue, s.evidence.comparisonValue, s.evidence.difference, ...s.evidence.details];
    for (const entry of entries) {
      expect(entry!.label).not.toMatch(/^[a-z]+[A-Z]/);
      expect(entry!.label[0]).toBe(entry!.label[0].toLocaleUpperCase("tr-TR"));
    }
    expect(s.facts).not.toContain("projectId");
    expect(s.facts).not.toContain("organizationId");
    expect(s.facts).not.toContain("PROJECT_MARGIN_DETERIORATION");
  });
});

describe("YF-702-F3 kural motoru — mevcut sinyallere etkisizlik", () => {
  it("marj kapsamı boşken diğer sinyaller aynen üretilir", () => {
    const base = ctx({
      budget: budgetReport({ overBudgetProjects: [overBudgetRow()] }),
      settlement: settlementTotals({ collected: "60000", paid: "100000", net: "-40000" }),
    });
    const withoutMargin = runInsightRules(base);
    const withMargin = runInsightRules({ ...base, projectMargin: projectMarginComparison([decline("24", "14")]) });

    expect(withoutMargin.some((s) => s.type === "PROJECT_MARGIN_DETERIORATION")).toBe(false);
    // Marj sinyali EKLENİR; mevcut sinyaller birebir korunur.
    expect(withMargin.filter((s) => s.type !== "PROJECT_MARGIN_DETERIORATION")).toEqual(withoutMargin);
  });

  it("PROJECT_MANAGER kapsamı boşsa (atanmış proje yok) marj sinyali üretilmez", () => {
    const emptyScope: ProjectMarginComparison = { ...projectMarginComparison([]), scope: "PROJECT_MANAGER" };
    expect(runInsightRules(ctx({ projectMargin: emptyScope })).filter((s) => s.type === "PROJECT_MARGIN_DETERIORATION")).toHaveLength(0);
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
        settlement: settlementTotals({ collected: "60000", paid: "100000", net: "-40000" }),
      }),
    );
    expect(signals.length).toBeGreaterThan(0);
    expect(signals.some((s) => s.type === "COLLECTION_PAYMENT_IMBALANCE")).toBe(true);

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
