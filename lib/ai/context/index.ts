export { buildAiContext } from "@/lib/ai/context/context-builder";
export type {
  AiContextScope,
  AiContextItem,
  AiContextResult,
  AiProjectSummaryContext,
  AiBudgetVarianceContext,
  AiBudgetVarianceCategory,
  AiCashFlowContext,
  AiCashFlowMonthlyPoint,
  AiReceivablesPayablesContext,
  AiCompanyFinancialSummaryContext,
} from "@/lib/ai/context/types";
export { aiContextRequestSchema, aiContextSourceEnum, type AiContextRequest, type AiContextSource } from "@/lib/validation/ai";
