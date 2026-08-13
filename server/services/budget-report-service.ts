import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { toDecimal, ZERO } from "@/server/services/ledger";
import {
  getDateRange,
  resolveActorReportScope,
  buildMonthLabels,
  bucketByMonth,
  type ActorReportScope,
} from "@/server/services/dashboard-service";
import type { SessionUser } from "@/lib/auth/session";
import type { BudgetFilterInput } from "@/lib/validation/reports";

/**
 * YF-404 — Bütçe ve gider kategori analizleri.
 *
 * Eşik ve durum hesaplaması tek kaynaktan yürütülür (bkz. `getBudgetStatus`,
 * `BUDGET_CRITICAL_RATIO`) — YF-402'de tanıtılan %80 kritik eşiği yeniden
 * kullanılır (bkz. server/services/dashboard-service.ts
 * `computeBudgetCriticalCount`, server/services/project-finance-service.ts
 * `BUDGET_CRITICAL_RATIO`; bu iki dosya YF-401/402 kapsamında zaten
 * test edilmiş olduğundan bu görevde değiştirilmedi, ancak aynı sabiti
 * kullanır).
 *
 * "Risk" metrikleri (bütçe aşan/kritik/bütçesiz proje sayısı ve listeleri)
 * yalnızca `status = 'ACTIVE'` projeleri kapsar — dashboard'daki
 * `budgetCriticalProjectCount` ile aynı ilke, ve görev talimatı "Projects
 * without budget: list **active** projects" ifadesiyle birebir uyumludur.
 * Organizasyon toplamları (`totalProjectBudget`, `totalRealizedExpenses` vb.)
 * ise tüm proje durumlarını kapsar — tamamlanmış bir projenin harcadığı
 * bütçe hâlâ gerçek finansal veridir.
 *
 * `ProjectBudgetItem` (proje + kategori bazlı planlanan tutar) şemada zaten
 * mevcuttur (YF-402'de kasıtlı olarak bu göreve ertelenmişti — bkz.
 * docs/ARCHITECTURE.md §12). Bu servis, var olduğu proje/kategori
 * kombinasyonlarında `plannedAmount`'ı proje×kategori matrisine ekler.
 * **Kapsam dışı bırakılan karar:** bu modeli oluşturan/düzenleyen bir
 * yönetim arayüzü bu görevde eklenmedi — YF-403/404 yalnızca "rapor"
 * kapsamındadır (bkz. görev talimatları "Implement ... analysis using
 * *existing* ... data"); bütçe planlama/tahsis arayüzü doğal bir sonraki
 * görev olarak ayrıca raporlanmalıdır. Kategori bazlı plan verisi hiç yoksa
 * (tipik durum, çünkü veri girecek arayüz yok) matris yalnızca gerçekleşen
 * harcama dağılımı olarak sunulur — "kategori bütçe kullanımı" olarak
 * ETİKETLENMEZ (bkz. görev talimatları "Optional budget detail").
 */

export const BUDGET_CRITICAL_RATIO = 0.8;

export type BudgetStatus = "NORMAL" | "CRITICAL" | "OVER_BUDGET" | "NO_BUDGET";

export const BUDGET_STATUS_LABELS: Record<BudgetStatus, string> = {
  NORMAL: "Normal",
  CRITICAL: "Kritik",
  OVER_BUDGET: "Bütçe Aşıldı",
  NO_BUDGET: "Bütçe Girilmemiş",
};

/** Tüm UI bileşenlerinin kullanması gereken tek eşik fonksiyonu — bkz. modül başlığı. */
export function getBudgetStatus(estimatedBudget: Prisma.Decimal.Value, realizedExpense: Prisma.Decimal.Value): BudgetStatus {
  const budget = toDecimal(estimatedBudget);
  if (budget.lessThanOrEqualTo(ZERO)) return "NO_BUDGET";
  const ratio = toDecimal(realizedExpense).div(budget);
  if (ratio.greaterThanOrEqualTo(1)) return "OVER_BUDGET";
  if (ratio.greaterThanOrEqualTo(BUDGET_CRITICAL_RATIO)) return "CRITICAL";
  return "NORMAL";
}

const CATEGORY_TREND_TOP_N = 5;
const PROJECT_CATEGORY_MATRIX_LIMIT = 200;
const NO_BUDGET_LIST_LIMIT = 100;
const AT_RISK_LIST_LIMIT = 50;
const OVER_BUDGET_LIST_LIMIT = 50;
const TOP_CATEGORIES_PER_PROJECT = 3;
const RECENT_TREND_MONTHS = 3;

