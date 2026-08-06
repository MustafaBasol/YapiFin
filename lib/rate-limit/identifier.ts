import { createHmac } from "crypto";
import { getEnv } from "@/lib/env";

/**
 * Rate limit anahtarlarında ve loglarda ham e-posta, telefon, token veya IP
 * asla kullanılmaz. Bunun yerine HMAC-SHA256(AUTH_SECRET, "scope:değer")
 * ile geri döndürülemez, kapsamla ayrıştırılmış (domain-separated) bir özet
 * üretilir — aynı ham değer farklı politika kapsamlarında (örn. login vs.
 * forgot-password) farklı özetler üretir; bu da Redis anahtarları veya
 * loglar üzerinden kapsamlar arası yanlış korelasyonu engeller.
 *
 * AUTH_SECRET burada yeniden kullanılır: ayrı bir sır eklemek operasyonel
 * yük getirir, kapsam ön eki zaten alan ayrımını sağlar — `lib/auth/tokens.ts`
 * içindeki token hash'leme yaklaşımıyla tutarlı bir tasarım kararıdır.
 */
export function hashIdentifier(scope: string, value: string): string {
  const env = getEnv();
  return createHmac("sha256", env.AUTH_SECRET).update(`${scope}:${value}`).digest("hex").slice(0, 32);
}
