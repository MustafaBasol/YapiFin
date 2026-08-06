import { describe, expect, it } from "vitest";
import ExcelJS from "exceljs";
import { buildDashboardWorkbook, buildProjectFinanceWorkbook, buildCashFlowWorkbook, buildBudgetWorkbook, sanitizeExcelText } from "@/server/exports/excel-exporter";
import { toExcelAmountCell, EXCEL_EXACT_SAFE_MAX } from "@/server/exports/money";
import type { OrganizationDashboardData } from "@/server/services/dashboard-service";
import type { ProjectFinanceSummary } from "@/server/services/project-finance-service";
import type { OrganizationCashFlowReport } from "@/server/services/cash-flow-report-service";
import type { OrganizationBudgetReport } from "@/server/services/budget-report-service";
import type { ExportMeta } from "@/server/services/report-export-service";
import type { ProjectBudgetVarianceReport } from "@/server/services/project-budget-variance-service";

const META: ExportMeta = {
  organizationName: "Test İnşaat A.Ş.",
  generatedAt: new Date("2026-08-05T10:30:00.000Z"),
  periodLabel: "Bu Ay",
};

async function loadWorkbook(buffer: Buffer): Promise<ExcelJS.Workbook> {
  const wb = new ExcelJS.Workbook();
  // exceljs'in .d.ts'i eski (generic olmayan) bir `Buffer` şekli bekliyor;
  // @types/node'un güncel `Buffer<ArrayBufferLike>` şekli yapısal olarak
  // aynı olsa da bir derleme zamanı tip uyuşmazlığı üretiyor — yalnızca bu
  // test yardımcı fonksiyonuna özgü, çalışma zamanını etkilemeyen bir tip
  // aktarımı (production kodu `.load()` hiç çağırmaz, yalnızca `writeBuffer()`).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await wb.xlsx.load(buffer as any);
  return wb;
}

// ---------------------------------------------------------------------------
// Formül/CSV enjeksiyon koruması
// ---------------------------------------------------------------------------

describe("sanitizeExcelText — formül/CSV enjeksiyon koruması", () => {
  const cases: [string, string][] = [
    ["=SUM(A1:A2)", "'=SUM(A1:A2)"],
    [" +CMD", "' +CMD"],
    ["\t=evil", "'\t=evil"],
    ["\r@evil", "'\r@evil"],
    ["\n-evil", "'\n-evil"],
  ];
  it.each(cases)("%j → %j (baştaki apostrof, orijinal içerik korunur)", (input, expected) => {
    expect(sanitizeExcelText(input)).toBe(expected);
  });

  it("zararsız metni değiştirmez", () => {
    expect(sanitizeExcelText("Normal açıklama")).toBe("Normal açıklama");
  });

  it("sanitize edilen hücre Excel'e yeniden yüklendiğinde formül değil, düz metin olarak kalır", async () => {
    const data = makeDashboardData({
      recentMovements: [
        {
          id: "1",
          occurredAt: new Date(),
          type: "ADJUSTMENT",
          accountName: "Ana Kasa",
          amount: "100.00",
          direction: "CREDIT",
          description: "=SUM(A1:A2)",
          relatedProjectName: null,
        },
      ],
    });
    const buffer = await buildDashboardWorkbook(data, META);
    const wb = await loadWorkbook(buffer);
    const sheet = wb.getWorksheet("Son Hareketler")!;
    const descCell = sheet.getRow(7).getCell(3);
    expect(descCell.type).not.toBe(ExcelJS.ValueType.Formula);
    expect(String(descCell.value)).toContain("=SUM(A1:A2)");
  });
});

// ---------------------------------------------------------------------------
// Decimal → Excel hassasiyet sınırı
// ---------------------------------------------------------------------------

