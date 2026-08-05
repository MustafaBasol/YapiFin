import { Prisma } from "@prisma/client";
import type { MovementType, TransactionStatus, TransactionType } from "@prisma/client";
import { db } from "@/lib/db";
import { canViewAllProjects } from "@/lib/permissions";
import { getOpenAndOverdueTotals, toDecimal, ZERO } from "@/server/services/ledger";
import type { SessionUser } from "@/lib/auth/session";
import type { DashboardFilterInput, DashboardPeriod } from "@/lib/validation/dashboard";

/**
 * YF-401 — Şirket finans dashboardu ve YF-402 proje kârlılığı için paylaşılan
 * agregasyon servisi. Tüm parasal toplamlar Prisma.Decimal ile hesaplanır ve
 * DTO sınırında `string`'e çevrilir (bkz. CLAUDE.md "Decimal-safe
 * serialization"); yalnızca grafik veri noktaları (recharts) için `number`'a
 * dönüştürülür.
 *
 * İptal/ters kayıt kuralları:
 * - `FinancialTransaction.status = CANCELLED` olan kayıtlar tüm toplamlardan
 *   tamamen hariç tutulur.
 * - `Settlement.status != 'ACTIVE'` olan tahsilat/ödemeler (iptal edilmişler)
 *   toplanan/ödenen tutarlara dahil edilmez — ters kayıt (REVERSAL) orijinal
 *   AccountMovement'ı silmediği için çift sayım riski, settlement'ın kendisi
 *   `CANCELLED` olarak işaretlenip filtrelendiği için oluşmaz.
 * - Kasa/banka bakiyesi `AccountMovement` CREDIT-DEBIT farkından türetilir;
 *   ters kayıt hareketleri (`type: REVERSAL`) ters yönde eklendiği için ayrı
 *   bir düzeltme gerekmez.
 * - `OVERDUE`, vade tarihi geçmiş VE kalan tutar pozitif olan kayıtlar için
 *   okuma anında (canlı) türetilir; gelecekteki vadeler asla sayılmaz.
 */

const TR_OFFSET_MS = 3 * 60 * 60 * 1000; // Europe/Istanbul, DST yok (2016 sonrası sabit UTC+3)

function toIstanbul(date: Date): Date {
  return new Date(date.getTime() + TR_OFFSET_MS);
}
function fromIstanbulComponents(y: number, m: number, d: number): Date {
  return new Date(Date.UTC(y, m, d, 0, 0, 0, 0) - TR_OFFSET_MS);
}

export interface DateRange {
  start: Date;
  end: Date; // exclusive
}

export function getDateRange(period: DashboardPeriod, now: Date): DateRange {
  const ist = toIstanbul(now);
  const y = ist.getUTCFullYear();
  const m = ist.getUTCMonth();
  if (period === "CURRENT_MONTH") {
    return { start: fromIstanbulComponents(y, m, 1), end: fromIstanbulComponents(y, m + 1, 1) };
  }
  if (period === "CURRENT_YEAR") {
    return { start: fromIstanbulComponents(y, 0, 1), end: fromIstanbulComponents(y + 1, 0, 1) };
  }
  // LAST_12_MONTHS: bu ayın başlangıcından geriye doğru 12 aylık kayan pencere.
  return { start: fromIstanbulComponents(y - 1, m + 1, 1), end: fromIstanbulComponents(y, m + 1, 1) };
}

export type MonthlySeriesGranularity = "CURRENT_YEAR" | "LAST_12_MONTHS";

/**
 * Aylık trend grafikleri her zaman 12 aylık bir pencere gösterir — tek bir ay
 * için "aylık trend" anlamsız olacağından, CURRENT_MONTH seçiliyken bile bu
 * grafikler son 12 aya döner (ürün kararı; KPI kartları yine de seçilen
 * döneme göre hesaplanır).
 */
export function getMonthlySeriesGranularity(period: DashboardPeriod): MonthlySeriesGranularity {
  return period === "CURRENT_YEAR" ? "CURRENT_YEAR" : "LAST_12_MONTHS";
}

export interface MonthLabel {
  key: string;
  label: string;
  monthStart: Date;
}

