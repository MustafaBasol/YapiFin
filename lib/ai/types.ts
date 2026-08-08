/**
 * YF-701 — AI temeli: sağlayıcı-nötr çekirdek tipler.
 *
 * Bu dosya hiçbir sağlayıcıya (OpenAI/Anthropic/vb.) veya Prisma'ya bağımlı
 * değildir — yalnızca bir `AiProvider` implementasyonunun ürettiği/tükettiği
 * veri şeklini tanımlar (bkz. lib/ai/provider.ts).
 */

export type AiMessageRole = "system" | "user" | "assistant";

export interface AiMessage {
  role: AiMessageRole;
  content: string;
}

export interface AiCompletionRequest {
  messages: AiMessage[];
  /** Bu isteğin hangi prompt şablonu/sürümüyle üretildiği — bkz. lib/ai/prompt.ts. Yalnızca gözlemlenebilirlik için taşınır, sağlayıcıya iletilmez. */
  promptVersion: string;
  model?: string;
  maxOutputTokens?: number;
  /** [0,2] aralığında; sağlayıcı desteklemiyorsa yok sayılır. */
  temperature?: number;
  correlationId: string;
}

export interface AiUsage {
  /** Sağlayıcı raporlamıyorsa null — asla 0 uydurulmaz. */
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
}

export interface AiCompletionResult {
  text: string;
  provider: string;
  model: string | null;
  usage: AiUsage;
  latencyMs: number;
  correlationId: string;
}
