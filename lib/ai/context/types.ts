import type { MaturityBuckets } from "@/server/services/cash-flow-report-service";

/**
 * YF-701 — Tenant-scoped, read-only AI bağlam DTO'ları.
 *
 * Bunlar mevcut rapor servislerinin (bkz. context-builder.ts) TAM çıktısı
 * DEĞİLDİR — kasıtlı olarak daraltılmış bir alt kümedir. Özellikle satır
 * düzeyi listeler (karşı taraf adı/belge no içeren receivables/payables
 * satırları, son hareketler, yaklaşan tahsilat/ödeme listeleri) burada
 * BULUNMAZ — yalnızca AI kapasitesinin ihtiyaç duyacağı toplulaştırılmış
 * rakamlar taşınır (bkz. görev talimatı "Only include information required
 * by the requested AI capability" ve "expose unnecessary PII").
 */

export type AiContextScope = "ORGANIZATION" | "PROJECT_MANAGER";

export interface AiProjectSummaryContext {
  source: "PROJECT_SUMMARY";
  projectId: string;
  projectName: string;
  projectCode: string;
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
  budgetUsed: string;
  remainingBudget: string;
  isBudgetOverrun: boolean;
}

export interface AiBudgetVarianceCategory {
  categoryName: string;
  plannedAmount: string;
  realizedExpense: string;
  varianceAmount: string;
  variancePercentage: string | null;
}

export interface AiBudgetVarianceContext {
  source: "BUDGET_VARIANCE";
  projectId: string;
  status: string;
  totalPlannedBudget: string;
  totalRealizedExpense: string;
  totalRemainingBudget: string;
  totalUsagePercentage: string | null;
  varianceAmount: string;
  variancePercentage: string | null;
  categories: AiBudgetVarianceCategory[];
}

export interface AiCashFlowMonthlyPoint {
  label: string;
  scheduledIn: number;
  scheduledOut: number;
  net: number;
}

export interface AiCashFlowContext {
  source: "CASH_FLOW";
  scope: AiContextScope;
  rangeStart: string;
  rangeEnd: string;
  realizedCollections: string;
  realizedPayments: string;
  realizedNet: string;
  scheduledCollections: string;
  scheduledPayments: string;
  scheduledNet: string;
  monthlyProjection: AiCashFlowMonthlyPoint[];
}

export interface AiReceivablesPayablesContext {
  source: "RECEIVABLES_PAYABLES";
  scope: AiContextScope;
  receivableBuckets: MaturityBuckets;
  payableBuckets: MaturityBuckets;
}

export interface AiCompanyFinancialSummaryContext {
  source: "COMPANY_FINANCIAL_SUMMARY";
  scope: AiContextScope;
  period: string;
  collectedIncome: string;
  paidExpense: string;
  netCashFlow: string;
  openReceivable: string;
  overdueReceivable: string;
  openPayable: string;
  overduePayable: string;
  /** Yalnızca ORGANIZATION kapsamında dolu — PROJECT_MANAGER kapsamında kavramsal olarak mevcut değildir. */
  cashAndBankBalance: string | null;
  activeProjectCount: number;
  totalProjectCount: number;
  budgetCriticalProjectCount: number;
}

export type AiContextItem =
  | AiProjectSummaryContext
  | AiBudgetVarianceContext
  | AiCashFlowContext
  | AiReceivablesPayablesContext
  | AiCompanyFinancialSummaryContext;

export interface AiContextResult {
  correlationId: string;
  /** Yalnızca `actor.organizationId`'den türetilir — hiçbir zaman çağıranın/AI'nin sağladığı bir kimlikten DEĞİL. */
  organizationId: string;
  items: AiContextItem[];
}
