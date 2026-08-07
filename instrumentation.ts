/**
 * Next.js, her sunucu örneği (cold start) başladığında `register()`'ı bir
 * kez çağırır — env doğrulamasının "mümkün olan en erken" çalıştığı yer
 * burasıdır (bkz. docs/PRODUCTION_READINESS.md R-1). Eksik/güvensiz bir
 * değişken varsa süreç ilk isteği karşılamadan çöker.
 *
 * YF-512: aynı yerde `initMonitoring()` çağrılır — SENTRY_DSN tanımlı
 * değilse (development/test'in normali) no-op adapter kullanılır, süreç
 * asla bu yüzden çökmez (bkz. lib/monitoring/index.ts).
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { getEnv } = await import("@/lib/env");
    getEnv();
    const { initMonitoring } = await import("@/lib/monitoring");
    initMonitoring();
  }
}

/**
 * YF-512 — Next.js'in merkezi sunucu hata yakalama kancası (App Router:
 * Server Component render, Route Handler, Server Action ve middleware
 * hataları buradan geçer). Bu, `ERROR CAPTURE` kapsamındaki "onlarca
 * fonksiyonu elle sarmalamak yerine framework'ün merkezi mekanizmasını
 * kullan" talimatının karşılığıdır — bu proje server action'larının çoğu
 * zaten kendi `try/catch`'i içinde hatayı `ActionState`'e çevirdiği için
 * (bkz. lib/action-error.ts `toActionError`, orada da ayrıca `captureException`
 * çağrılır), bu kanca esas olarak framework/route seviyesinde gerçekten
 * yakalanmamış istisnaları kapsar.
 *
 * Yalnızca nodejs runtime'da işlenir — edge runtime (`proxy.ts`) için ayrı
 * bir Sentry edge yapılandırması bilinçli olarak eklenmez (bu görevin
 * kapsamındaki tüm sinyaller — health/auth/mailer/rate-limit — nodejs
 * runtime'da çalışır, bkz. görev talimatı "keep scope realistic").
 */
export async function onRequestError(
  error: unknown,
  request: { path: string; method: string; headers: Record<string, string> },
  context: { routerKind: string; routePath: string; routeType: string },
) {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { captureRequestError } = await import("@/lib/monitoring");
  captureRequestError(error, request, context);
}
