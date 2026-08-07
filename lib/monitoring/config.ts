import type { Env } from "@/lib/env";

export interface ResolvedMonitoringConfig {
  /** `false` ise gerçek Sentry SDK'sı hiç başlatılmaz — yalnızca no-op adapter kullanılır. */
  enabled: boolean;
  dsn: string | null;
  environment: string;
  tracesSampleRate: number;
}

/**
 * `env.monitoring`'i (lib/env.ts) çalışma zamanı davranışına çevirir.
 *
 * İki bağımsız güvenlik kuralı:
 * 1. `NODE_ENV === "test"` her zaman devre dışıdır — DSN yanlışlıkla test
 *    ortamına sızsa bile gerçek bir APM olayı gönderilmez (bkz.
 *    docs/operations/MONITORING_RUNBOOK.md, "Testler gerçek Sentry olayı
 *    göndermemelidir" gereksinimi).
 * 2. `dsn` yoksa devre dışıdır — eksik yapılandırma asla süreci çökertmez,
 *    yalnızca gözlemlenebilirlik kaybına yol açar (initMonitoring() bunu
 *    production'da bir kerelik uyarıyla loglar).
 *
 * `tracesSampleRate` yalnızca production'da env değerini kullanır;
 * development/test'te DSN yapılandırılmış olsa bile sıfırdır — agresif
 * olmayan tracing varsayımı (bkz. görev talimatı "Do not choose aggressive
 * tracing defaults").
 */
export function resolveMonitoringConfig(env: Env): ResolvedMonitoringConfig {
  const dsn = env.monitoring.dsn;
  const enabled = env.NODE_ENV !== "test" && Boolean(dsn);
  return {
    enabled,
    dsn,
    environment: env.monitoring.environment,
    tracesSampleRate: env.NODE_ENV === "production" ? env.monitoring.tracesSampleRate : 0,
  };
}