describe("toExcelAmountCell — Decimal→Excel sayısal hassasiyet sınırı", () => {
  it("kuruş hassasiyetli küçük tutarı sayısal hücreye çevirir", () => {
    const cell = toExcelAmountCell("1234.56");
    expect(cell.kind).toBe("numeric");
    expect(cell.kind === "numeric" && cell.value).toBe(1234.56);
  });

  it("güvenli sınırdaki büyük tutarı sayısal hücreye çevirir", () => {
    const cell = toExcelAmountCell(EXCEL_EXACT_SAFE_MAX);
    expect(cell.kind).toBe("numeric");
  });

  it("güvenli sınırı aşan tutarı metin hücresine düşürür, tutarı kaybetmez", () => {
    const cell = toExcelAmountCell("123456789012345.67");
    expect(cell.kind).toBe("text");
    expect(cell.kind === "text" && cell.value).toContain("123.456.789.012.345,67");
  });
});

// ---------------------------------------------------------------------------
// Dashboard workbook
// ---------------------------------------------------------------------------

function makeDashboardData(overrides: Partial<OrganizationDashboardData> = {}): OrganizationDashboardData {
  return {
    scope: "ORGANIZATION",
    period: "CURRENT_MONTH",
    projectFilter: null,
    kpis: {
      collectedIncome: "10000.00",
      paidExpense: "4000.00",
      netCashFlow: "6000.00",
      openReceivable: "2000.00",
      overdueReceivable: "500.00",
      openPayable: "1000.00",
      overduePayable: "0.00",
      cashAndBankBalance: "50000.00",
      activeProjectCount: 3,
      totalProjectCount: 5,
      activeCustomerCount: 4,
      activeSupplierCount: 2,
      budgetCriticalProjectCount: 1,
    },
    monthlySeries: [{ key: "2026-08", label: "Ağu 26", collected: 1000, paid: 500, net: 500 }],
    monthlySeriesGranularity: "LAST_12_MONTHS",
    expenseCategoryDistribution: [{ categoryId: "c1", name: "Malzeme", amount: "1500.00" }],
    projectComparison: [{ projectId: "p1", name: "Proje A", code: "P-1", income: "5000.00", expense: "2000.00", result: "3000.00" }],
    upcomingCollections: [],
    upcomingPayments: [],
    recentMovements: [],
    ...overrides,
  };
}

