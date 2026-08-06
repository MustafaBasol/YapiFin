import Redis from "ioredis";
import { getEnv } from "@/lib/env";

/**
 * `lib/db.ts`'deki Prisma singleton deseniyle aynı gerekçe: Next.js dev
 * hot-reload'unda modül yeniden değerlendirildiğinde yeni bir bağlantı
 * açılmasını önlemek için `globalThis` üzerinde önbelleklenir.
 */
const globalForRedis = globalThis as unknown as { rateLimitRedis?: Redis };

// İsteklerin Redis kesintisinde asılı kalmaması için sıkı zaman aşımları:
// tek bir yavaş/kopuk Redis, bir auth isteğini saniyelerce bekletmemeli —
// politika katmanı (lib/rate-limit/policy.ts) kısa sürede "store_unavailable"
// kararına düşüp güvenli yedek moda geçebilsin diye burada erken pes edilir.
const CONNECT_TIMEOUT_MS = 750;
const COMMAND_TIMEOUT_MS = 250;
const MAX_RETRIES_PER_REQUEST = 1;

let loggedMissingConfig = false;

/**
 * Yeni, bağımsız bir Redis bağlantısı oluşturur. Singleton `getRedisClient()`
 * dışında, testlerin birden fazla "uygulama instance'ı"nı simüle etmesi için
 * de doğrudan kullanılabilir (bkz. tests/rate-limit-redis-integration.test.ts).
 */
export function createRedisClient(url: string): Redis {
  const client = new Redis(url, {
    lazyConnect: true,
    connectTimeout: CONNECT_TIMEOUT_MS,
    commandTimeout: COMMAND_TIMEOUT_MS,
    maxRetriesPerRequest: MAX_RETRIES_PER_REQUEST,
    // `enableOfflineQueue: false` KASITLI OLARAK kullanılmaz: `lazyConnect`
    // ile birlikte bağlantı henüz kurulmamışken (özellikle singleton'ın ilk
    // komutu) gönderilen komutları ANINDA reddeder — bağlantının kurulmasını
    // beklemez. Bu, sağlıklı bir Redis'te bile "ilk istek burstu" boyunca
    // sahte `store_unavailable` sonuçlarına yol açar. Offline queue AÇIK
    // bırakılır (varsayılan); `maxRetriesPerRequest: 1` zaten kuyruğa alınan
    // bir komutun gerçek bir kesintide sınırsız beklemeyeceğini garanti eder
    // — komut yalnızca bağlantı GERÇEKTEN kurulamazsa (bağlantı zaman aşımı +
    // tek yeniden deneme sonrası) reddedilir.
    retryStrategy: (times) => Math.min(times * 200, 2000),
  });

  // ioredis, dinleyicisiz 'error' olayında Node sürecini çökertir — yalnızca
  // güvenli (bağlantı dizesi/kimlik bilgisi içermeyen) bir uyarı loglanır.
  client.on("error", (err) => {
    console.warn(
      JSON.stringify({
        level: "warn",
        event: "rate_limit.redis_connection_error",
        message: err instanceof Error ? err.message : "unknown",
      }),
    );
  });

  return client;
}

/**
 * Uygulama genelinde paylaşılan tekil Redis istemcisi. `REDIS_URL`
 * yapılandırılmamışsa (yalnızca development/test'te mümkün) `null` döner —
 * çağıran taraf (rate-limit politikası) bunu süreç-içi yedek moda geçme
 * sinyali olarak yorumlamalıdır.
 */
export function getRedisClient(): Redis | null {
  if (globalForRedis.rateLimitRedis) return globalForRedis.rateLimitRedis;

  const env = getEnv();
  if (!env.redis) {
    if (!loggedMissingConfig) {
      loggedMissingConfig = true;
      console.warn(
        JSON.stringify({
          level: "warn",
          event: "rate_limit.redis_not_configured",
          message: "REDIS_URL tanımlı değil — rate limiter süreç-içi yedek moda düşüyor (yalnızca dev/test için güvenli).",
        }),
      );
    }
    return null;
  }

  const client = createRedisClient(env.redis.url);
  if (process.env.NODE_ENV !== "production") {
    globalForRedis.rateLimitRedis = client;
  }
  return client;
}

/** Yalnızca testlerde: paylaşılan istemciyi kapatır ve önbelleği temizler. */
export async function closeRedisClient(): Promise<void> {
  const client = globalForRedis.rateLimitRedis;
  globalForRedis.rateLimitRedis = undefined;
  loggedMissingConfig = false;
  if (client) {
    await client.quit().catch(() => client.disconnect());
  }
}
