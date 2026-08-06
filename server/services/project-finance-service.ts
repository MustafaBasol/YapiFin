import type { SettlementType, TransactionStatus, TransactionType } from "@prisma/client";
import { db } from "@/lib/db";
import { getProjectForUser } from "@/server/services/project-service";
import { attachComputed } from "@/server/services/transaction-service";
import { toDecimal, ZERO } from "@/server/services/ledger";
import { buildMonthLabels, bucketByMonth, getDateRange } from "@/server/services/dashboard-service";
import type { SessionUser } from "@/lib/auth/session";

/**
 * YF-402 — Proje kârlılığı ve nakit görünümü. Tenant ve PROJECT_MANAGER
 * kapsam kontrolü `getProjectForUser` üzerinden yapılır (aynı "cross-tenant
 * veya atanmamış proje → NOT_FOUND" davranışı, bkz. server/services/project-service.ts).
 *
 * Üç ayrı kâr kavramı kasıtlı olarak birbirinden ayrılır:
 * 1. Nakit Pozisyonu = Tahsil edilen - Ödenen (yalnızca gerçek para hareketi)
 * 2. Tahakkuk Bazlı Sonuç = Kaydedilen gelir - Kaydedilen gider (iptal
 *    edilmemiş FinancialTransaction kayıtları; tahsil/ödeme durumundan
 *    bağımsız, faturalanmış/tahakkuk etmiş tutar)
 * 3. Tahmini Brüt Kâr = Sözleşme bedeli - Kaydedilen gider (yalnızca
 *    sözleşme bedeli > 0 ise hesaplanır; bu bir TAHMİNdir, gerçekleşen kâr
 *    olarak sunulmaz). Mevcut şema "beklenen ek gelir" için ayrı bir alan
 *    içermediğinden (yalnızca contractAmount ve estimatedBudget var), bu
 *    metrik açıkça desteklenmeyen (unavailable) olarak işaretlenir —
 *    veri uydurulmaz (bkz. görev talimatları).
 *
 * İptal edilmiş FinancialTransaction kayıtları ve iptal edilmiş (CANCELLED)
 * Settlement'lar tüm toplamlardan hariç tutulur; ters kayıt (REVERSAL)
 * hareketleri settlement.status='ACTIVE' filtresi sayesinde çift sayılmaz.
 */

const MONTHLY_TREND_MONTHS = "LAST_12_MONTHS" as const;
const INCOME_EXPENSE_LIST_LIMIT = 100;
const SETTLEMENT_LIST_LIMIT = 20;
const BUDGET_CRITICAL_RATIO = 0.8;

export interface ProjectTransactionRow {
  id: string;
  description: string;
  counterpartName: string | null;
  categoryName: string;
  totalAmount: string;
  remainingAmount: string;
  dueDate: Date | null;
  issueDate: Date;
  status: TransactionStatus;
  currency: string;
}

export interface ProjectSettlementRow {
  id: string;
  type: SettlementType;
  amount: string;
  settlementDate: Date;
  accountName: string;
  relatedDescription: string;
  transactionType: TransactionType;
}

export interface ProjectCategorySlice {
  categoryId: string;
  name: string;
  amount: string;
}

export interface ProjectMonthlyPoint {
  key: string;
  label: string;
  income: number;
  expense: number;
}

export interface ProjectFinanceSummary {
  projectId: string;
  projectName: string;
  projectCode: string;
  customerName: string | null;

  contractAmount: string;
  estimatedBudget: string;

  totalRecordedIncome: string;
  totalCollected: string;
  remainingReceivable: string;

  totalRecordedExpense: string;
  totalPaid: string;
  remainingPayable: string;

  cashPosition: string;
  accrualResult: string;

  estimatedGrossProfit: string | null;
  estimatedProfitMargin: string | null;
  estimatedProfitAvailable: boolean;

  expectedAdditionalIncomeAvailable: false;

  budgetUsed: string;
  budgetAvailable: boolean;
  remainingBudget: string;
  budgetUsedRatio: string | null;
  isBudgetOverrun: boolean;

  incomeList: ProjectTransactionRow[];
  expenseList: ProjectTransactionRow[];
  settlements: ProjectSettlementRow[];
  categoryDistribution: ProjectCategorySlice[];
  monthlyTrend: ProjectMonthlyPoint[];
}

type ResolvedProjectForFinanceSummary = Awaited<ReturnType<typeof getProjectForUser>>;

export async function getProjectFinanceSummary(
  actor: SessionUser,
  projectId: string,
): Promise<ProjectFinanceSummary> {
  const project = await getProjectForUser(actor, projectId);
  return getProjectFinanceSummaryForResolvedProject(actor, project);
}

