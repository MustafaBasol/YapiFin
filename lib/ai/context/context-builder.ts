import type { SessionUser } from "@/lib/auth/session";
import { getProjectFinanceSummary, type ProjectFinanceSummary } from "@/server/services/project-finance-service";
import { getProjectBudgetVarianceReport, type ProjectBudgetVarianceReport } from "@/server/services/project-budget-variance-service";
import { getCashFlowReport, type CashFlowReport } from "@/server/services/cash-flow-report-service";
import { getDashboardData, type DashboardData } from "@/server/services/dashboard-service";
import { cashFlowFilterSchema } from "@/lib/validation/reports";
import { dashboardFilterSchema } from "@/lib/validation/dashboard";
import { aiContextRequestSchema, type AiContextRequest, type AiContextSource } from "@/lib/validation/ai";
import { createAiCorrelationId } from "@/lib/ai/correlation";
import type {
  AiContextItem,
  AiContextResult,
  AiProjectSummaryContext,
  AiBudgetVarianceContext,
  AiCashFlowContext,
  AiReceivablesPayablesContext,
  AiCompanyFinancialSummaryContext,
} from "@/lib/ai/context/types";

/**
 * YF-701 — Tenant kapsamlı, salt-okunur AI bağlam oluşturucu.
 *
 * Bu fonksiyon KASITLI OLARAK Prisma'ya doğrudan erişmez ve serbest bir sorgu
 * arayüzü sunmaz — yalnızca mevcut, zaten tenant/rol kapsamlı rapor
 * servislerini (project-finance-service, project-budget-variance-service,
 * cash-flow-report-service, dashboard-service) `actor: SessionUser` ile
 * çağırır. Bu servisler cross-tenant/yetkisiz proje erişimini kendi
 * `getProjectForUser` çağrılarıyla zaten fail-closed reddeder (bkz.
 * server/services/project-service.ts) — bu koruma burada TEKRARLANMAZ,
 * yalnızca güvenilir.
 *
 * `actor.organizationId` DIŞINDA hiçbir kaynaktan (istek gövdesi, AI
 * prompt'u) bir organizationId/tenant kimliği KABUL EDİLMEZ — bkz. görev
 * talimatı "Do not trust tenant IDs supplied by AI prompts".
 */
export async function buildAiContext(actor: SessionUser, rawRequest: AiContextRequest): Promise<AiContextResult> {
  // Allow-list doğrulaması: bilinmeyen/geçersiz bir `sources` değeri (ör.
  // tip sistemini atlayan bir çağıran) burada fırlatır — context builder
  // asla tanımadığı bir kaynak için servis çağırmaz.
  const request = aiContextRequestSchema.parse(rawRequest);
  const uniqueSources = Array.from(new Set(request.sources));

  let cashFlowReportPromise: Promise<CashFlowReport> | null = null;
  function resolveCashFlowReport(): Promise<CashFlowReport> {
    if (!cashFlowReportPromise) {
      const filter = cashFlowFilterSchema.parse({ projectId: request.projectId });
      cashFlowReportPromise = getCashFlowReport(actor, filter);
    }
    return cashFlowReportPromise;
  }

  function requireProjectId(): string {
    // `aiContextRequestSchema.superRefine` bunu zaten garanti eder — bu
    // yalnızca ikinci, savunma amaçlı bir kontroldür.
    if (!request.projectId) {
      throw new Error("Bu bağlam kaynağı için projectId zorunludur");
    }
    return request.projectId;
  }

  const items: AiContextItem[] = [];
  for (const source of uniqueSources) {
    items.push(await buildContextItem(source, actor, requireProjectId, resolveCashFlowReport));
  }

  return {
    correlationId: createAiCorrelationId(),
    organizationId: actor.organizationId,
    items,
  };
}

async function buildContextItem(
  source: AiContextSource,
  actor: SessionUser,
  requireProjectId: () => string,
  resolveCashFlowReport: () => Promise<CashFlowReport>,
): Promise<AiContextItem> {
  switch (source) {
    case "PROJECT_SUMMARY": {
      const summary = await getProjectFinanceSummary(actor, requireProjectId());
      return toProjectSummaryContext(summary);
    }
    case "BUDGET_VARIANCE": {
      const projectId = requireProjectId();
      const report = await getProjectBudgetVarianceReport(actor, projectId);
      return toBudgetVarianceContext(report, projectId);
    }
    case "CASH_FLOW": {
      const report = await resolveCashFlowReport();
      return toCashFlowContext(report);
    }
    case "RECEIVABLES_PAYABLES": {
      const report = await resolveCashFlowReport();
      return toReceivablesPayablesContext(report);
    }
    case "COMPANY_FINANCIAL_SUMMARY": {
      const dashboard = await getDashboardData(actor, dashboardFilterSchema.parse({ period: "CURRENT_MONTH" }));
      return toCompanyFinancialSummaryContext(dashboard);
    }
    default: {
      const exhaustiveCheck: never = source;
      throw new Error(`Bilinmeyen AI bağlam kaynağı: ${String(exhaustiveCheck)}`);
    }
  }
}