export interface BudgetMetrics {
  totalProjectBudget: string;
  totalRealizedExpenses: string;
  totalPaidExpenses: string;
  totalRemainingBudget: string;
  budgetUsagePercentage: string | null;
  projectsOverBudgetCount: number;
  projectsAtRiskCount: number;
  projectsWithoutBudgetCount: number;
  averageBudgetUtilization: string | null;
}

export interface ProjectBudgetRow {
  projectId: string;
  name: string;
  code: string;
  estimatedBudget: string;
  realizedExpenses: string;
  paidExpenses: string;
  remainingBudget: string;
  usagePercentage: string | null;
  status: BudgetStatus;
}

export interface CategoryAnalysisRow {
  categoryId: string;
  name: string;
  recordedExpense: string;
  paidExpense: string;
  shareOfTotal: string | null;
  projectCount: number;
  transactionCount: number;
}

export interface CategoryMonthlyTrendSeries {
  categoryId: string;
  name: string;
  points: { key: string; label: string; amount: number }[];
}

export interface ProjectCategoryRow {
  projectId: string;
  projectName: string;
  categoryId: string;
  categoryName: string;
  amount: string;
  plannedAmount: string | null;
}

export interface OverBudgetProjectRow extends ProjectBudgetRow {
  overrunAmount: string;
  overrunPercentage: string;
  topCategories: { categoryId: string; name: string; amount: string }[];
}

export interface AtRiskProjectRow extends ProjectBudgetRow {
  remainingAmount: string;
  recentTrend: { label: string; amount: number }[];
}

export interface NoBudgetProjectRow {
  projectId: string;
  name: string;
  code: string;
  status: string;
}

interface BudgetReportBase {
  filter: BudgetFilterInput;
  metrics: BudgetMetrics;
  projectComparison: ProjectBudgetRow[];
  categoryAnalysis: CategoryAnalysisRow[];
  categoryMonthlyTrend: CategoryMonthlyTrendSeries[];
  projectCategoryMatrix: ProjectCategoryRow[];
  projectCategoryMatrixTruncated: boolean;
  overBudgetProjects: OverBudgetProjectRow[];
  atRiskProjects: AtRiskProjectRow[];
  projectsWithoutBudget: NoBudgetProjectRow[];
  projectsWithoutBudgetTruncated: boolean;
}

export interface OrganizationBudgetReport extends BudgetReportBase {
  scope: "ORGANIZATION";
  projectFilter: { id: string; name: string } | null;
}

export interface ProjectManagerBudgetReport extends BudgetReportBase {
  scope: "PROJECT_MANAGER";
  projectFilter: { id: string; name: string } | null;
  hasAssignedProjects: boolean;
}

export type BudgetReport = OrganizationBudgetReport | ProjectManagerBudgetReport;

const EMPTY_METRICS: BudgetMetrics = {
  totalProjectBudget: "0",
  totalRealizedExpenses: "0",
  totalPaidExpenses: "0",
  totalRemainingBudget: "0",
  budgetUsagePercentage: null,
  projectsOverBudgetCount: 0,
  projectsAtRiskCount: 0,
  projectsWithoutBudgetCount: 0,
  averageBudgetUtilization: null,
};

interface PaidByKeyRow {
  key: string;
  paid: string;
}

/** Ödenen (aktif settlement) tutarını proje bazında tek sınırlı SQL sorgusuyla toplar. */
async function getPaidExpenseByProject(organizationId: string, projectIds?: string[]): Promise<Map<string, Prisma.Decimal>> {
  if (projectIds && projectIds.length === 0) return new Map();
  const projectFilter = projectIds ? Prisma.sql`AND ft."projectId" = ANY(${projectIds})` : Prisma.sql``;
  const rows = await db.$queryRaw<PaidByKeyRow[]>(Prisma.sql`
    SELECT ft."projectId" AS key, COALESCE(SUM(s.amount), 0)::text AS paid
    FROM "FinancialTransaction" ft
    JOIN "Settlement" s ON s."transactionId" = ft.id AND s.status = 'ACTIVE'
    WHERE ft."organizationId" = ${organizationId}
      AND ft.type = 'EXPENSE'
      AND ft.status != 'CANCELLED'
      AND ft."projectId" IS NOT NULL
      ${projectFilter}
    GROUP BY ft."projectId"
  `);
  return new Map(rows.map((r) => [r.key, toDecimal(r.paid)]));
}