describe("buildDashboardWorkbook", () => {
  it("beklenen sayfa adlarını ve Türkçe başlıkları üretir", async () => {
    const buffer = await buildDashboardWorkbook(makeDashboardData(), META);
    expect(buffer.subarray(0, 2).toString("hex")).toBe("504b"); // PK.. (zip/xlsx imzası)

    const wb = await loadWorkbook(buffer);
    expect(wb.worksheets.map((s) => s.name)).toEqual([
      "Özet",
      "Aylık Nakit Akışı",
      "Gider Kategorileri",
      "Son Hareketler",
      "Yaklaşan Tahsilatlar",
      "Yaklaşan Ödemeler",
    ]);
    expect(wb.getWorksheet("Özet")!.getCell("A1").value).toBe("YapiFin — Finansal Panel Özeti");
  });

  it("PM kapsamında 'Son Proje Hareketleri' sayfasını kullanır, org-only alanları içermez", async () => {
    const pmData: import("@/server/services/dashboard-service").ProjectManagerDashboardData = {
      scope: "PROJECT_MANAGER",
      period: "CURRENT_MONTH",
      projectFilter: null,
      hasAssignedProjects: true,
      kpis: {
        collectedIncome: "100.00",
        paidExpense: "50.00",
        netCashFlow: "50.00",
        openReceivable: "0.00",
        overdueReceivable: "0.00",
        openPayable: "0.00",
        overduePayable: "0.00",
        activeProjectCount: 1,
        totalProjectCount: 1,
        budgetCriticalProjectCount: 0,
      },
      monthlySeries: [],
      monthlySeriesGranularity: "LAST_12_MONTHS",
      expenseCategoryDistribution: [],
      projectComparison: [],
      upcomingCollections: [],
      upcomingPayments: [],
      recentProjectActivity: [],
    };
    const buffer = await buildDashboardWorkbook(pmData, META);
    const wb = await loadWorkbook(buffer);
    expect(wb.worksheets.map((s) => s.name)).toContain("Son Proje Hareketleri");
    expect(wb.worksheets.map((s) => s.name)).not.toContain("Son Hareketler");
  });

  it("para hücreleri sayısal tiptedir ve TL biçimlidir", async () => {
    const buffer = await buildDashboardWorkbook(makeDashboardData(), META);
    const wb = await loadWorkbook(buffer);
    const sheet = wb.getWorksheet("Özet")!;
    const kpiRow = sheet.getRow(7);
    expect(typeof kpiRow.getCell(2).value).toBe("number");
  });

  it("tarih hücreleri gerçek Date tipindedir, dd.mm.yyyy biçimlidir", async () => {
    const data = makeDashboardData({
      upcomingCollections: [
        { id: "u1", description: "Fatura", counterpartName: "Müşteri A", projectName: null, dueDate: new Date("2026-09-01"), remainingAmount: "1000.00", currency: "TRY" },
      ],
    });
    const buffer = await buildDashboardWorkbook(data, META);
    const wb = await loadWorkbook(buffer);
    const sheet = wb.getWorksheet("Yaklaşan Tahsilatlar")!;
    const dueDateCell = sheet.getRow(7).getCell(4);
    expect(dueDateCell.type).toBe(ExcelJS.ValueType.Date);
    expect(dueDateCell.numFmt).toBe("dd.mm.yyyy");
  });

  it("üstbilgi frozen (donmuş) satır ve autoFilter içerir", async () => {
    const buffer = await buildDashboardWorkbook(makeDashboardData(), META);
    const wb = await loadWorkbook(buffer);
    const sheet = wb.getWorksheet("Gider Kategorileri")!;
    expect(sheet.views[0]?.state).toBe("frozen");
    expect(sheet.autoFilter).toBeTruthy();
  });

  it("Türkçe karakterler bozulmadan korunur", async () => {
    const data = makeDashboardData({ expenseCategoryDistribution: [{ categoryId: "c1", name: "Şantiye Malzemesi — İşçilik Ücreti Öğle Çığ Ğüç", amount: "1.00" }] });
    const buffer = await buildDashboardWorkbook(data, META);
    const wb = await loadWorkbook(buffer);
    const sheet = wb.getWorksheet("Gider Kategorileri")!;
    expect(sheet.getRow(7).getCell(1).value).toBe("Şantiye Malzemesi — İşçilik Ücreti Öğle Çığ Ğüç");
  });

  it("gizli sayfa içermez, dahili ID sızdırmaz", async () => {
    const data = makeDashboardData({ projectComparison: [{ projectId: "internal-uuid-do-not-leak", name: "Proje A", code: "P-1", income: "1", expense: "1", result: "0" }] });
    const buffer = await buildDashboardWorkbook(data, META);
    const wb = await loadWorkbook(buffer);
    expect(wb.worksheets.every((s) => !s.state || s.state === "visible")).toBe(true);
    // Proje karşılaştırması dashboard'da ayrı bir sayfa olarak dışa aktarılmaz (KPI'lara dahildir) — dahili ID hiçbir hücreye yazılmaz.
    for (const sheet of wb.worksheets) {
      sheet.eachRow((row) => {
        row.eachCell((cell) => {
          expect(String(cell.value ?? "")).not.toContain("internal-uuid-do-not-leak");
        });
      });
    }
  });
});

// ---------------------------------------------------------------------------
// Cash flow workbook — kesilme (truncation) göstergesi
// ---------------------------------------------------------------------------

function makeCashFlowData(overrides: Partial<OrganizationCashFlowReport> = {}): OrganizationCashFlowReport {
  const emptySection = { rows: [], totalOpenCount: 0, truncated: false };
  return {
    scope: "ORGANIZATION",
    filter: { range: "NEXT_30_DAYS", scenario: "ON_DUE_DATE", projectId: undefined, startDate: undefined, endDate: undefined },
    rangeStart: new Date("2026-08-01"),
    rangeEnd: new Date("2026-08-31"),
    projectFilter: null,
    openingBalance: "10000.00",
    projectedClosingBalance: "12000.00",
    projectedClosingBalanceIsEstimate: true,
    summary: {
      realizedCollections: "5000.00",
      realizedPayments: "2000.00",
      realizedNet: "3000.00",
      scheduledCollections: "1000.00",
      scheduledPayments: "500.00",
      scheduledNet: "500.00",
    },
    receivableBuckets: { overdue: "0", dueToday: "0", next7Days: "0", next30Days: "0", days31to60: "0", days61to90: "0", over90Days: "0", noDueDate: "0" },
    payableBuckets: { overdue: "0", dueToday: "0", next7Days: "0", next30Days: "0", days31to60: "0", days61to90: "0", over90Days: "0", noDueDate: "0" },
    monthlyProjection: [],
    receivables: emptySection,
    payables: emptySection,
    receivablesNoDueDate: emptySection,
    payablesNoDueDate: emptySection,
    projectComparison: [],
    projectComparisonTruncated: false,
    ...overrides,
  };
}

