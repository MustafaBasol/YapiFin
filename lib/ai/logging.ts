import { redact } from "@/lib/monitoring/redact";

/**
 * YF-701 — Güvenli kullanım/gözlemlenebilirlik günlüğü. Bu modül KASITLI
 * OLARAK prompt/mesaj içeriğini veya AI context'in gerçek gövdesini kabul
 * eden bir parametreye sahip DEĞİLDİR — yalnızca aşağıdaki sabit meta veri
 * alanları taşınır (bkz. görev talimatı "Do not log prompts/context wholesale
 * if they can contain financial or personal data"). Yalnızca serbest metin
 * olabilecek alanlar (provider/model/promptVersion/failureCategory) savunma
 * amaçlı `redact()`'ten (bkz. lib/monitoring/redact.ts, YF-512) geçirilir —
 * mevcut redaction mantığı burada TEKRARLANMAZ.
 *
 * `usage`/`latencyMs` KASITLI OLARAK `redact()`'e verilmez: `redact()`
 * anahtar adı `token` alt dizesini içeren her alanı (ör. "promptTokens")
 * `[redacted]` yapar (bkz. lib/monitoring/redact.ts SENSITIVE_KEY_PATTERN) —
 * bu, kimlik doğrulama token'ları için doğru davranıştır ama burada
 * `AiUsage` tipi zaten yalnızca `number | null` taşıdığından (bkz.
 * lib/ai/types.ts) serbest metin/sır sızıntısı riski yoktur; görev talimatı
 * "usage/token counts" gözlemlenebilirliğini KASITLI OLARAK korumak için
 * bu alanlar olduğu gibi taşınır.
 */
export type AiUsageStatus = "success" | "failure";

export interface AiUsageLogEntry {
  provider: string;
  model: string | null;
  promptVersion: string;
  correlationId: string;
  organizationId: string;
  latencyMs: number;
  status: AiUsageStatus;
  /** Yalnızca status: "failure" olduğunda dolu — bkz. lib/ai/errors.ts AiErrorCategory. */
  failureCategory?: string;
  usage: {
    promptTokens: number | null;
    completionTokens: number | null;
    totalTokens: number | null;
  };
}

/** Yalnızca testlerde: gerçek console.log yerine bir mock enjekte eder. */
let sink: (entry: Record<string, unknown>) => void = (entry) => {
  console.log(JSON.stringify(entry));
};

export function logAiUsage(entry: AiUsageLogEntry): void {
  sink({
    level: entry.status === "success" ? "info" : "warn",
    event: "ai.usage",
    provider: redact(entry.provider),
    model: entry.model === null ? null : redact(entry.model),
    promptVersion: redact(entry.promptVersion),
    correlationId: entry.correlationId,
    organizationId: entry.organizationId,
    latencyMs: entry.latencyMs,
    status: entry.status,
    ...(entry.failureCategory !== undefined ? { failureCategory: redact(entry.failureCategory) } : {}),
    usage: entry.usage,
  });
}

/** Yalnızca testlerde: log çıktısını yakalamak için. */
export function setAiUsageLogSinkForTests(mock: (entry: Record<string, unknown>) => void): void {
  sink = mock;
}

/** Yalnızca testlerde: varsayılan console tabanlı sink'e döner. */
export function resetAiUsageLogSinkForTests(): void {
  sink = (entry) => {
    console.log(JSON.stringify(entry));
  };
}