/** Ödenen tutarı kategori bazında toplar — kategori analizi bölümü için. */
async function getPaidExpenseByCategory(organizationId: string, projectIds?: string[]): Promise<Map<string, Prisma.Decimal>> {
  if (projectIds && projectIds.length === 0) return new Map();
  const projectFilter = projectIds ? Prisma.sql`AND ft."projectId" = ANY(${projectIds})` : Prisma.sql``;
  const rows = await db.$queryRaw<PaidByKeyRow[]>(Prisma.sql`
    SELECT ft."categoryId" AS key, COALESCE(SUM(s.amount), 0)::text AS paid
    FROM "FinancialTransaction" ft
    JOIN "Settlement" s ON s."transactionId" = ft.id AND s.status = 'ACTIVE'
    WHERE ft."organizationId" = ${organizationId}
      AND ft.type = 'EXPENSE'
      AND ft.status != 'CANCELLED'
      ${projectFilter}
    GROUP BY ft."categoryId"
  `);
  return new Map(rows.map((r) => [r.key, toDecimal(r.paid)]));
}

function toProjectBudgetRow(
  project: { id: string; name: string; code: string; estimatedBudget: Prisma.Decimal },
  realizedExpense: Prisma.Decimal,
  paidExpense: Prisma.Decimal,
): ProjectBudgetRow {
  const estimatedBudget = toDecimal(project.estimatedBudget);
  const budgetAvailable = estimatedBudget.greaterThan(ZERO);
  return {
    projectId: project.id,
    name: project.name,
    code: project.code,
    estimatedBudget: estimatedBudget.toString(),
    realizedExpenses: realizedExpense.toString(),
    paidExpenses: paidExpense.toString(),
    remainingBudget: estimatedBudget.minus(realizedExpense).toString(),
    usagePercentage: budgetAvailable ? realizedExpense.div(estimatedBudget).mul(100).toDecimalPlaces(2).toString() : null,
    status: getBudgetStatus(estimatedBudget, realizedExpense),
  };
}

async function buildProjectCategoryMatrix(
  organizationId: string,
  projectIds: string[] | undefined,
): Promise<ProjectCategoryRow[]> {
  if (projectIds && projectIds.length === 0) return [];
  const groups = await db.financialTransaction.groupBy({
    by: ["projectId", "categoryId"],
    where: {
      organizationId,
      type: "EXPENSE",
      status: { not: "CANCELLED" },
      projectId: projectIds ? { in: projectIds } : { not: null },
    },
    _sum: { totalAmount: true },
  });
  if (groups.length === 0) return [];

  const projectIdSet = Array.from(new Set(groups.map((g) => g.projectId as string)));
  const categoryIdSet = Array.from(new Set(groups.map((g) => g.categoryId)));

  const [projects, categories, budgetItems] = await Promise.all([
    db.project.findMany({ where: { id: { in: projectIdSet } }, select: { id: true, name: true } }),
    db.transactionCategory.findMany({ where: { id: { in: categoryIdSet } }, select: { id: true, name: true } }),
    db.projectBudgetItem.findMany({
      where: { organizationId, projectId: { in: projectIdSet }, categoryId: { in: categoryIdSet } },
      select: { projectId: true, categoryId: true, plannedAmount: true },
    }),
  ]);
  const projectNameMap = new Map(projects.map((p) => [p.id, p.name]));
  const categoryNameMap = new Map(categories.map((c) => [c.id, c.name]));
  const plannedMap = new Map(budgetItems.map((b) => [`${b.projectId}:${b.categoryId}`, toDecimal(b.plannedAmount)]));

  return groups
    .map((g) => {
      const projectId = g.projectId as string;
      const planned = plannedMap.get(`${projectId}:${g.categoryId}`);
      return {
        projectId,
        projectName: projectNameMap.get(projectId) ?? "Bilinmeyen proje",
        categoryId: g.categoryId,
        categoryName: categoryNameMap.get(g.categoryId) ?? "Diğer",
        amount: toDecimal(g._sum.totalAmount ?? ZERO).toString(),
        plannedAmount: planned ? planned.toString() : null,
      };
    })
    .sort((a, b) => Number(b.amount) - Number(a.amount));
}

