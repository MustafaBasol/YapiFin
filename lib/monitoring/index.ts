import { getEnv } from "@/lib/env";
import { resolveMonitoringConfig } from "@/lib/monitoring/config";
import { createNoopAdapter, createSentryAdapter, type MonitoringAdapter } from "@/lib/monitoring/adapter";
import { redact } from "@/lib/monitoring/redact";

/**
 * YF-512 — Uygulama genelinde tek monitoring giriş noktası.
 *
 * `initMonitoring()` yalnızca `instrumentation.ts` `register()` içinden,
 * yalnızca nodejs runtime'da bir kez çağrılır. Yapılandırma yoksa (SENTRY_DSN
 * boş) veya `NODE_ENV === "test"` ise no-op adapter kullanılır — hiçbir
 * durumda süreç başlangıcı bu yüzden çökmez (bkz. lib/env.ts, SENTRY_* alanları
 * bilinçli olarak opsiyoneldir).
 */
let adapter: MonitoringAdapter = createNoopAdapter();
let initialized = false;
let testAdapterOverride: MonitoringAdapter | null = null;
let loggedProductionMisconfig = false;

export function initMonitoring(): void {
  if (initialized) return;
  initialized = true;

  const env = getEnv();
  const config = resolveMonitoringConfig(env);

  if (env.NODE_ENV === "production" && !config.dsn && !loggedProductionMisconfig) {
    loggedProductionMisconfig = true;
    // Sır İÇERMEZ — yalnızca yapılandırma eksikliğini bildirir (bkz. görev
    // talimatı: "Production misconfiguration should be observable/documented
    // without leaking secrets").
    console.warn(
      JSON.stringify({
        level: "warn",
        event: "monitoring.not_configured",
        message: "SENTRY_DSN tanımlı değil — production'da hata izleme devre dışı kalıyor.",
      }),
    );
  }

  adapter = config.enabled ? createSentryAdapter(config) : createNoopAdapter();
}

function activeAdapter(): MonitoringAdapter {
  return testAdapterOverride ?? adapter;
}

export interface CaptureContext {
  tags?: Record<string, string>;
  extra?: Record<string, unknown>;
}

/** Beklenmeyen bir istisnayı yakalar. `context` gönderilmeden önce redaction'dan geçirilir; adapter yapılandırılmamışsa no-op'tur. */
export function captureException(error: unknown, context?: CaptureContext): void {
  activeAdapter().captureException(error, {
    tags: context?.tags,
    extra: context?.extra ? (redact(context.extra) as Record<string, unknown>) : undefined,
  });
}

export interface RequestErrorRequest {
  path: string;
  method: string;
  headers: Record<string, string>;
}

export interface RequestErrorContext {
  routerKind: string;
  routePath: string;
  routeType: string;
}

/**
 * Next.js `instrumentation.ts` → `onRequestError` merkezi kancasından
 * çağrılır (bkz. görev talimatı: "Avoid manually wrapping dozens of
 * functions if Next.js instrumentation provides a centralized mechanism").
 * Ham `request.headers` (Authorization/Cookie içerebilir) KASITLI OLARAK
 * iletilmez — yalnızca path/method/route bilgisi (hiçbiri PII/sır değildir).
 */
export function captureRequestError(error: unknown, request: RequestErrorRequest, context: RequestErrorContext): void {
  captureException(error, {
    tags: { routerKind: context.routerKind, routeType: context.routeType },
    extra: { path: request.path, method: request.method, routePath: context.routePath },
  });
}

export interface SecurityEvent {
  type: "rate_limit" | "failed_login" | "smtp_failure" | "db_failure";
  result?: string;
  route?: string;
  subjectHash?: string;
  meta?: Record<string, unknown>;
  /** Sampler kararı (bkz. lib/monitoring/sampler.ts) — false ise yerel log zaten çağıran tarafta yazılmıştır, yalnızca uzak iletim atlanır. */
  forward: boolean;
}

/** Güvenlik olaylarını (rate-limit/failed-login/smtp/db) uzak adapter'a iletir — yalnızca `forward: true` olduğunda ve her zaman redaction'dan geçirilerek. */
export function captureSecurityEvent(event: SecurityEvent): void {
  if (!event.forward) return;
  // Yalnızca izin verilen alanlar iletilir (spread yerine allow-list) —
  // `event`'e ileride eklenecek yeni bir alan burada bilinçli olarak
  // eklenmeden uzak adapter'a sızamaz.
  const payload = { result: event.result, route: event.route, subjectHash: event.subjectHash, meta: event.meta };
  activeAdapter().captureMessage(`security.${event.type}`, {
    tags: { type: event.type, ...(event.result ? { result: event.result } : {}) },
    extra: redact(payload) as Record<string, unknown>,
  });
}

/** Süreç kapanmadan önce (ör. controlled test script) bekleyen olayların gönderilmesini bekler. */
export async function flushMonitoring(timeoutMs?: number): Promise<boolean> {
  return activeAdapter().flush(timeoutMs);
}

/** Yalnızca testlerde: gerçek/no-op adapter yerine bir mock enjekte eder. */
export function setMonitoringAdapterForTests(mock: MonitoringAdapter): void {
  testAdapterOverride = mock;
}

/** Yalnızca testlerde: mock override'ı ve init durumunu temizler. */
export function resetMonitoringAdapterForTests(): void {
  testAdapterOverride = null;
  initialized = false;
  adapter = createNoopAdapter();
  loggedProductionMisconfig = false;
}