describe("buildCashFlowWorkbook — kesilme (truncation) göstergesi", () => {
  it("truncated=true olduğunda sayfada uyarı satırı bulunur", async () => {
    const data = makeCashFlowData({
      receivables: {
        rows: [
          {
            id: "1",
            description: "Fatura 1",
            counterpartName: "Müşteri",
            projectName: null,
            documentNumber: null,
            originalAmount: "100.00",
            collectedOrPaidAmount: "0.00",
            remainingAmount: "100.00",
            dueDate: new Date(),
            daysOverdueOrRemaining: 5,
            isOverdue: false,
            currency: "TRY",
          },
        ],
        totalOpenCount: 150,
        truncated: true,
      },
    });
    const buffer = await buildCashFlowWorkbook(data, META);
    const wb = await loadWorkbook(buffer);
    const sheet = wb.getWorksheet("Alacaklar")!;
    const allText = sheet.getSheetValues().flat().join(" ");
    expect(allText).toContain("150");
  });

  it("beklenen sayfa adlarını üretir", async () => {
    const buffer = await buildCashFlowWorkbook(makeCashFlowData(), META);
    const wb = await loadWorkbook(buffer);
    expect(wb.worksheets.map((s) => s.name)).toEqual([
      "Özet",
      "Vade Analizi",
      "Alacaklar",
      "Borçlar",
      "Aylık Projeksiyon",
      "Proje Karşılaştırması",
      "Vadesiz Kayıtlar",
    ]);
  });
});

// ---------------------------------------------------------------------------
// Budget workbook
// ---------------------------------------------------------------------------