async function buildCategoryAnalysis(
  organizationId: string,
  projectIds: string[] | undefined,
  fullMatrix: ProjectCategoryRow[],
): Promise<CategoryAnalysisRow[]> {
  if (projectIds && projectIds.length === 0) return [];
  const [categoryGroups, paidByCategory] = await Promise.all([
    db.financialTransaction.groupBy({
      by: ["categoryId"],
      where: {
        organizationId,
        type: "EXPENSE",
        status: { not: "CANCELLED" },
        ...(projectIds ? { projectId: { in: projectIds } } : {}),
      },
      _sum: { totalAmount: true },
      _count: { _all: true },
    }),
    getPaidExpenseByCategory(organizationId, projectIds),
  ]);
  if (categoryGroups.length === 0) return [];

  const categories = await db.transactionCategory.findMany({
    where: { id: { in: categoryGroups.map((g) => g.categoryId) } },
    select: { id: true, name: true },
  });
  const nameMap = new Map(categories.map((c) => [c.id, c.name]));

  // fullMatrix zaten proje×kategori benzersiz çiftlerinin bir listesi
  // (groupBy sonucu), bu nedenle her satır o kategoriye ait ayrı bir proje
  // temsil eder — kategori başına satır sayısı = benzersiz proje sayısı.
  const projectCountMap = new Map<string, number>();
  for (const row of fullMatrix) {
    projectCountMap.set(row.categoryId, (projectCountMap.get(row.categoryId) ?? 0) + 1);
  }

  const orgTotal = categoryGroups.reduce((sum, g) => sum.plus(toDecimal(g._sum.totalAmount ?? ZERO)), ZERO);

  return categoryGroups
    .map((g) => {
      const recordedExpense = toDecimal(g._sum.totalAmount ?? ZERO);
      return {
        categoryId: g.categoryId,
        name: nameMap.get(g.categoryId) ?? "Diğer",
        recordedExpense: recordedExpense.toString(),
        paidExpense: (paidByCategory.get(g.categoryId) ?? ZERO).toString(),
        shareOfTotal: orgTotal.greaterThan(ZERO) ? recordedExpense.div(orgTotal).mul(100).toDecimalPlaces(2).toString() : null,
        projectCount: projectCountMap.get(g.categoryId) ?? 0,
        transactionCount: g._count._all,
      };
    })
    .sort((a, b) => Number(b.recordedExpense) - Number(a.recordedExpense));
}

async function buildCategoryMonthlyTrend(
  organizationId: string,
  projectIds: string[] | undefined,
  categoryAnalysis: CategoryAnalysisRow[],
  requestedCategoryId: string | undefined,
): Promise<CategoryMonthlyTrendSeries[]> {
  if (projectIds && projectIds.length === 0) return [];
  const selected = requestedCategoryId
    ? categoryAnalysis.filter((c) => c.categoryId === requestedCategoryId)
    : categoryAnalysis.slice(0, CATEGORY_TREND_TOP_N);
  if (selected.length === 0) return [];

  const range = getDateRange("LAST_12_MONTHS", new Date());
  const months = buildMonthLabels(range);
  const categoryIds = selected.map((c) => c.categoryId);

  const rows = await db.financialTransaction.findMany({
    where: {
      organizationId,
      type: "EXPENSE",
      status: { not: "CANCELLED" },
      categoryId: { in: categoryIds },
      issueDate: { gte: range.start, lt: range.end },
      ...(projectIds ? { projectId: { in: projectIds } } : {}),
    },
    select: { categoryId: true, totalAmount: true, issueDate: true },
  });

  return selected.map((c) => {
    const categoryRows = rows.filter((r) => r.categoryId === c.categoryId).map((r) => ({ amount: r.totalAmount, date: r.issueDate }));
    const buckets = bucketByMonth(categoryRows, months);
    return {
      categoryId: c.categoryId,
      name: c.name,
      points: months.map((m, i) => ({ key: m.key, label: m.label, amount: Number(buckets[i].toFixed(2)) })),
    };
  });
}