export function buildMonthLabels(range: DateRange): MonthLabel[] {
  const startIst = toIstanbul(range.start);
  const y0 = startIst.getUTCFullYear();
  const m0 = startIst.getUTCMonth();
  const months: MonthLabel[] = [];
  for (let i = 0; i < 12; i++) {
    const monthStart = fromIstanbulComponents(y0, m0 + i, 1);
    const ist = toIstanbul(monthStart);
    const key = `${ist.getUTCFullYear()}-${String(ist.getUTCMonth() + 1).padStart(2, "0")}`;
    const label = new Intl.DateTimeFormat("tr-TR", { month: "short", year: "2-digit", timeZone: "Europe/Istanbul" }).format(
      monthStart,
    );
    months.push({ key, label, monthStart });
  }
  return months;
}

export function bucketByMonth(rows: { amount: Prisma.Decimal.Value; date: Date }[], months: MonthLabel[]): Prisma.Decimal[] {
  const indexByYm = new Map<number, number>();
  months.forEach((m, i) => {
    const ist = toIstanbul(m.monthStart);
    indexByYm.set(ist.getUTCFullYear() * 12 + ist.getUTCMonth(), i);
  });
  const sums = months.map(() => ZERO);
  for (const row of rows) {
    const d = toIstanbul(row.date);
    const idx = indexByYm.get(d.getUTCFullYear() * 12 + d.getUTCMonth());
    if (idx !== undefined) sums[idx] = sums[idx].plus(toDecimal(row.amount));
  }
  return sums;
}

export interface MonthlyPoint {
  key: string;
  label: string;
  collected: number;
  paid: number;
  net: number;
}

export interface CategorySlice {
  categoryId: string;
  name: string;
  amount: string;
}

export interface ProjectComparisonRow {
  projectId: string;
  name: string;
  code: string;
  income: string;
  expense: string;
  result: string;
}

export interface UpcomingItem {
  id: string;
  description: string;
  counterpartName: string | null;
  projectName: string | null;
  dueDate: Date;
  remainingAmount: string;
  currency: string;
}

export interface RecentMovement {
  id: string;
  occurredAt: Date;
  type: MovementType;
  accountName: string;
  amount: string;
  direction: "CREDIT" | "DEBIT";
  description: string;
  relatedProjectName: string | null;
}

export interface RecentProjectActivity {
  id: string;
  type: TransactionType;
  description: string;
  projectName: string;
  totalAmount: string;
  status: TransactionStatus;
  issueDate: Date;
}

interface MoneyKpis {
  collectedIncome: string;
  paidExpense: string;
  netCashFlow: string;
  openReceivable: string;
  overdueReceivable: string;
  openPayable: string;
  overduePayable: string;
}

export interface OrganizationDashboardData {
  scope: "ORGANIZATION";
  period: DashboardPeriod;
  projectFilter: { id: string; name: string } | null;
  kpis: MoneyKpis & {
    cashAndBankBalance: string;
    activeProjectCount: number;
    totalProjectCount: number;
    activeCustomerCount: number;
    activeSupplierCount: number;
    budgetCriticalProjectCount: number;
  };
  monthlySeries: MonthlyPoint[];
  monthlySeriesGranularity: MonthlySeriesGranularity;
  expenseCategoryDistribution: CategorySlice[];
  projectComparison: ProjectComparisonRow[];
  upcomingCollections: UpcomingItem[];
  upcomingPayments: UpcomingItem[];
  recentMovements: RecentMovement[];
}

export interface ProjectManagerDashboardData {
  scope: "PROJECT_MANAGER";
  period: DashboardPeriod;
  projectFilter: { id: string; name: string } | null;
  hasAssignedProjects: boolean;
  kpis: MoneyKpis & {
    activeProjectCount: number;
    totalProjectCount: number;
    budgetCriticalProjectCount: number;
  };
  monthlySeries: MonthlyPoint[];
  monthlySeriesGranularity: MonthlySeriesGranularity;
  expenseCategoryDistribution: CategorySlice[];
  projectComparison: ProjectComparisonRow[];
  upcomingCollections: UpcomingItem[];
  upcomingPayments: UpcomingItem[];
  recentProjectActivity: RecentProjectActivity[];
}

export type DashboardData = OrganizationDashboardData | ProjectManagerDashboardData;

