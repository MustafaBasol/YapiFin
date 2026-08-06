import { getRedisClient } from "@/lib/rate-limit/redis-client";
import { checkFixedWindow } from "@/lib/rate-limit/store";
import { checkMemoryFixedWindow } from "@/lib/rate-limit/memory-store";
import { hashIdentifier } from "@/lib/rate-limit/identifier";
import type { ActionState } from "@/lib/action-state";

/**
 * Merkezi, test edilebilir rate limit politika kataloğu. Tüm auth/abuse-riskli
 * uç noktalar buradan tek bir isimle (`PolicyName`) çağrılır - route/action
 * seviyesine dağınık limit sabitleri veya ayrı ayrı Redis anahtar şemaları
 * SERPİŞTİRİLMEZ (bkz. CLAUDE.md "route seviyesinde dağınık limiter
 * konfigürasyonu yerine merkezi ve test edilebilir bir politika katmanı").
 *
 * Kaynak: docs/PRODUCTION_READINESS.md paragraf 3'teki önerilen uç nokta/limit
 * listesi buradaki değerlerin başlangıç noktasıdır.
 */
export type PolicyName =
  | "login"
  | "signup"
  | "forgot-password"
  | "reset-password"
  | "resend-verification"
  | "accept-invitation"
  | "invite-create"
  | "invite-resend";

interface PolicyConfig {
  windowMs: number;
  limit: number;
}

const MINUTE_MS = 60_000;

const POLICIES: Record<PolicyName, PolicyConfig> = {
  login: { windowMs: 15 * MINUTE_MS, limit: 10 },
  signup: { windowMs: 15 * MINUTE_MS, limit: 5 },
  "forgot-password": { windowMs: 15 * MINUTE_MS, limit: 5 },
  "reset-password": { windowMs: 15 * MINUTE_MS, limit: 10 },
  "resend-verification": { windowMs: 60 * MINUTE_MS, limit: 3 },
  "accept-invitation": { windowMs: 15 * MINUTE_MS, limit: 10 },
  "invite-create": { windowMs: 60 * MINUTE_MS, limit: 20 },
  "invite-resend": { windowMs: 60 * MINUTE_MS, limit: 20 },
};

export interface RateLimitDecision {
  allowed: boolean;
  /** Yalnızca gözlemlenebilirlik amaçlı - çağıran taraf ham store bilgisini kullanıcıya asla yansıtmamalıdır. */
  retryAfterSeconds: number;
  source: "redis" | "memory-fallback";
}

// Kontrol karakteri ayırıcı: IP (IPv6 ":" içerir), e-posta, token gibi
// girdilerin normal biçimlerinde asla geçmez - bu yüzden ["a", "b:c"] ile
// ["a:b", "c"] gibi farklı parça kümelerinin aynı HMAC girdisine
// (dolayısıyla aynı Redis anahtarına) çakışması önlenir.
const PART_SEPARATOR = String.fromCharCode(1);

function buildKey(policy: PolicyName, parts: string[]): string {
  const identity = hashIdentifier(policy, parts.join(PART_SEPARATOR));
  return `ratelimit:${policy}:${identity}`;
}

function recordOutcome(
  policy: PolicyName,
  outcome: "blocked" | "store_unavailable",
  source: RateLimitDecision["source"],
  keyHash: string,
  err?: unknown,
): void {
  // "allowed" sonucu kasıtlı olarak loglanmaz - yüksek hacimli auth uç
  // noktalarında (login) her başarılı istekte log basmak sinyal/gürültü
  // oranını bozar. Bloklanma ve store kesintisi düşük hacimli, yüksek
  // sinyalli olaylardır ve daima loglanır.
  const line = {
    level: outcome === "store_unavailable" ? "warn" : "info",
    event: `rate_limit.${outcome}`,
    policy,
    source,
    // Geri döndürülemez HMAC özetinin yalnızca bir kısmı - ham IP/e-posta/
    // token/kullanıcı kimliği asla loglanmaz, yalnızca korelasyon için kısa
    // bir özet önekine izin verilir.
    subjectHash: keyHash.slice(0, 12),
    ...(err ? { errorMessage: err instanceof Error ? err.message : "unknown" } : {}),
  };
  if (outcome === "store_unavailable") console.warn(JSON.stringify(line));
  else console.log(JSON.stringify(line));
}

