import type { AiProvider } from "@/lib/ai/provider";
import type { ResolvedAiConfig } from "@/lib/ai/config";
import { createDisabledAiProvider } from "@/lib/ai/providers/disabled-provider";
import { createFakeAiProvider } from "@/lib/ai/providers/fake-provider";

/**
 * `ResolvedAiConfig.provider`'a (bkz. lib/ai/config.ts) göre somut bir
 * `AiProvider` implementasyonu seçer. Gerçek bir ücretli sağlayıcı eklenmek
 * istendiğinde tek değişmesi gereken yer burasıdır — bkz. lib/ai/provider.ts
 * üst açıklaması.
 */
export function createAiProviderFromConfig(config: ResolvedAiConfig): AiProvider {
  switch (config.provider) {
    case "fake":
      return createFakeAiProvider();
    case "disabled":
      return createDisabledAiProvider();
  }
}
