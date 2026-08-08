/**
 * YF-701 — AI temelinin genel (public) API yüzeyi. `lib/monitoring/index.ts`
 * ile aynı desen: uygulama kodu bu modülden import eder, `lib/ai/*` altındaki
 * dosyalardan doğrudan değil (yeniden ihracat, iç dosya yeniden düzenlemesini
 * çağıranları kırmadan mümkün kılar).
 */
export type { AiMessage, AiMessageRole, AiCompletionRequest, AiCompletionResult, AiUsage } from "@/lib/ai/types";
export type { AiProvider } from "@/lib/ai/provider";
export { AiError, type AiErrorCategory } from "@/lib/ai/errors";
export { createAiCorrelationId } from "@/lib/ai/correlation";
export { resolveAiConfig, type ResolvedAiConfig } from "@/lib/ai/config";
export { createAiProviderFromConfig } from "@/lib/ai/providers/resolve";
export { createDisabledAiProvider } from "@/lib/ai/providers/disabled-provider";
export { createFakeAiProvider, type FakeAiProviderOptions } from "@/lib/ai/providers/fake-provider";
export { runAiCompletion, type RunAiCompletionInput } from "@/lib/ai/service";
export { parseStructuredOutput, type StructuredOutputResult } from "@/lib/ai/structured-output";
export { definePromptTemplate, type AiPromptTemplate } from "@/lib/ai/prompt";
export {
  logAiUsage,
  setAiUsageLogSinkForTests,
  resetAiUsageLogSinkForTests,
  type AiUsageLogEntry,
  type AiUsageStatus,
} from "@/lib/ai/logging";
export {
  createNoopAiUsageReporter,
  type AiUsageReporter,
  type AiUsageReportEntry,
  type AiQuotaDecision,
} from "@/lib/ai/usage-reporting";