async function resolveProjectFilter(
  actor: SessionUser,
  requestedProjectId: string | undefined,
  assignedProjectIds?: string[],
): Promise<{ id: string; name: string } | null> {
  if (!requestedProjectId) return null;
  const project = await db.project.findFirst({
    where: { id: requestedProjectId, organizationId: actor.organizationId },
    select: { id: true, name: true },
  });
  if (!project) return null;
  if (assignedProjectIds && !assignedProjectIds.includes(project.id)) return null;
  return project;
}

async function getSettlementTotalsForRange(organizationId: string, range: DateRange, projectIds?: string[]) {
  if (projectIds && projectIds.length === 0) return { collected: ZERO, paid: ZERO, net: ZERO };
  const groups = await db.settlement.groupBy({
    by: ["type"],
    where: {
      organizationId,
      status: "ACTIVE",
      settlementDate: { gte: range.start, lt: range.end },
      ...(projectIds ? { transaction: { projectId: { in: projectIds } } } : {}),
    },
    _sum: { amount: true },
  });
  const collected = toDecimal(groups.find((g) => g.type === "COLLECTION")?._sum.amount ?? ZERO);
  const paid = toDecimal(groups.find((g) => g.type === "PAYMENT")?._sum.amount ?? ZERO);
  return { collected, paid, net: collected.minus(paid) };
}

const UPCOMING_WINDOW_DAYS = 30;
const UPCOMING_CANDIDATE_LIMIT = 20;
const UPCOMING_RESULT_LIMIT = 8;

async function findUpcomingItems(
  organizationId: string,
  type: TransactionType,
  projectIds: string[] | undefined,
): Promise<UpcomingItem[]> {
  if (projectIds && projectIds.length === 0) return [];
  const now = new Date();
  const windowEnd = new Date(now.getTime() + UPCOMING_WINDOW_DAYS * 24 * 60 * 60 * 1000);

  const candidates = await db.financialTransaction.findMany({
    where: {
      organizationId,
      type,
      status: { not: "CANCELLED" },
      dueDate: { gte: now, lte: windowEnd },
      ...(projectIds ? { projectId: { in: projectIds } } : {}),
    },
    orderBy: { dueDate: "asc" },
    take: UPCOMING_CANDIDATE_LIMIT,
    select: {
      id: true,
      description: true,
      dueDate: true,
      totalAmount: true,
      currency: true,
      customer: { select: { name: true } },
      supplier: { select: { name: true } },
      project: { select: { name: true } },
    },
  });
  if (candidates.length === 0) return [];

  const settled = await db.settlement.groupBy({
    by: ["transactionId"],
    where: { transactionId: { in: candidates.map((c) => c.id) }, status: "ACTIVE" },
    _sum: { amount: true },
  });
  const settledMap = new Map(settled.map((s) => [s.transactionId, toDecimal(s._sum.amount ?? ZERO)]));

  return candidates
    .map((c) => ({ ...c, remaining: toDecimal(c.totalAmount).minus(settledMap.get(c.id) ?? ZERO) }))
    .filter((c) => c.remaining.greaterThan(ZERO))
    .slice(0, UPCOMING_RESULT_LIMIT)
    .map((c) => ({
      id: c.id,
      description: c.description,
      counterpartName: c.customer?.name ?? c.supplier?.name ?? null,
      projectName: c.project?.name ?? null,
      dueDate: c.dueDate as Date,
      remainingAmount: c.remaining.toString(),
      currency: c.currency,
    }));
}

interface ProjectFinanceGroupRow {
  projectId: string | null;
  _sum: { totalAmount: Prisma.Decimal | null };
}

