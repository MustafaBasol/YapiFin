import type { AiProvider } from "@/lib/ai/provider";
import type { AiCompletionRequest, AiCompletionResult, AiMessage } from "@/lib/ai/types";
import { withAiTimeout } from "@/lib/ai/timeout";
import { createAiCorrelationId } from "@/lib/ai/correlation";
import { AiError } from "@/lib/ai/errors";
import { logAiUsage } from "@/lib/ai/logging";
import { createNoopAiUsageReporter, type AiUsageReporter } from "@/lib/ai/usage-reporting";

const DEFAULT_TIMEOUT_MS = 15000;

export interface RunAiCompletionInput {
  provider: AiProvider;
  /** Yalnızca gözlemlenebilirlik/kota amaçlı taşınır — `runAiCompletion` bununla asla veritabanı sorgusu yapmaz. */
  organizationId: string;
  messages: AiMessage[];
  promptVersion: string;
  model?: string;
  maxOutputTokens?: number;
  temperature?: number;
  timeoutMs?: number;
  correlationId?: string;
  usageReporter?: AiUsageReporter;
}

/**
 * YF-701 — Tek giriş noktası: sağlayıcı çağrısını zaman aşımı, güvenli
 * kullanım günlüğü, korelasyon kimliği ve (varsayılan no-op) kota kontrolüyle
 * sarmalar. Sağlayıcı seçimi çağıran tarafa aittir (bkz. lib/ai/config.ts +
 * lib/ai/providers/*) — bu fonksiyon hangi sağlayıcının kullanılacağına karar
 * VERMEZ, yalnızca enjekte edilen `provider`'ı çalıştırır.
 */
export async function runAiCompletion(input: RunAiCompletionInput): Promise<AiCompletionResult> {
  const correlationId = input.correlationId ?? createAiCorrelationId();
  const usageReporter = input.usageReporter ?? createNoopAiUsageReporter();
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const startedAt = Date.now();

  function fail(err: unknown): AiError {
    const latencyMs = Date.now() - startedAt;
    const aiError =
      err instanceof AiError ? err : new AiError("AI isteği başarısız oldu", "provider_error", correlationId, { cause: err });
    logAiUsage({
      provider: input.provider.name,
      model: input.model ?? null,
      promptVersion: input.promptVersion,
      correlationId,
      organizationId: input.organizationId,
      latencyMs,
      status: "failure",
      failureCategory: aiError.category,
      usage: { promptTokens: null, completionTokens: null, totalTokens: null },
    });
    return aiError;
  }

  const quota = await usageReporter.checkQuota(input.organizationId);
  if (!quota.allowed) {
    throw fail(new AiError(quota.reason ?? "AI kullanım kotası doldu", "quota_exceeded", correlationId));
  }

  const request: AiCompletionRequest = {
    messages: input.messages,
    promptVersion: input.promptVersion,
    model: input.model,
    maxOutputTokens: input.maxOutputTokens,
    temperature: input.temperature,
    correlationId,
  };

  let result: AiCompletionResult;
  try {
    result = await withAiTimeout(input.provider.complete(request), timeoutMs, correlationId);
  } catch (err) {
    throw fail(err);
  }

  const latencyMs = Date.now() - startedAt;
  logAiUsage({
    provider: input.provider.name,
    model: result.model,
    promptVersion: input.promptVersion,
    correlationId,
    organizationId: input.organizationId,
    latencyMs,
    status: "success",
    usage: result.usage,
  });
  await usageReporter.reportUsage({
    organizationId: input.organizationId,
    provider: input.provider.name,
    correlationId,
    usage: result.usage,
  });

  return { ...result, latencyMs };
}
