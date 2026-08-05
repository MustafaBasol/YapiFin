/**
 * Next.js, her sunucu örneği (cold start) başladığında `register()`'ı bir
 * kez çağırır — env doğrulamasının "mümkün olan en erken" çalıştığı yer
 * burasıdır (bkz. docs/PRODUCTION_READINESS.md R-1). Eksik/güvensiz bir
 * değişken varsa süreç ilk isteği karşılamadan çöker.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { getEnv } = await import("@/lib/env");
    getEnv();
  }
}
