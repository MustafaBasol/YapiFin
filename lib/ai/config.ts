import type { Env } from "@/lib/env";

export interface ResolvedAiConfig {
  provider: "disabled" | "fake";
  model: string | null;
  requestTimeoutMs: number;
}

/**
 * `env.ai`'yi (lib/env.ts) çalışma zamanı yapılandırmasına çevirir — aynı
 * desen `lib/monitoring/config.ts`'deki `resolveMonitoringConfig` ile.
 *
 * `NODE_ENV === "test"` dışında bir ortamda `provider: "fake"` asla
 * DÖNMEZ — `lib/env.ts` bunu üretimde zaten reddeder (fail-closed doğrulama),
 * ama bu ikinci, bağımsız bir güvenlik ağıdır (bkz. lib/monitoring/config.ts
 * aynı iki-katmanlı desen: NODE_ENV==="test" her zaman özel davranış).
 */
export function resolveAiConfig(env: Env): ResolvedAiConfig {
  const provider = env.NODE_ENV === "production" && env.ai.provider === "fake" ? "disabled" : env.ai.provider;
  return {
    provider,
    model: env.ai.model,
    requestTimeoutMs: env.ai.requestTimeoutMs,
  };
}