function buildProjectComparison(
  incomeGroups: ProjectFinanceGroupRow[],
  expenseGroups: ProjectFinanceGroupRow[],
  projects: { id: string; name: string; code: string }[],
  limit: number,
): ProjectComparisonRow[] {
  const incomeMap = new Map(incomeGroups.map((g) => [g.projectId as string, toDecimal(g._sum.totalAmount ?? ZERO)]));
  const expenseMap = new Map(expenseGroups.map((g) => [g.projectId as string, toDecimal(g._sum.totalAmount ?? ZERO)]));
  const projectMap = new Map(projects.map((p) => [p.id, p]));
  const ids = new Set<string>([...incomeMap.keys(), ...expenseMap.keys()]);

  const rows = Array.from(ids).map((id) => {
    const income = incomeMap.get(id) ?? ZERO;
    const expense = expenseMap.get(id) ?? ZERO;
    const project = projectMap.get(id);
    return {
      projectId: id,
      name: project?.name ?? "Bilinmeyen proje",
      code: project?.code ?? "—",
      income: income.toString(),
      expense: expense.toString(),
      result: income.minus(expense).toString(),
    };
  });

  rows.sort((a, b) => Math.abs(Number(b.result)) - Math.abs(Number(a.result)));
  return rows.slice(0, limit);
}

function computeBudgetCriticalCount(
  projects: { id: string; status: string; estimatedBudget: Prisma.Decimal }[],
  expenseMap: Map<string, Prisma.Decimal>,
): number {
  return projects.filter((p) => {
    if (p.status !== "ACTIVE") return false;
    const budget = toDecimal(p.estimatedBudget);
    if (budget.lessThanOrEqualTo(ZERO)) return false;
    const used = expenseMap.get(p.id) ?? ZERO;
    return used.div(budget).greaterThanOrEqualTo(0.8);
  }).length;
}

async function getCategoryDistribution(
  organizationId: string,
  range: DateRange,
  projectIds: string[] | undefined,
): Promise<CategorySlice[]> {
  if (projectIds && projectIds.length === 0) return [];
  const groups = await db.financialTransaction.groupBy({
    by: ["categoryId"],
    where: {
      organizationId,
      type: "EXPENSE",
      status: { not: "CANCELLED" },
      issueDate: { gte: range.start, lt: range.end },
      ...(projectIds ? { projectId: { in: projectIds } } : {}),
    },
    _sum: { totalAmount: true },
  });
  if (groups.length === 0) return [];
  const categories = await db.transactionCategory.findMany({
    where: { id: { in: groups.map((g) => g.categoryId) } },
    select: { id: true, name: true },
  });
  const nameMap = new Map(categories.map((c) => [c.id, c.name]));
  return groups
    .map((g) => ({
      categoryId: g.categoryId,
      name: nameMap.get(g.categoryId) ?? "Diğer",
      amount: toDecimal(g._sum.totalAmount ?? ZERO).toString(),
    }))
    .sort((a, b) => Number(b.amount) - Number(a.amount));
}

async function getRecentMovements(organizationId: string, projectId: string | null): Promise<RecentMovement[]> {
  const movements = await db.accountMovement.findMany({
    where: {
      organizationId,
      ...(projectId ? { settlement: { transaction: { projectId } } } : {}),
    },
    orderBy: [{ occurredAt: "desc" }, { createdAt: "desc" }],
    take: 15,
    include: {
      financialAccount: { select: { name: true } },
      settlement: { include: { transaction: { select: { project: { select: { name: true } } } } } },
    },
  });

  return movements.map((m) => ({
    id: m.id,
    occurredAt: m.occurredAt,
    type: m.type,
    accountName: m.financialAccount.name,
    amount: toDecimal(m.amount).toString(),
    direction: m.direction,
    description: m.description,
    relatedProjectName: m.settlement?.transaction.project?.name ?? null,
  }));
}

const PROJECT_COMPARISON_LIMIT = 10;

export async function getDashboardData(actor: SessionUser, filterInput: DashboardFilterInput): Promise<DashboardData> {
  if (canViewAllProjects(actor.role)) {
    return getOrganizationDashboard(actor, filterInput);
  }
  return getProjectManagerDashboard(actor, filterInput);
}

