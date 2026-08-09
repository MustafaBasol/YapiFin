import { describe, it, expect, vi } from "vitest";
import type { SessionUser } from "@/lib/auth/session";
import type { BudgetReport } from "@/server/services/budget-report-service";
import type { OrganizationCashFlowReport, ProjectCashFlowRow } from "@/server/services/cash-flow-report-service";

/**
 * YF-702 review fix — `extractFinancialSignals` içindeki en yüksek vadesi
 * geçen alacağa sahip ilk 5 projeyi seçen sıralama daha önce `Number()`
 * dönüşümüyle karşılaştırma yapıyordu. IEEE-754 double, "100000000000000.01"
 * ve "100000000000000.02" gibi yüksek hassasiyetli TL tutarlarını AYNI
 * kayan noktalı değere yuvarlar (bkz. aşağıdaki `TRUE_LARGER`/`TRUE_SMALLER`
 * sabitleri) — bu da `Number()` tabanlı karşılaştırmayı ilişkisiz `Prisma.Decimal`
 * girdileri için "eşit" (0) döndürmeye zorlar. `Array.prototype.sort` kararlı
 * olduğundan bu sahte eşitlik, orijinal dizi sırasına bağlı olarak yanlış
 * projenin ilk 5'e (top 5) girmesine yol açabilir. Bu test, Decimal-güvenli
 * karşılaştırmanın (`toDecimal(...).comparedTo(...)`) bu tür girdilerde bile
 * gerçek ondalık sırayı koruduğunu doğrular.
 */

vi.mock("@/server/services/budget-report-service", () => ({
  getBudgetReport: vi.fn(),
}));
vi.mock("@/server/services/cash-flow-report-service", () => ({
  getCashFlowReport: vi.fn(),
}));

import { getBudgetReport } from "@/server/services/budget-report-service";
import { getCashFlowReport } from "@/server/services/cash-flow-report-service";
import { extractFinancialSignals } from "@/server/services/ai-insights-service";

const actor: SessionUser = {
  id: "user-1",
  organizationId: "org-1",
  firstName: "Test",
  lastName: "Owner",
  email: "owner@example.com",
  role: "OWNER",
  status: "ACTIVE",
  emailVerifiedAt: new Date(),
  organizationName: "Test Organizasyonu",
};

// Number("100000000000000.01") === Number("100000000000000.02") === 100000000000000.02
// (17 anlamlı basamak, double hassasiyet sınırının ötesinde) — bkz. modül başlığı.
const TRUE_LARGER = "100000000000000.02";
const TRUE_SMALLER = "100000000000000.01";

function emptyBudgetReport(): BudgetReport {
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
  };
}

function projectRow(projectId: string, overdueReceivable: string): ProjectCashFlowRow {
  return {
    projectId,
    name: `Proje ${projectId}`,
    code: projectId.toUpperCase(),
    scheduledInflow: "0",
    scheduledOutflow: "0",
    projectedNet: "0",
    overdueReceivable,
    overduePayable: "0",
  };
}

function cashFlowReportWith(projectComparison: ProjectCashFlowRow[]): OrganizationCashFlowReport {
  const zeroBuckets = {
    overdue: "0",
    dueToday: "0",
    next7Days: "0",
    next30Days: "0",
    days31to60: "0",
    days61to90: "0",
    over90Days: "0",
    noDueDate: "0",
  };
  return {
    scope: "ORGANIZATION",
    filter: {} as never,
    rangeStart: new Date(),
    rangeEnd: new Date(),
    projectFilter: null,
    openingBalance: "1000",
    projectedClosingBalance: "1000",
    projectedClosingBalanceIsEstimate: true,
    summary: {
      realizedCollections: "0",
      realizedPayments: "0",
      realizedNet: "0",
      scheduledCollections: "0",
      scheduledPayments: "0",
      scheduledNet: "0",
    },
    receivableBuckets: zeroBuckets,
    payableBuckets: zeroBuckets,
    monthlyProjection: [],
    receivables: { rows: [], totalOpenCount: 0, truncated: false },
    payables: { rows: [], totalOpenCount: 0, truncated: false },
    receivablesNoDueDate: { rows: [], totalOpenCount: 0, truncated: false },
    payablesNoDueDate: { rows: [], totalOpenCount: 0, truncated: false },
    projectComparison,
    projectComparisonTruncated: false,
  };
}

describe("extractFinancialSignals — vadesi geçen alacak sıralaması (Decimal invariant)", () => {
  it("Number() ile çakışan yüksek hassasiyetli tutarlarda gerçek ondalık sırayı korur (top-5 sınırında)", async () => {
    vi.mocked(getBudgetReport).mockResolvedValue(emptyBudgetReport());

    // 4 çapa proje (net biçimde 1-4. sırada, çakışmaya karışmaz) + gerçekte
    // daha büyük olan (dahil edilmeli) ile gerçekte daha küçük olan (hariç
    // tutulmalı) — ikisi de Number() altında aynı değere yuvarlanıyor.
    // `collidingSmaller` dizide `collidingLarger`'dan ÖNCE yerleştirildi ki
    // eski `Number()` tabanlı kıyaslayıcı (sahte eşitlik nedeniyle kararlı
    // sıralamayla orijinal sırayı koruyacağı için) yanlış projeyi ilk 5'e
    // sokmuş olsun; Decimal-güvenli kıyaslayıcı girdi sırasından bağımsız
    // olarak doğru sonucu vermelidir.
    const anchors = [
      projectRow("anchor-1", "900000000000000000"),
      projectRow("anchor-2", "800000000000000000"),
      projectRow("anchor-3", "700000000000000000"),
      projectRow("anchor-4", "600000000000000000"),
    ];
    const collidingSmaller = projectRow("true-rank6-excluded", TRUE_SMALLER);
    const collidingLarger = projectRow("true-rank5-included", TRUE_LARGER);

    expect(Number(TRUE_LARGER)).toBe(Number(TRUE_SMALLER));
    expect(TRUE_LARGER).not.toBe(TRUE_SMALLER);

    vi.mocked(getCashFlowReport).mockResolvedValue(
      cashFlowReportWith([anchors[0], anchors[1], collidingSmaller, anchors[2], collidingLarger, anchors[3]]),
    );

    const signals = await extractFinancialSignals(actor);
    const includedProjectIds = new Set(
      signals.filter((s) => s.type === "OVERDUE_RECEIVABLES" && s.affectedProjectId).map((s) => s.affectedProjectId),
    );

    expect(includedProjectIds.has("true-rank5-included")).toBe(true);
    expect(includedProjectIds.has("true-rank6-excluded")).toBe(false);
    expect(includedProjectIds.size).toBe(5);
  });
});
