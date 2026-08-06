/**
 * Süreç-içi (in-memory), sabit pencere sayaç. `lib/rate-limit/policy.ts`
 * tarafından yalnızca Redis yapılandırılmamışken (dev/test) veya kesinti/
 * zaman aşımı durumunda derece düşürülmüş (per-instance) bir yedek olarak
 * kullanılır — tek başına çoklu-instance dağıtımda dağıtık bir garanti
 * SAĞLAMAZ (bkz. docs/PRODUCTION_READINESS.md §3, policy.ts fail-open
 * kararı gerekçesi). Girdiler yalnızca aynı anahtara tekrar erişildiğinde
 * temizlenir; bu, önceki tek-instance MVP tasarımından devralınan bilinen,
 * düşük öncelikli bir sınırlamadır.
 */
interface Entry {
  count: number;
  resetAt: number;
}

const buckets = new Map<string, Entry>();

export function checkMemoryFixedWindow(
  key: string,
  windowMs: number,
  limit: number,
): { allowed: boolean; retryAfterMs: number } {
  const now = Date.now();
  const entry = buckets.get(key);

  if (!entry || entry.resetAt < now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return { allowed: true, retryAfterMs: 0 };
  }

  if (entry.count >= limit) {
    return { allowed: false, retryAfterMs: entry.resetAt - now };
  }

  entry.count += 1;
  return { allowed: true, retryAfterMs: 0 };
}

/** Yalnızca testlerde: önbelleği temizler. */
export function resetMemoryStoreForTests(): void {
  buckets.clear();
}