/**
 * Proje erişim kapsamı daha önce getProjectForUser ile doğrulanmış çağrılar için
 * finans özetini ikinci bir proje sorgusu yapmadan üretir.
 */
export async function getProjectFinanceSummaryForResolvedProject(
  actor: SessionUser,
  project: ResolvedProjectForFinanceSummary,
): Promise<ProjectFinanceSummary> {
  const seriesRange = getDateRange(MONTHLY_TREND_MONTHS, new Date());
  const months = buildMonthLabels(seriesRange);

  const [incomeRecords, expenseRecords, categoryGroups, monthlyRecords] = await Promise.all([
    db.financialTransaction.findMany({
      where: { organizationId: actor.organizationId, projectId: project.id, type: "INCOME" },
      orderBy: { issueDate: "desc" },
      take: INCOME_EXPENSE_LIST_LIMIT,
      include: { category: true, customer: true },
    }),
    db.financialTransaction.findMany({
      where: { organizationId: actor.organizationId, projectId: project.id, type: "EXPENSE" },
      orderBy: { issueDate: "desc" },
      take: INCOME_EXPENSE_LIST_LIMIT,
      include: { category: true, supplier: true },
    }),
    db.financialTransaction.groupBy({
      by: ["categoryId"],
      where: { organizationId: actor.organizationId, projectId: project.id, type: "EXPENSE", status: { not: "CANCELLED" } },
      _sum: { totalAmount: true },
    }),
    db.financialTransaction.findMany({
      where: {
        organizationId: actor.organizationId,
        projectId: project.id,
        status: { not: "CANCELLED" },
        issueDate: { gte: seriesRange.start, lt: seriesRange.end },
      },
      select: { type: true, totalAmount: true, issueDate: true },
    }),
  ]);

  // Tüm proje toplamları (limit'e bağlı olmayan, tam) gruplu agregatlarla
  // ayrıca hesaplanır — liste görünümü sayfalanmış/sınırlı olsa bile KPI'lar
  // her zaman doğru toplamı yansıtır.
  const [incomeAgg, expenseAgg] = await Promise.all([
    db.financialTransaction.aggregate({
      where: { organizationId: actor.organizationId, projectId: project.id, type: "INCOME", status: { not: "CANCELLED" } },
      _sum: { totalAmount: true },
    }),
    db.financialTransaction.aggregate({
      where: { organizationId: actor.organizationId, projectId: project.id, type: "EXPENSE", status: { not: "CANCELLED" } },
      _sum: { totalAmount: true },
    }),
  ]);

  const [collectedAgg, paidAgg] = await Promise.all([
    db.settlement.aggregate({
      where: {
        organizationId: actor.organizationId,
        status: "ACTIVE",
        type: "COLLECTION",
        transaction: { projectId: project.id },
      },
      _sum: { amount: true },
    }),
    db.settlement.aggregate({
      where: {
        organizationId: actor.organizationId,
        status: "ACTIVE",
        type: "PAYMENT",
        transaction: { projectId: project.id },
      },
      _sum: { amount: true },
    }),
  ]);

  const settlementRows = await db.settlement.findMany({
    where: { organizationId: actor.organizationId, transaction: { projectId: project.id }, status: "ACTIVE" },
    orderBy: { settlementDate: "desc" },
    take: SETTLEMENT_LIST_LIMIT,
    include: { financialAccount: { select: { name: true } }, transaction: { select: { description: true, type: true } } },
  });

  const totalRecordedIncome = toDecimal(incomeAgg._sum.totalAmount ?? ZERO);
  const totalRecordedExpense = toDecimal(expenseAgg._sum.totalAmount ?? ZERO);
  const totalCollected = toDecimal(collectedAgg._sum.amount ?? ZERO);
  const totalPaid = toDecimal(paidAgg._sum.amount ?? ZERO);

  const remainingReceivable = totalRecordedIncome.minus(totalCollected);
  const remainingPayable = totalRecordedExpense.minus(totalPaid);
  const cashPosition = totalCollected.minus(totalPaid);
  const accrualResult = totalRecordedIncome.minus(totalRecordedExpense);

  const contractAmount = toDecimal(project.contractAmount);
  const estimatedBudget = toDecimal(project.estimatedBudget);

  const estimatedProfitAvailable = contractAmount.greaterThan(ZERO);
  const estimatedGrossProfit = estimatedProfitAvailable ? contractAmount.minus(totalRecordedExpense) : null;
  const estimatedProfitMargin =
    estimatedProfitAvailable && estimatedGrossProfit
      ? estimatedGrossProfit.div(contractAmount).mul(100).toDecimalPlaces(2).toString()
      : null;

  const budgetAvailable = estimatedBudget.greaterThan(ZERO);
  const remainingBudget = estimatedBudget.minus(totalRecordedExpense);
  const budgetUsedRatio = budgetAvailable ? totalRecordedExpense.div(estimatedBudget).mul(100).toDecimalPlaces(2).toString() : null;
  const isBudgetOverrun = budgetAvailable && totalRecordedExpense.greaterThan(estimatedBudget);
  void BUDGET_CRITICAL_RATIO; // eşik org dashboard'unda (dashboard-service.ts) uygulanır; burada yalnızca aşım durumu gösterilir.

  const [computedIncome, computedExpense] = await Promise.all([attachComputed(incomeRecords), attachComputed(expenseRecords)]);

  const incomeList: ProjectTransactionRow[] = computedIncome.map((r) => ({
    id: r.id,
    description: r.description,
    counterpartName: r.customer?.name ?? null,
    categoryName: r.category.name,
    totalAmount: r.totalAmount.toString(),
    remainingAmount: r.remainingAmount.toString(),
    dueDate: r.dueDate,
    issueDate: r.issueDate,
    status: r.status,
    currency: r.currency,
  }));
  const expenseList: ProjectTransactionRow[] = computedExpense.map((r) => ({
    id: r.id,
    description: r.description,
    counterpartName: r.supplier?.name ?? null,
    categoryName: r.category.name,
    totalAmount: r.totalAmount.toString(),
    remainingAmount: r.remainingAmount.toString(),
    dueDate: r.dueDate,
    issueDate: r.issueDate,
    status: r.status,
    currency: r.currency,
  }));

  const categoryNameMap = new Map(
    (
      categoryGroups.length
        ? await db.transactionCategory.findMany({
            where: { id: { in: categoryGroups.map((g) => g.categoryId) } },
            select: { id: true, name: true },
          })
        : []
    ).map((c) => [c.id, c.name]),
  );
  const categoryDistribution: ProjectCategorySlice[] = categoryGroups
    .map((g) => ({
      categoryId: g.categoryId,
      name: categoryNameMap.get(g.categoryId) ?? "Diğer",
      amount: toDecimal(g._sum.totalAmount ?? ZERO).toString(),
    }))
    .sort((a, b) => Number(b.amount) - Number(a.amount));

  const incomeMonthlyRows = monthlyRecords.filter((r) => r.type === "INCOME").map((r) => ({ amount: r.totalAmount, date: r.issueDate }));
  const expenseMonthlyRows = monthlyRecords.filter((r) => r.type === "EXPENSE").map((r) => ({ amount: r.totalAmount, date: r.issueDate }));
  const incomeBuckets = bucketByMonth(incomeMonthlyRows, months);
  const expenseBuckets = bucketByMonth(expenseMonthlyRows, months);
  const monthlyTrend: ProjectMonthlyPoint[] = months.map((m, i) => ({
    key: m.key,
    label: m.label,
    income: Number(incomeBuckets[i].toFixed(2)),
    expense: Number(expenseBuckets[i].toFixed(2)),
  }));

  const settlements: ProjectSettlementRow[] = settlementRows.map((s) => ({
    id: s.id,
    type: s.type,
    amount: toDecimal(s.amount).toString(),
    settlementDate: s.settlementDate,
    accountName: s.financialAccount.name,
    relatedDescription: s.transaction.description,
    transactionType: s.transaction.type,
  }));

  return {
    projectId: project.id,
    projectName: project.name,
    projectCode: project.code,
    customerName: project.customer?.name ?? null,

    contractAmount: contractAmount.toString(),
    estimatedBudget: estimatedBudget.toString(),

    totalRecordedIncome: totalRecordedIncome.toString(),
    totalCollected: totalCollected.toString(),
    remainingReceivable: remainingReceivable.toString(),

    totalRecordedExpense: totalRecordedExpense.toString(),
    totalPaid: totalPaid.toString(),
    remainingPayable: remainingPayable.toString(),

    cashPosition: cashPosition.toString(),
    accrualResult: accrualResult.toString(),

    estimatedGrossProfit: estimatedGrossProfit?.toString() ?? null,
    estimatedProfitMargin,
    estimatedProfitAvailable,

    expectedAdditionalIncomeAvailable: false,

    budgetUsed: totalRecordedExpense.toString(),
    budgetAvailable,
    remainingBudget: remainingBudget.toString(),
    budgetUsedRatio,
    isBudgetOverrun,

    incomeList,
    expenseList,
    settlements,
    categoryDistribution,
    monthlyTrend,
  };
}
