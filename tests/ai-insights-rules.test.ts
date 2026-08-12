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

function ctx(overrides: Partial<InsightRuleContext> = {}): InsightRuleContext {
  return {
    budget: budgetReport(),
    cashFlow: cashFlowReport(),
    settlement: settlementTotals(),
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