async function getOrganizationDashboard(
  actor: SessionUser,
  filterInput: DashboardFilterInput,
): Promise<OrganizationDashboardData> {
  const period = filterInput.period;
  const now = new Date();
  const periodRange = getDateRange(period, now);
  const seriesGranularity = getMonthlySeriesGranularity(period);
  const seriesRange = getDateRange(seriesGranularity, now);

  const projectFilter = await resolveProjectFilter(actor, filterInput.projectId);
  // "moneyScope" — proje filtresi yalnızca parasal toplamları, aylık seriyi,
  // kategori dağılımını, yaklaşanlar listesini ve son hareketleri daraltır.
  // Kasa/banka bakiyesi, aktif proje/müşteri/tedarikçi sayıları, bütçe-kritik
  // proje sayısı ve proje karşılaştırması her zaman organizasyon geneli kalır
  // (bunlar tek bir projeye özgülenemeyecek kavramlardır) — görev talimatları
  // "limited and stable filter model" ilkesiyle uyumlu, kasıtlı bir tasarım
  // kararıdır.
  const moneyScope = projectFilter ? [projectFilter.id] : undefined;

  const [
    settlementTotals,
    incomeOpenOverdue,
    expenseOpenOverdue,
    accountBalanceGroups,
    activeProjectCount,
    totalProjectCount,
    activeCustomerCount,
    activeSupplierCount,
    allProjects,
    projectIncomeGroups,
    projectExpenseGroups,
    monthlySettlements,
    expenseCategoryDistribution,
    upcomingCollections,
    upcomingPayments,
    recentMovements,
  ] = await Promise.all([
    getSettlementTotalsForRange(actor.organizationId, periodRange, moneyScope),
    getOpenAndOverdueTotals(db, { organizationId: actor.organizationId, type: "INCOME", projectIds: moneyScope }),
    getOpenAndOverdueTotals(db, { organizationId: actor.organizationId, type: "EXPENSE", projectIds: moneyScope }),
    db.accountMovement.groupBy({
      by: ["direction"],
      where: { organizationId: actor.organizationId, financialAccount: { isActive: true } },
      _sum: { amount: true },
    }),
    db.project.count({ where: { organizationId: actor.organizationId, status: "ACTIVE" } }),
    db.project.count({ where: { organizationId: actor.organizationId } }),
    db.customer.count({ where: { organizationId: actor.organizationId, isActive: true } }),
    db.supplier.count({ where: { organizationId: actor.organizationId, isActive: true } }),
    db.project.findMany({
      where: { organizationId: actor.organizationId },
      select: { id: true, name: true, code: true, status: true, estimatedBudget: true },
    }),
    db.financialTransaction.groupBy({
      by: ["projectId"],
      where: { organizationId: actor.organizationId, type: "INCOME", status: { not: "CANCELLED" }, projectId: { not: null } },
      _sum: { totalAmount: true },
    }),
    db.financialTransaction.groupBy({
      by: ["projectId"],
      where: { organizationId: actor.organizationId, type: "EXPENSE", status: { not: "CANCELLED" }, projectId: { not: null } },
      _sum: { totalAmount: true },
    }),
    db.settlement.findMany({
      where: {
        organizationId: actor.organizationId,
        status: "ACTIVE",
        settlementDate: { gte: seriesRange.start, lt: seriesRange.end },
        ...(moneyScope ? { transaction: { projectId: { in: moneyScope } } } : {}),
      },
      select: { amount: true, settlementDate: true, type: true },
    }),
    getCategoryDistribution(actor.organizationId, periodRange, moneyScope),
    findUpcomingItems(actor.organizationId, "INCOME", moneyScope),
    findUpcomingItems(actor.organizationId, "EXPENSE", moneyScope),
    getRecentMovements(actor.organizationId, projectFilter?.id ?? null),
  ]);

  const cashAndBankBalance = toDecimal(accountBalanceGroups.find((g) => g.direction === "CREDIT")?._sum.amount ?? ZERO)
    .minus(toDecimal(accountBalanceGroups.find((g) => g.direction === "DEBIT")?._sum.amount ?? ZERO))
    .toString();

  const expenseByProject = new Map(
    projectExpenseGroups.map((g) => [g.projectId as string, toDecimal(g._sum.totalAmount ?? ZERO)]),
  );
  const budgetCriticalProjectCount = computeBudgetCriticalCount(allProjects, expenseByProject);
  const projectComparison = buildProjectComparison(
    projectIncomeGroups,
    projectExpenseGroups,
    allProjects,
    PROJECT_COMPARISON_LIMIT,
  );

  const months = buildMonthLabels(seriesRange);
  const collectedRows = monthlySettlements.filter((s) => s.type === "COLLECTION").map((s) => ({ amount: s.amount, date: s.settlementDate }));
  const paidRows = monthlySettlements.filter((s) => s.type === "PAYMENT").map((s) => ({ amount: s.amount, date: s.settlementDate }));
  const collectedBuckets = bucketByMonth(collectedRows, months);
  const paidBuckets = bucketByMonth(paidRows, months);
  const monthlySeries: MonthlyPoint[] = months.map((m, i) => ({
    key: m.key,
    label: m.label,
    collected: Number(collectedBuckets[i].toFixed(2)),
    paid: Number(paidBuckets[i].toFixed(2)),
    net: Number(collectedBuckets[i].minus(paidBuckets[i]).toFixed(2)),
  }));

  return {
    scope: "ORGANIZATION",
    period,
    projectFilter,
    kpis: {
      collectedIncome: settlementTotals.collected.toString(),
      paidExpense: settlementTotals.paid.toString(),
      netCashFlow: settlementTotals.net.toString(),
      openReceivable: incomeOpenOverdue.open.toString(),
      overdueReceivable: incomeOpenOverdue.overdue.toString(),
      openPayable: expenseOpenOverdue.open.toString(),
      overduePayable: expenseOpenOverdue.overdue.toString(),
      cashAndBankBalance,
      activeProjectCount,
      totalProjectCount,
      activeCustomerCount,
      activeSupplierCount,
      budgetCriticalProjectCount,
    },
    monthlySeries,
    monthlySeriesGranularity: seriesGranularity,
    expenseCategoryDistribution,
    projectComparison,
    upcomingCollections,
    upcomingPayments,
    recentMovements,
  };
}