async function buildRecentTrendForProject(organizationId: string, projectId: string): Promise<{ label: string; amount: number }[]> {
  const range = getDateRange("LAST_12_MONTHS", new Date());
  const months = buildMonthLabels(range);
  const rows = await db.financialTransaction.findMany({
    where: { organizationId, projectId, type: "EXPENSE", status: { not: "CANCELLED" }, issueDate: { gte: range.start, lt: range.end } },
    select: { totalAmount: true, issueDate: true },
    take: 2000,
  });
  const buckets = bucketByMonth(
    rows.map((r) => ({ amount: r.totalAmount, date: r.issueDate })),
    months,
  );
  return months.slice(-RECENT_TREND_MONTHS).map((m, i) => {
    const idx = months.length - RECENT_TREND_MONTHS + i;
    return { label: m.label, amount: Number(buckets[idx].toFixed(2)) };
  });
}

export async function getBudgetReport(actor: SessionUser, filter: BudgetFilterInput): Promise<BudgetReport> {
  const actorScope = await resolveActorReportScope(actor, filter.projectId);
  if (actorScope.scope === "ORGANIZATION") {
    return getOrganizationBudgetReport(actor, filter, actorScope);
  }
  return getProjectManagerBudgetReport(actor, filter, actorScope);
}

async function buildBudgetReportBody(
  organizationId: string,
  filter: BudgetFilterInput,
  projectIds: string[] | undefined,
): Promise<BudgetReportBase> {
  const [projects, realizedByProject, paidByProject, fullMatrix] = await Promise.all([
    db.project.findMany({
      where: { organizationId, ...(projectIds ? { id: { in: projectIds } } : {}) },
      select: { id: true, name: true, code: true, status: true, estimatedBudget: true },
      orderBy: { code: "asc" },
    }),
    db.financialTransaction.groupBy({
      by: ["projectId"],
      where: {
        organizationId,
        type: "EXPENSE",
        status: { not: "CANCELLED" },
        projectId: projectIds ? { in: projectIds } : { not: null },
      },
      _sum: { totalAmount: true },
    }),
    getPaidExpenseByProject(organizationId, projectIds),
    buildProjectCategoryMatrix(organizationId, projectIds),
  ]);

  const realizedMap = new Map(realizedByProject.map((g) => [g.projectId as string, toDecimal(g._sum.totalAmount ?? ZERO)]));

  const projectComparison: ProjectBudgetRow[] = projects.map((p) =>
    toProjectBudgetRow(p, realizedMap.get(p.id) ?? ZERO, paidByProject.get(p.id) ?? ZERO),
  );

  // Organizasyon toplamları: tüm proje durumları (tamamlanmış dahil).
  const totalProjectBudget = projects.reduce((sum, p) => sum.plus(toDecimal(p.estimatedBudget)), ZERO);
  const totalRealizedExpenses = projectComparison.reduce((sum, r) => sum.plus(toDecimal(r.realizedExpenses)), ZERO);
  const totalPaidExpenses = projectComparison.reduce((sum, r) => sum.plus(toDecimal(r.paidExpenses)), ZERO);

  // Risk metrikleri: yalnızca ACTIVE projeler (bkz. modül başlığı notu).
  const statusByProjectId = new Map(projects.map((p) => [p.id, p.status]));
  const activeRows = projectComparison.filter((r) => statusByProjectId.get(r.projectId) === "ACTIVE");
  const budgetedActiveRows = activeRows.filter((r) => r.status !== "NO_BUDGET");
  const averageBudgetUtilization = budgetedActiveRows.length
    ? budgetedActiveRows
        .reduce((sum, r) => sum.plus(toDecimal(r.usagePercentage ?? "0")), ZERO)
        .div(budgetedActiveRows.length)
        .toDecimalPlaces(2)
        .toString()
    : null;

  const metrics: BudgetMetrics = {
    totalProjectBudget: totalProjectBudget.toString(),
    totalRealizedExpenses: totalRealizedExpenses.toString(),
    totalPaidExpenses: totalPaidExpenses.toString(),
    totalRemainingBudget: totalProjectBudget.minus(totalRealizedExpenses).toString(),
    budgetUsagePercentage: totalProjectBudget.greaterThan(ZERO)
      ? totalRealizedExpenses.div(totalProjectBudget).mul(100).toDecimalPlaces(2).toString()
      : null,
    projectsOverBudgetCount: activeRows.filter((r) => r.status === "OVER_BUDGET").length,
    projectsAtRiskCount: activeRows.filter((r) => r.status === "CRITICAL").length,
    projectsWithoutBudgetCount: activeRows.filter((r) => r.status === "NO_BUDGET").length,
    averageBudgetUtilization,
  };

  const categoryAnalysis = await buildCategoryAnalysis(organizationId, projectIds, fullMatrix);
  const categoryMonthlyTrend = await buildCategoryMonthlyTrend(organizationId, projectIds, categoryAnalysis, filter.categoryId);

  const topCategoriesByProject = new Map<string, { categoryId: string; name: string; amount: string }[]>();
  for (const row of fullMatrix) {
    const list = topCategoriesByProject.get(row.projectId) ?? [];
    if (list.length < TOP_CATEGORIES_PER_PROJECT) {
      list.push({ categoryId: row.categoryId, name: row.categoryName, amount: row.amount });
      topCategoriesByProject.set(row.projectId, list);
    }
  }

  const overBudgetSorted = activeRows
    .filter((r) => r.status === "OVER_BUDGET")
    .map((r) => {
      const overrunAmount = toDecimal(r.realizedExpenses).minus(toDecimal(r.estimatedBudget));
      const overrunPercentage = toDecimal(r.usagePercentage ?? "0").minus(100);
      return { ...r, overrunAmount: overrunAmount.toString(), overrunPercentage: overrunPercentage.toString(), topCategories: topCategoriesByProject.get(r.projectId) ?? [] };
    })
    .sort((a, b) => Number(b.overrunAmount) - Number(a.overrunAmount));
  const overBudgetProjects = overBudgetSorted.slice(0, OVER_BUDGET_LIST_LIMIT);

  const atRiskSorted = activeRows
    .filter((r) => r.status === "CRITICAL")
    .map((r) => ({ ...r, remainingAmount: toDecimal(r.estimatedBudget).minus(toDecimal(r.realizedExpenses)).toString() }))
    .sort((a, b) => Number(b.usagePercentage ?? "0") - Number(a.usagePercentage ?? "0"));
  const atRiskLimited = atRiskSorted.slice(0, AT_RISK_LIST_LIMIT);
  const atRiskProjects: AtRiskProjectRow[] = await Promise.all(
    atRiskLimited.map(async (r) => ({ ...r, recentTrend: await buildRecentTrendForProject(organizationId, r.projectId) })),
  );

  const noBudgetSorted = activeRows.filter((r) => r.status === "NO_BUDGET");
  const projectsWithoutBudget: NoBudgetProjectRow[] = noBudgetSorted
    .slice(0, NO_BUDGET_LIST_LIMIT)
    .map((r) => {
      const project = projects.find((p) => p.id === r.projectId)!;
      return { projectId: r.projectId, name: r.name, code: r.code, status: project.status };
    });

  return {
    filter,
    metrics,
    projectComparison,
    categoryAnalysis,
    categoryMonthlyTrend,
    projectCategoryMatrix: fullMatrix.slice(0, PROJECT_CATEGORY_MATRIX_LIMIT),
    projectCategoryMatrixTruncated: fullMatrix.length > PROJECT_CATEGORY_MATRIX_LIMIT,
    overBudgetProjects,
    atRiskProjects,
    projectsWithoutBudget,
    projectsWithoutBudgetTruncated: noBudgetSorted.length > projectsWithoutBudget.length,
  };
}

async function getOrganizationBudgetReport(
  actor: SessionUser,
  filter: BudgetFilterInput,
  actorScope: Extract<ActorReportScope, { scope: "ORGANIZATION" }>,
): Promise<OrganizationBudgetReport> {
  const { projectFilter, moneyScope } = actorScope;
  const body = await buildBudgetReportBody(actor.organizationId, filter, moneyScope);
  return { scope: "ORGANIZATION", projectFilter, ...body };
}

async function getProjectManagerBudgetReport(
  actor: SessionUser,
  filter: BudgetFilterInput,
  actorScope: Extract<ActorReportScope, { scope: "PROJECT_MANAGER" }>,
): Promise<ProjectManagerBudgetReport> {
  const { assignedProjectIds: assignedIds, projectFilter, moneyScope } = actorScope;

  if (assignedIds.length === 0) {
    return {
      scope: "PROJECT_MANAGER",
      filter,
      projectFilter,
      hasAssignedProjects: false,
      metrics: EMPTY_METRICS,
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

  const body = await buildBudgetReportBody(actor.organizationId, filter, moneyScope);
  return { scope: "PROJECT_MANAGER", projectFilter, hasAssignedProjects: true, ...body };
}
