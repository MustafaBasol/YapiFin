import type { Redis } from "ioredis";

/**
 * Sabit pencere (fixed-window) sayaç: `INCR` + (yalnızca ilk artırımda)
 * `PEXPIRE` tek bir Lua script içinde atomik çalışır. `GET` sonra `SET`
 * deseninin aksine, iki eşzamanlı istek arasında sayacı kaybetme/aşma
 * riski yoktur — Redis tek bir script'i her zaman sırayla, bölünmeden
 * çalıştırır.
 *
 * Dönüş: `{1, ttlMs}` (izin verildi) veya `{0, ttlMs}` (limit aşıldı).
 * `ttlMs < 0` savunma amaçlı yeniden `PEXPIRE` uygulanır — normalde
 * `INCR` sonrası anahtarın her zaman bir TTL'i olmalıdır, ama örn. Redis
 * `maxmemory-policy` altında beklenmedik bir tahliye/temizlik durumunda
 * TTL'siz kalan bir anahtarın süresiz büyümesini/kilitli kalmasını önler.
 */
const FIXED_WINDOW_SCRIPT = `
local key = KEYS[1]
local windowMs = tonumber(ARGV[1])
local limit = tonumber(ARGV[2])

local count = redis.call("INCR", key)
if count == 1 then
  redis.call("PEXPIRE", key, windowMs)
end

local ttl = redis.call("PTTL", key)
if ttl < 0 then
  redis.call("PEXPIRE", key, windowMs)
  ttl = windowMs
end

if count > limit then
  return {0, ttl}
end
return {1, ttl}
`;

export interface FixedWindowResult {
  allowed: boolean;
  retryAfterMs: number;
}

/**
 * Verilen istemci üzerinde atomik sabit-pencere kontrolü çalıştırır.
 * `client` parametre olarak alınır (bir singleton'a bağlı değildir) —
 * testlerin aynı Redis'e karşı birden fazla bağımsız "uygulama instance'ı"
 * simüle edebilmesi için kasıtlı bir tasarım kararıdır.
 */
export async function checkFixedWindow(
  client: Redis,
  key: string,
  windowMs: number,
  limit: number,
): Promise<FixedWindowResult> {
  const [allowedFlag, ttlMs] = (await client.eval(FIXED_WINDOW_SCRIPT, 1, key, windowMs, limit)) as [number, number];
  return {
    allowed: allowedFlag === 1,
    retryAfterMs: allowedFlag === 1 ? 0 : ttlMs,
  };
}