function toProjectSummaryContext(summary: ProjectFinanceSummary): AiProjectSummaryContext {
  return {
    source: "PROJECT_SUMMARY",
    projectId: summary.projectId,
    projectName: summary.projectName,
    projectCode: summary.projectCode,
    contractAmount: summary.contractAmount,
    estimatedBudget: summary.estimatedBudget,
    totalRecordedIncome: summary.totalRecordedIncome,
    totalCollected: summary.totalCollected,
    remainingReceivable: summary.remainingReceivable,
    totalRecordedExpense: summary.totalRecordedExpense,
    totalPaid: summary.totalPaid,
    remainingPayable: summary.remainingPayable,
    cashPosition: summary.cashPosition,
    accrualResult: summary.accrualResult,
    budgetUsed: summary.budgetUsed,
    remainingBudget: summary.remainingBudget,
    isBudgetOverrun: summary.isBudgetOverrun,
  };
}

function toBudgetVarianceContext(report: ProjectBudgetVarianceReport, projectId: string): AiBudgetVarianceContext {
  return {
    source: "BUDGET_VARIANCE",
    projectId,
    status: report.status,
    totalPlannedBudget: report.totalPlannedBudget,
    totalRealizedExpense: report.totalRealizedExpense,
    totalRemainingBudget: report.totalRemainingBudget,
    totalUsagePercentage: report.totalUsagePercentage,
    varianceAmount: report.varianceAmount,
    variancePercentage: report.variancePercentage,
    categories: report.items.map((item) => ({
      categoryName: item.categoryName,
      plannedAmount: item.plannedAmount,
      realizedExpense: item.realizedExpense,
      varianceAmount: item.varianceAmount,
      variancePercentage: item.variancePercentage,
    })),
  };
}

function toCashFlowContext(report: CashFlowReport): AiCashFlowContext {
  return {
    source: "CASH_FLOW",
    scope: report.scope,
    rangeStart: report.rangeStart.toISOString(),
    rangeEnd: report.rangeEnd.toISOString(),
    realizedCollections: report.summary.realizedCollections,
    realizedPayments: report.summary.realizedPayments,
    realizedNet: report.summary.realizedNet,
    scheduledCollections: report.summary.scheduledCollections,
    scheduledPayments: report.summary.scheduledPayments,
    scheduledNet: report.summary.scheduledNet,
    monthlyProjection: report.monthlyProjection.map((p) => ({
      label: p.label,
      scheduledIn: p.scheduledIn,
      scheduledOut: p.scheduledOut,
      net: p.net,
    })),
  };
}

function toReceivablesPayablesContext(report: CashFlowReport): AiReceivablesPayablesContext {
  return {
    source: "RECEIVABLES_PAYABLES",
    scope: report.scope,
    receivableBuckets: report.receivableBuckets,
    payableBuckets: report.payableBuckets,
  };
}

function toCompanyFinancialSummaryContext(dashboard: DashboardData): AiCompanyFinancialSummaryContext {
  return {
    source: "COMPANY_FINANCIAL_SUMMARY",
    scope: dashboard.scope,
    period: dashboard.period,
    collectedIncome: dashboard.kpis.collectedIncome,
    paidExpense: dashboard.kpis.paidExpense,
    netCashFlow: dashboard.kpis.netCashFlow,
    openReceivable: dashboard.kpis.openReceivable,
    overdueReceivable: dashboard.kpis.overdueReceivable,
    openPayable: dashboard.kpis.openPayable,
    overduePayable: dashboard.kpis.overduePayable,
    cashAndBankBalance: dashboard.scope === "ORGANIZATION" ? dashboard.kpis.cashAndBankBalance : null,
    activeProjectCount: dashboard.kpis.activeProjectCount,
    totalProjectCount: dashboard.kpis.totalProjectCount,
    budgetCriticalProjectCount: dashboard.kpis.budgetCriticalProjectCount,
  };
}
