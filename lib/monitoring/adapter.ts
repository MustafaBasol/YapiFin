import * as Sentry from "@sentry/node";
import { redact } from "@/lib/monitoring/redact";
import type { ResolvedMonitoringConfig } from "@/lib/monitoring/config";

export interface CaptureOptions {
  tags?: Record<string, string>;
  extra?: Record<string, unknown>;
}

/**
 * Uzak monitoring aktarımının soyutlaması. Testler ve `scripts/trigger-test-monitoring-event.ts`
 * gerçek ağ çağrısı yapmayan bir mock/no-op implementasyonu enjekte
 * edebilsin diye ayrı bir arayüz olarak tanımlanır (bkz. lib/monitoring/index.ts
 * `setMonitoringAdapterForTests`).
 */
export interface MonitoringAdapter {
  captureException(error: unknown, options?: CaptureOptions): void;
  captureMessage(message: string, options?: CaptureOptions): void;
  /** Süreç kapanmadan önce bekleyen olayların gönderilmesini bekler. */
  flush(timeoutMs?: number): Promise<boolean>;
}

export function createNoopAdapter(): MonitoringAdapter {
  return {
    captureException() {},
    captureMessage() {},
    async flush() {
      return true;
    },
  };
}

let sentryInitialized = false;

/**
 * Gerçek Sentry SDK'sını sarmalar. `@sentry/nextjs` yerine bilinçli olarak
 * `@sentry/node` kullanılır: bu görevin kapsamı yalnızca sunucu tarafı
 * (server action/route/health/mailer/rate-limit) — istemci/tarayıcı hata
 * izleme kapsam dışıdır (bkz. görev talimatı, ERROR CAPTURE bölümü). Bu
 * seçim Next.js'in Turbopack build eklentisi/kaynak harita yükleme
 * karmaşıklığını (ve production build'i kırma riskini) tamamen ortadan
 * kaldırır; yalnızca `instrumentation.ts` (`register`/`onRequestError`)
 * üzerinden merkezi olarak çağrılır.
 *
 * Varsayılan entegrasyonlar KASITLI OLARAK boş bırakılır: Sentry'nin
 * otomatik http/request-data entegrasyonları, istek header'ları (Authorization/
 * Cookie) veya giden istek URL'lerini (sorgu string'inde token olabilir)
 * breadcrumb olarak yakalayabilir — bu proje yalnızca açık, elle yapılan
 * `captureException`/`captureMessage` çağrılarını kullanır.
 */
export function createSentryAdapter(config: ResolvedMonitoringConfig): MonitoringAdapter {
  if (!sentryInitialized) {
    sentryInitialized = true;
    Sentry.init({
      dsn: config.dsn ?? undefined,
      environment: config.environment,
      tracesSampleRate: config.tracesSampleRate,
      integrations: [],
      sendDefaultPii: false,
      beforeSend(event) {
        return redact(event);
      },
      beforeBreadcrumb(breadcrumb) {
        return redact(breadcrumb);
      },
    });
  }

  return {
    captureException(error, options) {
      Sentry.captureException(error, options ? { tags: options.tags, extra: options.extra } : undefined);
    },
    captureMessage(message, options) {
      Sentry.captureMessage(message, { level: "warning", tags: options?.tags, extra: options?.extra });
    },
    async flush(timeoutMs = 2000) {
      return Sentry.flush(timeoutMs);
    },
  };
}