function emptyPmDashboard(
  period: DashboardPeriod,
  projectFilter: { id: string; name: string } | null,
  seriesGranularity: MonthlySeriesGranularity,
  months: MonthLabel[],
): ProjectManagerDashboardData {
  return {
    scope: "PROJECT_MANAGER",
    period,
    projectFilter,
    hasAssignedProjects: false,
    kpis: {
      collectedIncome: "0",
      paidExpense: "0",
      netCashFlow: "0",
      openReceivable: "0",
      overdueReceivable: "0",
      openPayable: "0",
      overduePayable: "0",
      activeProjectCount: 0,
      totalProjectCount: 0,
      budgetCriticalProjectCount: 0,
    },
    monthlySeries: months.map((m) => ({ key: m.key, label: m.label, collected: 0, paid: 0, net: 0 })),
    monthlySeriesGranularity: seriesGranularity,
    expenseCategoryDistribution: [],
    projectComparison: [],
    upcomingCollections: [],
    upcomingPayments: [],
    recentProjectActivity: [],
  };
}

async function getProjectManagerDashboard(
  actor: SessionUser,
  filterInput: DashboardFilterInput,
): Promise<ProjectManagerDashboardData> {
  const period = filterInput.period;
  const now = new Date();
  const periodRange = getDateRange(period, now);
  const seriesGranularity = getMonthlySeriesGranularity(period);
  const seriesRange = getDateRange(seriesGranularity, now);
  const months = buildMonthLabels(seriesRange);

  const memberships = await db.projectMember.findMany({
    where: { organizationId: actor.organizationId, userId: actor.id },
    select: { projectId: true },
  });
  const assignedIds = memberships.map((m) => m.projectId);

  const projectFilter = await resolveProjectFilter(actor, filterInput.projectId, assignedIds);

  if (assignedIds.length === 0) {
    return emptyPmDashboard(period, projectFilter, seriesGranularity, months);
  }

  const moneyScope = projectFilter ? [projectFilter.id] : assignedIds;

  const [
    settlementTotals,
    incomeOpenOverdue,
    expenseOpenOverdue,
    activeProjectCount,
    assignedProjects,
    projectIncomeGroups,
    projectExpenseGroups,
    monthlySettlements,
    expenseCategoryDistribution,
    upcomingCollections,
    upcomingPayments,
    recentActivity,
  ] = await Promise.all([
    getSettlementTotalsForRange(actor.organizationId, periodRange, moneyScope),
    getOpenAndOverdueTotals(db, { organizationId: actor.organizationId, type: "INCOME", projectIds: moneyScope }),
    getOpenAndOverdueTotals(db, { organizationId: actor.organizationId, type: "EXPENSE", projectIds: moneyScope }),
    db.project.count({ where: { organizationId: actor.organizationId, id: { in: assignedIds }, status: "ACTIVE" } }),
    db.project.findMany({
      where: { organizationId: actor.organizationId, id: { in: assignedIds } },
      select: { id: true, name: true, code: true, status: true, estimatedBudget: true },
    }),
    db.financialTransaction.groupBy({
      by: ["projectId"],
      where: { organizationId: actor.organizationId, type: "INCOME", status: { not: "CANCELLED" }, projectId: { in: assignedIds } },
      _sum: { totalAmount: true },
    }),
    db.financialTransaction.groupBy({
      by: ["projectId"],
      where: { organizationId: actor.organizationId, type: "EXPENSE", status: { not: "CANCELLED" }, projectId: { in: assignedIds } },
      _sum: { totalAmount: true },
    }),
    db.settlement.findMany({
      where: {
        organizationId: actor.organizationId,
        status: "ACTIVE",
        settlementDate: { gte: seriesRange.start, lt: seriesRange.end },
        transaction: { projectId: { in: moneyScope } },
      },
      select: { amount: true, settlementDate: true, type: true },
    }),
    getCategoryDistribution(actor.organizationId, periodRange, moneyScope),
    findUpcomingItems(actor.organizationId, "INCOME", moneyScope),
    findUpcomingItems(actor.organizationId, "EXPENSE", moneyScope),
    db.financialTransaction.findMany({
      where: { organizationId: actor.organizationId, projectId: { in: moneyScope } },
      orderBy: { updatedAt: "desc" },
      take: 10,
      select: {
        id: true,
        type: true,
        description: true,
        totalAmount: true,
        status: true,
        issueDate: true,
        project: { select: { name: true } },
      },
    }),
  ]);

  const expenseByProject = new Map(
    projectExpenseGroups.map((g) => [g.projectId as string, toDecimal(g._sum.totalAmount ?? ZERO)]),
  );
  const budgetCriticalProjectCount = computeBudgetCriticalCount(assignedProjects, expenseByProject);
  const projectComparison = buildProjectComparison(
    projectIncomeGroups,
    projectExpenseGroups,
    assignedProjects,
    PROJECT_COMPARISON_LIMIT,
  );

  const collectedRows = monthlySettlements.filter((s) => s.type === "COLLECTION").map((s) => ({ amount: s.amount, date: s.settlementDate }));
  const paidRows = monthlySettlements.filter((s) => s.type === "PAYMENT").map((s) => ({ amount: s.amount, date: s.settlementDate }));
  const collectedBuckets = bucketByMonth(collectedRows, months);
  const paidBuckets = bucketByMonth(paidRows, months);
  const monthlySeries: MonthlyPoint[] = months.map((m, i) => ({
    key: m.key,
    label: m.label,
    collected: Number(collectedBuckets[i].toFixed(2)),
    paid: Number(paidBuckets[i].toFixed(2)),
    net: Number(collectedBuckets[i].minus(paidBuckets[i]).toFixed(2)),
  }));

  return {
    scope: "PROJECT_MANAGER",
    period,
    projectFilter,
    hasAssignedProjects: true,
    kpis: {
      collectedIncome: settlementTotals.collected.toString(),
      paidExpense: settlementTotals.paid.toString(),
      netCashFlow: settlementTotals.net.toString(),
      openReceivable: incomeOpenOverdue.open.toString(),
      overdueReceivable: incomeOpenOverdue.overdue.toString(),
      openPayable: expenseOpenOverdue.open.toString(),
      overduePayable: expenseOpenOverdue.overdue.toString(),
      activeProjectCount,
      totalProjectCount: assignedIds.length,
      budgetCriticalProjectCount,
    },
    monthlySeries,
    monthlySeriesGranularity: seriesGranularity,
    expenseCategoryDistribution,
    projectComparison,
    upcomingCollections,
    upcomingPayments,
    recentProjectActivity: recentActivity.map((r) => ({
      id: r.id,
      type: r.type,
      description: r.description,
      projectName: r.project?.name ?? "—",
      totalAmount: toDecimal(r.totalAmount).toString(),
      status: r.status,
      issueDate: r.issueDate,
    })),
  };
}
