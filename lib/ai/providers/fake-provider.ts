import type { AiProvider } from "@/lib/ai/provider";
import type { AiCompletionRequest, AiUsage } from "@/lib/ai/types";
import { AiError } from "@/lib/ai/errors";

/**
 * YF-701 — Yalnızca testler içindir (bkz. lib/env.ts, `AI_PROVIDER=fake`
 * üretimde reddedilir). Gerçek/ücretli bir LLM API'sine ihtiyaç duymadan
 * `AiProvider` arayüzünü uygulayan çağıran kodun (context builder, yapılandırılmış
 * çıktı doğrulaması, zaman aşımı işleme, kullanım günlüğü) uçtan uca test
 * edilmesini sağlar.
 */
export interface FakeAiProviderOptions {
  /** Sabit yanıt metni veya isteğe göre yanıt üreten bir fonksiyon. */
  response?: string | ((request: AiCompletionRequest) => string);
  usage?: Partial<AiUsage>;
  /** "provider_error": sağlayıcı hatasını simüle eder. "hang": lib/ai/timeout.ts'i egzersiz etmek için asla dönmez. */
  behavior?: "success" | "provider_error" | "hang";
  latencyMs?: number;
}

export function createFakeAiProvider(options: FakeAiProviderOptions = {}): AiProvider {
  const behavior = options.behavior ?? "success";
  return {
    name: "fake",
    async complete(request) {
      if (behavior === "hang") {
        await new Promise<never>(() => {});
      }
      if (options.latencyMs) {
        await new Promise((resolve) => setTimeout(resolve, options.latencyMs));
      }
      if (behavior === "provider_error") {
        throw new AiError("Sahte sağlayıcı hatası (test)", "provider_error", request.correlationId);
      }

      const text = typeof options.response === "function" ? options.response(request) : (options.response ?? "fake-response");

      return {
        text,
        provider: "fake",
        model: request.model ?? null,
        usage: {
          promptTokens: options.usage?.promptTokens ?? 10,
          completionTokens: options.usage?.completionTokens ?? 10,
          totalTokens: options.usage?.totalTokens ?? 20,
        },
        latencyMs: options.latencyMs ?? 0,
        correlationId: request.correlationId,
      };
    },
  };
}
