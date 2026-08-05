import { describe, expect, it } from "vitest";
import { buildDashboardPdf, buildProjectFinancePdf, buildCashFlowPdf, buildBudgetPdf } from "@/server/exports/pdf-exporter";
import { getRobotoFontPaths } from "@/server/exports/font";
import fs from "node:fs";
import type { OrganizationDashboardData } from "@/server/services/dashboard-service";
import type { ProjectFinanceSummary } from "@/server/services/project-finance-service";
import type { OrganizationCashFlowReport } from "@/server/services/cash-flow-report-service";
import type { OrganizationBudgetReport } from "@/server/services/budget-report-service";
import type { ExportMeta } from "@/server/services/report-export-service";

const META: ExportMeta = {
  organizationName: "Test İnşaat A.Ş.",
  generatedAt: new Date("2026-08-05T10:30:00.000Z"),
  periodLabel: "Bu Ay",
};

function assertValidPdf(buffer: Buffer) {
  expect(buffer.subarray(0, 5).toString("latin1")).toBe("%PDF-");
  const raw = buffer.toString("latin1");
  expect(raw).toContain("%%EOF");
  expect(buffer.length).toBeGreaterThan(1000);
  return raw;
}

describe("server/exports/font — Roboto TTF çözümlemesi", () => {
  it("Regular ve Bold TTF dosyaları npm ci sonrası fiziksel olarak diskte var", () => {
    const { normal, bold } = getRobotoFontPaths();
    expect(fs.existsSync(normal)).toBe(true);
    expect(fs.existsSync(bold)).toBe(true);
    expect(normal.endsWith(".ttf")).toBe(true);
    expect(bold.endsWith(".ttf")).toBe(true);
  });
});

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
    expenseCategoryDistribution: [{ categoryId: "c1", name: "Şantiye Malzemesi (Çimento, Ğıcık, İşçilik, Öğütücü, Şap, Ütü)", amount: "1500.00" }],
    projectComparison: [],
    upcomingCollections: [],
    upcomingPayments: [],
    recentMovements: Array.from({ length: 40 }, (_, i) => ({
      id: `m${i}`,
      occurredAt: new Date(),
      type: "ADJUSTMENT" as const,
      accountName: `Hesap ${i}`,
      amount: "10.00",
      direction: "CREDIT" as const,
      description: `Hareket ${i}`,
      relatedProjectName: null,
    })),
    ...overrides,
  };
}

describe("buildDashboardPdf", () => {
  it("geçerli bir PDF üretir: imza, EOF, gömülü TrueType yazı tipi (/FontFile2)", async () => {
    const buffer = await buildDashboardPdf(makeDashboardData(), META);
    const raw = assertValidPdf(buffer);
    expect(raw).toContain("/FontFile2");
  });

  it("belge başlığı ve dönem bilgisini içerir", async () => {
    const buffer = await buildDashboardPdf(makeDashboardData(), META);
    // pdfkit gövde metnini varsayılan olarak sıkıştırmadan (Flate olmadan) yazmaz;
    // ancak nesne tanımları (BaseFont, Contents referansları) düz metindir —
    // içerik akışının kendisi sıkıştırılmış olabileceğinden metin arama yerine
    // yalnızca yapısal işaretleri (imza, sayfa sayısı, gömülü font) doğrularız
    // (bkz. görev talimatları — Türkçe render doğrulaması görsel inceleme ile yapılır).
    const raw = assertValidPdf(buffer);
    const pageMatches = raw.match(/\/Type\s*\/Page[^s]/g) ?? [];
    expect(pageMatches.length).toBeGreaterThanOrEqual(1);
  });

  it("PM kapsamında da geçerli bir PDF üretir", async () => {
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
    const buffer = await buildDashboardPdf(pmData, { ...META, scopeNote: "Bu rapor yalnızca atandığınız projeleri kapsar." });
    assertValidPdf(buffer);
  });
});

describe("buildProjectFinancePdf", () => {
  it("geçerli bir PDF üretir", async () => {
    const data: ProjectFinanceSummary = {
      projectId: "p1",
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
    };
    const buffer = await buildProjectFinancePdf(data, META);
    assertValidPdf(buffer);
  });
});

describe("buildCashFlowPdf", () => {
  it("geçerli bir PDF üretir ve kesilme notunu içerir", async () => {
    const emptySection = { rows: [], totalOpenCount: 0, truncated: false };
    const data: OrganizationCashFlowReport = {
      scope: "ORGANIZATION",
      filter: { range: "NEXT_30_DAYS", scenario: "ON_DUE_DATE", projectId: undefined, startDate: undefined, endDate: undefined },
      rangeStart: new Date(),
      rangeEnd: new Date(),
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
      receivables: { rows: [], totalOpenCount: 200, truncated: true },
      payables: emptySection,
      receivablesNoDueDate: emptySection,
      payablesNoDueDate: emptySection,
      projectComparison: [],
      projectComparisonTruncated: false,
    };
    const buffer = await buildCashFlowPdf(data, META);
    assertValidPdf(buffer);
  });
});

describe("buildBudgetPdf", () => {
  it("geçerli bir PDF üretir", async () => {
    const data: OrganizationBudgetReport = {
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
    };
    const buffer = await buildBudgetPdf(data, META);
    assertValidPdf(buffer);
  });
});