/**
 * Redis kesinti politikası (fail-open): Redis yapılandırılmamış, zaman
 * aşımına uğramış veya erişilemez durumdaysa istek REDDEDİLMEZ - bunun
 * yerine süreç-içi (per-instance, `lib/rate-limit/memory-store.ts`) bir
 * yedek limitlemeye düşülür ve olay `store_unavailable` olarak loglanır.
 *
 * Gerekçe: rate limiting burada tek savunma katmanı değildir (parola
 * doğrulama, e-posta numaralandırma koruması, token entropisi ve rol/tenant
 * yetkilendirmesi bağımsız olarak çalışmaya devam eder) - kısa süreli bir
 * Redis kesintisinde TÜM kullanıcıları giriş/parola sıfırlama gibi kritik
 * akışlardan kilitlemek (fail-closed), bir saldırganın Redis'i düşürerek
 * meşru kullanıcılar için bir hizmet dışı bırakma (DoS) senaryosu
 * yaratmasına izin verir - bu, kısa bir korumasız pencere riskinden daha
 * ciddi ve daha kolay tetiklenebilir bir sonuçtur. Bellek-içi yedek, bu
 * riski sıfıra indirmez ama kesinti süresince tek bir instance'a yönelik
 * kaba kuvvet denemelerini yine de sınırlar.
 */
export async function enforceRateLimit(policy: PolicyName, parts: string[]): Promise<RateLimitDecision> {
  const config = POLICIES[policy];
  const key = buildKey(policy, parts);
  const client = getRedisClient();

  if (client) {
    try {
      const result = await checkFixedWindow(client, key, config.windowMs, config.limit);
      if (!result.allowed) recordOutcome(policy, "blocked", "redis", key);
      return {
        allowed: result.allowed,
        retryAfterSeconds: Math.ceil(result.retryAfterMs / 1000),
        source: "redis",
      };
    } catch (err) {
      recordOutcome(policy, "store_unavailable", "redis", key, err);
      // Aşağıya, bellek-içi yedeğe düş.
    }
  }

  const fallback = checkMemoryFixedWindow(key, config.windowMs, config.limit);
  if (!fallback.allowed) recordOutcome(policy, "blocked", "memory-fallback", key);
  return {
    allowed: fallback.allowed,
    retryAfterSeconds: Math.ceil(fallback.retryAfterMs / 1000),
    source: "memory-fallback",
  };
}

/**
 * Tüm politikalarda tutarlı, tek bir kullanıcıya-yansıyan mesaj - hangi
 * limitin/anahtarın aşıldığını, iç store durumunu veya kalan süreyi (saniye
 * hassasiyetinde) sızdırmaz. Next.js Server Actions, route handler'ların
 * aksine action çağrısı başına özel bir HTTP durum kodu (429) döndürmeye
 * izin vermez (Flight protokolü her zaman 200 ile sonuçlanır); bu yüzden
 * standart/tutarlı "429 karşılığı" burada ActionState.error sözleşmesi
 * üzerinden ifade edilir - mevcut login davranışıyla birebir aynı sözleşme
 * (bkz. app/actions/auth.ts, PR açıklamasındaki mimari not).
 */
const RATE_LIMIT_MESSAGE = "Çok fazla deneme yapıldı. Lütfen birkaç dakika sonra tekrar deneyin.";

export function rateLimitActionError(): ActionState {
  return { error: RATE_LIMIT_MESSAGE };
}
