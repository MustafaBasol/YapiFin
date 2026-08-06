import { getEnv } from "@/lib/env";

/**
 * `X-Forwarded-For` güvenilir-proxy çözümlemesi.
 *
 * Format: `client, proxy1, proxy2, ..., proxyN` — istemci en solda, sunucuya
 * en yakın (son) ters proxy en sağda. Yalnızca sondan `trustedProxyCount`
 * kadar girdi (kendi altyapımızın — load balancer/CDN/reverse proxy — eklediği
 * hoplar) güvenilir kabul edilir; bunların hemen solundaki girdi gerçek
 * istemci IP'sidir. Listenin geri kalanı (istemcinin veya güvenilmeyen bir
 * ara sıçramanın eklediği her şey) asla güvenilmez — bir saldırgan
 * `X-Forwarded-For` header'ına istediği kadar sahte IP ekleyebilir, ama
 * bunlar her zaman listenin solunda kalır ve `trustedProxyCount` tarafından
 * atlanır.
 *
 * `trustedProxyCount` 0 ise (proxy'siz, doğrudan internete açık dağıtım)
 * `X-Forwarded-For` tamamen istemci kontrolündedir ve güvenilmez; `null`
 * döner. Aynı şekilde header'daki hop sayısı `trustedProxyCount`'tan azsa
 * (yanlış yapılandırma ya da manipülasyon şüphesi) soldaki ilk değeri
 * körlemesine kabul etmek yerine `null` döndürülür (belirsiz durumda
 * güvenmemek, rastgele bir değere güvenmekten daha güvenlidir).
 */
export function resolveClientIp(forwardedForHeader: string | null, trustedProxyCount: number): string | null {
  if (trustedProxyCount <= 0 || !forwardedForHeader) return null;

  const hops = forwardedForHeader
    .split(",")
    .map((hop) => hop.trim())
    .filter(Boolean);

  if (hops.length <= trustedProxyCount) return null;

  const clientIndex = hops.length - 1 - trustedProxyCount;
  return hops[clientIndex] ?? null;
}

/** `lib/env.ts`'te doğrulanmış güvenilir ters proxy sayısı. */
export function getTrustedProxyCount(): number {
  return getEnv().trustedProxyCount;
}