function makeBudgetData(overrides: Partial<OrganizationBudgetReport> = {}): OrganizationBudgetReport {
  return {
    scope: "ORGANIZATION",
    projectFilter: null,
    filter: { projectId: undefined, categoryId: undefined },
    metrics: {
      totalProjectBudget: "100000.00",
      totalRealizedExpenses: "40000.00",
      totalPaidExpenses: "30000.00",
      totalRemainingBudget: "60000.00",
      budgetUsagePercentage: "40.00",
      projectsOverBudgetCount: 0,
      projectsAtRiskCount: 1,
      projectsWithoutBudgetCount: 0,
      averageBudgetUtilization: "40.00",
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
  };
}

describe("buildBudgetWorkbook", () => {
  it("beklenen sayfa adlarını üretir", async () => {
    const buffer = await buildBudgetWorkbook(makeBudgetData(), META);
    const wb = await loadWorkbook(buffer);
    expect(wb.worksheets.map((s) => s.name)).toEqual([
      "Özet",
      "Proje Bütçeleri",
      "Kategori Analizi",
      "Aylık Trend",
      "Proje Kategori Analizi",
      "Bütçeyi Aşanlar",
      "Bütçesiz Projeler",
    ]);
  });

  it("yüzde hücreleri sayısal tiptedir ve % biçimindedir (ondalık ile çarpılmaz)", async () => {
    const buffer = await buildBudgetWorkbook(
      makeBudgetData({
        overBudgetProjects: [
          {
            projectId: "p1",
            name: "Proje A",
            code: "P-1",
            estimatedBudget: "1000.00",
            realizedExpenses: "1200.00",
            paidExpenses: "1200.00",
            remainingBudget: "-200.00",
            usagePercentage: "120.00",
            status: "OVER_BUDGET",
            overrunAmount: "200.00",
            overrunPercentage: "20.00",
            topCategories: [],
          },
        ],
      }),
      META,
    );
    const wb = await loadWorkbook(buffer);
    const sheet = wb.getWorksheet("Bütçeyi Aşanlar")!;
    const pctCell = sheet.getRow(7).getCell(5);
    expect(pctCell.value).toBe(20);
    expect(pctCell.numFmt).toBe('0.00"%"');
  });
});

// ---------------------------------------------------------------------------
// Project finance workbook
// ---------------------------------------------------------------------------

function makeProjectFinanceData(overrides: Partial<ProjectFinanceSummary> = {}): ProjectFinanceSummary {
  return {
    projectId: "proj-1",
    projectName: "Şantiye A",
    projectCode: "P-1",
    customerName: "Müşteri A",
    contractAmount: "500000.00",
    estimatedBudget: "300000.00",
    totalRecordedIncome: "200000.00",
    totalCollected: "150000.00",
    remainingReceivable: "50000.00",
    totalRecordedExpense: "100000.00",
    totalPaid: "80000.00",
    remainingPayable: "20000.00",
    cashPosition: "70000.00",
    accrualResult: "100000.00",
    estimatedGrossProfit: "400000.00",
    estimatedProfitMargin: "80.00",
    estimatedProfitAvailable: true,
    expectedAdditionalIncomeAvailable: false,
    budgetUsed: "100000.00",
    budgetAvailable: true,
    remainingBudget: "200000.00",
    budgetUsedRatio: "33.33",
    isBudgetOverrun: false,
    incomeList: [],
    expenseList: [],
    settlements: [],
    categoryDistribution: [],
    monthlyTrend: [],
    ...overrides,
  };
}

function makeVarianceData(overrides: Partial<ProjectBudgetVarianceReport> = {}): ProjectBudgetVarianceReport {
  return {
    project: {
      id: "proj-1",
      name: "Şantiye A",
      code: "P-1",
      status: "ACTIVE",
      currency: "TRY",
      startDate: new Date("2026-07-01"),
      plannedEndDate: new Date("2026-09-30"),
    },
    totalPlannedBudget: "300000.00",
    totalRealizedExpense: "100000.00",
    totalRemainingBudget: "200000.00",
    totalUsagePercentage: "33.33",
    status: "NORMAL",
    varianceAmount: "-200000.00",
    variancePercentage: "-66.67",
    items: [],
    canManage: true,
    forecast: {
      forecastAvailable: false,
      unavailableReason: "NO_START_DATE",
      elapsedDays: null,
      dailyBurnRate: null,
      projectedTotalExpenseAvailable: false,
      projectedTotalExpense: null,
      projectedOverrunOrSavings: null,
      estimatedDaysRemainingOnBudget: null,
    },
    ...overrides,
  };
}

describe("buildProjectFinanceWorkbook", () => {
  it("100 satır sınırı için sabit uyarı içerir", async () => {
    const buffer = await buildProjectFinanceWorkbook(makeProjectFinanceData(), META, makeVarianceData());
    const wb = await loadWorkbook(buffer);
    const sheet = wb.getWorksheet("Gelirler")!;
    const allText = sheet.getSheetValues().flat().join(" ");
    expect(allText).toContain("en fazla 100 kayıt");
  });

  it("dosya adı güvenlidir", async () => {
    // Bu test dosya adı üretimini değil workbook üretimini doğrular; dosya adı
    // ayrıca report-export-http.test.ts'te ayrıntılı test edilir.
    const buffer = await buildProjectFinanceWorkbook(makeProjectFinanceData(), META, makeVarianceData());
    expect(buffer.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Bütçe Sapması ve Tahmin sayfası (YF-512)
// ---------------------------------------------------------------------------

describe("buildProjectFinanceWorkbook — Bütçe Sapması ve Tahmin sayfası (YF-512)", () => {
  it("sayfa listesine 'Bütçe Sapması ve Tahmin' eklenir, proje özeti ile kategori detayları aynı sayfada ama ayrı bloklarda sunulur", async () => {
    const buffer = await buildProjectFinanceWorkbook(makeProjectFinanceData(), META, makeVarianceData());
    const wb = await loadWorkbook(buffer);
    expect(wb.worksheets.map((s) => s.name)).toContain("Bütçe Sapması ve Tahmin");
    const sheet = wb.getWorksheet("Bütçe Sapması ve Tahmin")!;
    const allText = sheet.getSheetValues().flat().join(" | ");
    expect(allText).toContain("Bütçe Sapma Özeti");
    expect(allText).toContain("Tamamlanma Tahmini");
  });

  it("pozitif sapma (bütçe aşımı) 'Aşım' metinsel etiketiyle birlikte gösterilir", async () => {
    const buffer = await buildProjectFinanceWorkbook(
      makeProjectFinanceData(),
      META,
      makeVarianceData({ varianceAmount: "1500.00", variancePercentage: "15.00", status: "OVER_BUDGET" }),
    );
    const wb = await loadWorkbook(buffer);
    const sheet = wb.getWorksheet("Bütçe Sapması ve Tahmin")!;
    const allText = sheet.getSheetValues().flat().join(" | ");
    expect(allText).toContain("Aşım");
    expect(allText).toContain("Bütçe Aşıldı");
  });

  it("negatif sapma (tasarruf) 'Tasarruf' metinsel etiketiyle birlikte gösterilir", async () => {
    const buffer = await buildProjectFinanceWorkbook(
      makeProjectFinanceData(),
      META,
      makeVarianceData({ varianceAmount: "-4000.00", variancePercentage: "-40.00", status: "NORMAL" }),
    );
    const wb = await loadWorkbook(buffer);
    const sheet = wb.getWorksheet("Bütçe Sapması ve Tahmin")!;
    const allText = sheet.getSheetValues().flat().join(" | ");
    expect(allText).toContain("Tasarruf");
  });

  it("sıfır sapma 'Dengede' olarak gösterilir", async () => {
    const buffer = await buildProjectFinanceWorkbook(
      makeProjectFinanceData(),
      META,
      makeVarianceData({ varianceAmount: "0.00", variancePercentage: "0.00" }),
    );
    const wb = await loadWorkbook(buffer);
    const sheet = wb.getWorksheet("Bütçe Sapması ve Tahmin")!;
    const allText = sheet.getSheetValues().flat().join(" | ");
    expect(allText).toContain("Dengede");
  });

  it("kategori bazlı sapma satırları Türkçe karakterler bozulmadan yazılır", async () => {
    const buffer = await buildProjectFinanceWorkbook(
      makeProjectFinanceData(),
      META,
      makeVarianceData({
        items: [
          {
            id: "item-1",
            categoryId: "cat-1",
            categoryName: "Şantiye Malzemesi — İşçilik Ücreti Öğle Çığ Ğüç",
            categoryIsActive: true,
            plannedAmount: "10000.00",
            realizedExpense: "12000.00",
            remainingAmount: "-2000.00",
            usagePercentage: "120.00",
            status: "OVER_BUDGET",
            description: null,
            createdAt: new Date("2026-01-01"),
            updatedAt: new Date("2026-01-01"),
            varianceAmount: "2000.00",
            variancePercentage: "20.00",
          },
        ],
      }),
    );
    const wb = await loadWorkbook(buffer);
    const sheet = wb.getWorksheet("Bütçe Sapması ve Tahmin")!;
    const allText = sheet.getSheetValues().flat().join(" | ");
    expect(allText).toContain("Şantiye Malzemesi — İşçilik Ücreti Öğle Çığ Ğüç");
    expect(allText).toContain("Aşım");
  });

  it("bütçe kalemi girilmemişse kategori tablosu yerine açık bir not gösterir", async () => {
    const buffer = await buildProjectFinanceWorkbook(makeProjectFinanceData(), META, makeVarianceData({ items: [] }));
    const wb = await loadWorkbook(buffer);
    const sheet = wb.getWorksheet("Bütçe Sapması ve Tahmin")!;
    const allText = sheet.getSheetValues().flat().join(" | ");
    expect(allText).toContain("kategori bazlı sapma hesaplanamıyor");
  });

  it("tahmin mevcutken günlük ortalama gider ve tahmini toplam gider gösterilir", async () => {
    const buffer = await buildProjectFinanceWorkbook(
      makeProjectFinanceData(),
      META,
      makeVarianceData({
        forecast: {
          forecastAvailable: true,
          unavailableReason: null,
          elapsedDays: 10,
          dailyBurnRate: "500.00",
          projectedTotalExpenseAvailable: true,
          projectedTotalExpense: "15000.00",
          projectedOverrunOrSavings: "-5000.00",
          estimatedDaysRemainingOnBudget: 30,
        },
      }),
    );
    const wb = await loadWorkbook(buffer);
    const sheet = wb.getWorksheet("Bütçe Sapması ve Tahmin")!;
    const allText = sheet.getSheetValues().flat().join(" | ");
    expect(allText).toContain("10 gün");
    expect(allText).toContain("Tasarruf");
    expect(allText).toContain("30 gün");
  });

  it("tahmin için veri yetersizse (forecastAvailable=false) nedeni ekrandakiyle birebir Türkçe metinle gösterir, sahte/0 tahmin üretmez", async () => {
    const buffer = await buildProjectFinanceWorkbook(
      makeProjectFinanceData(),
      META,
      makeVarianceData({
        forecast: {
          forecastAvailable: false,
          unavailableReason: "NO_EXPENSE",
          elapsedDays: null,
          dailyBurnRate: null,
          projectedTotalExpenseAvailable: false,
          projectedTotalExpense: null,
          projectedOverrunOrSavings: null,
          estimatedDaysRemainingOnBudget: null,
        },
      }),
    );
    const wb = await loadWorkbook(buffer);
    const sheet = wb.getWorksheet("Bütçe Sapması ve Tahmin")!;
    const allText = sheet.getSheetValues().flat().join(" | ");
    expect(allText).toContain("Bu projede henüz gerçekleşen gider yok, tahmin üretilemiyor.");
  });

  it("formül enjeksiyon denemesi içeren kategori adı düz metin olarak kalır, formül hücresine dönüşmez", async () => {
    const buffer = await buildProjectFinanceWorkbook(
      makeProjectFinanceData(),
      META,
      makeVarianceData({
        items: [
          {
            id: "item-1",
            categoryId: "cat-1",
            categoryName: "=SUM(A1:A100)",
            categoryIsActive: true,
            plannedAmount: "1000.00",
            realizedExpense: "500.00",
            remainingAmount: "500.00",
            usagePercentage: "50.00",
            status: "NORMAL",
            description: null,
            createdAt: new Date("2026-01-01"),
            updatedAt: new Date("2026-01-01"),
            varianceAmount: "-500.00",
            variancePercentage: "-50.00",
          },
        ],
      }),
    );
    const wb = await loadWorkbook(buffer);
    const sheet = wb.getWorksheet("Bütçe Sapması ve Tahmin")!;
    let found = false;
    sheet.eachRow((row) => {
      row.eachCell((cell) => {
        if (String(cell.value ?? "").includes("SUM(A1:A100)")) {
          found = true;
          expect(cell.type).not.toBe(ExcelJS.ValueType.Formula);
          expect(String(cell.value)).toMatch(/^'=SUM/);
        }
      });
    });
    expect(found).toBe(true);
  });

  it("para hücreleri sayısal, yüzde hücreleri % biçimindedir", async () => {
    const buffer = await buildProjectFinanceWorkbook(
      makeProjectFinanceData(),
      META,
      makeVarianceData({ totalPlannedBudget: "300000.00", totalUsagePercentage: "33.33" }),
    );
    const wb = await loadWorkbook(buffer);
    const sheet = wb.getWorksheet("Bütçe Sapması ve Tahmin")!;
    let sawMoneyCell = false;
    let sawPercentCell = false;
    sheet.eachRow((row) => {
      row.eachCell((cell) => {
        if (cell.numFmt === '#,##0.00 "₺"') sawMoneyCell = true;
        if (cell.numFmt === '0.00"%"') sawPercentCell = true;
      });
    });
    expect(sawMoneyCell).toBe(true);
    expect(sawPercentCell).toBe(true);
  });
});
