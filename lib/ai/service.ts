import type { AiProvider } from "@/lib/ai/provider";
import type { AiCompletionRequest, AiCompletionResult, AiMessage } from "@/lib/ai/types";
import { withAiTimeout } from "@/lib/ai/timeout";
import { createAiCorrelationId } from "@/lib/ai/correlation";
import { AiError } from "@/lib/ai/errors";
import { logAiUsage } from "@/lib/ai/logging";
import { createNoopAiUsageReporter, type AiUsageReporter } from "@/lib/ai/usage-reporting";
import { estimateReservationCredits } from "@/lib/ai/credits";

const DEFAULT_TIMEOUT_MS = 15000;

export interface RunAiCompletionInput {
  provider: AiProvider;
  /** Yalnızca gözlemlenebilirlik/kota amaçlı taşınır — `runAiCompletion` bununla asla veritabanı sorgusu yapmaz. */
  organizationId: string;
  /** YF-711 — çağıranın ürettiği, tekrarlar arasında sabit kalan mantıksal istek kimliği (bkz. lib/ai/usage-reporting.ts AiQuotaCheckRequest). */
  idempotencyKey: string;
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
 * YF-701/YF-711 — Tek giriş noktası: sağlayıcı çağrısını zaman aşımı, güvenli
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

  async function fail(err: unknown): Promise<AiError> {
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
    // YF-711 — rezervasyon yapılmışsa serbest bırakır (bkz.
    // server/services/ai-usage-reporting-service.ts reportUsage); henüz hiç
    // rezervasyon yapılmamışsa (ör. checkQuota reddi) gerçek implementasyon
    // bunu no-op olarak ele alır.
    await usageReporter.reportUsage({
      organizationId: input.organizationId,
      provider: input.provider.name,
      correlationId,
      idempotencyKey: input.idempotencyKey,
      status: "failure",
      failureCategory: aiError.category,
      usage: { promptTokens: null, completionTokens: null, totalTokens: null },
    });
    return aiError;
  }

  const reservationCreditsEstimate = estimateReservationCredits({ messages: input.messages, maxOutputTokens: input.maxOutputTokens });
  const quota = await usageReporter.checkQuota(input.organizationId, {
    idempotencyKey: input.idempotencyKey,
    correlationId,
    provider: input.provider.name,
    model: input.model ?? null,
    reservationCreditsEstimate,
  });
  if (!quota.allowed) {
    throw await fail(
      new AiError(quota.reason ?? "AI kullanım kotası doldu", "quota_exceeded", correlationId, { reasonCode: quota.reasonCode }),
    );
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
    throw await fail(err);
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
    idempotencyKey: input.idempotencyKey,
    status: "success",
    usage: result.usage,
  });

  return { ...result, latencyMs };
}
