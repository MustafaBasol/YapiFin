/**
 * YF-512 — Sabit pencereli sayaç: "her normal istekte bir uzak APM olayı
 * gönderme" riskini önlemek için (bkz. görev talimatı, RATE LIMIT bölümü).
 * `lib/rate-limit/memory-store.ts`'teki süreç-içi sabit-pencere deseniyle
 * aynı yaklaşım — burada Redis/dağıtık doğruluk gerekmez, yalnızca tek bir
 * instance'ın uzak gönderim hacmini sınırlaması yeterlidir; her instance
 * kendi payını bağımsız gönderse bile toplam hacim sınırlı kalır.
 */
interface WindowState {
  count: number;
  windowStart: number;
}

const windows = new Map<string, WindowState>();

export interface SampleOptions {
  windowMs: number;
  /** Bu pencere içinde uzak sisteme iletilecek maksimum olay sayısı; ötesi düşürülür (yerel log her zaman ayrıca yazılır, bu yalnızca uzak iletimi sınırlar). */
  maxPerWindow: number;
}

/** `key` için bu olayın uzak monitoring adapter'ına iletilip iletilmeyeceğine karar verir. */
export function shouldForwardToRemote(key: string, opts: SampleOptions): boolean {
  const now = Date.now();
  const state = windows.get(key);

  if (!state || now - state.windowStart >= opts.windowMs) {
    windows.set(key, { count: 1, windowStart: now });
    return true;
  }

  state.count += 1;
  return state.count <= opts.maxPerWindow;
}

/** Yalnızca testlerde: pencere sayaçlarını temizler. */
export function resetSamplerForTests(): void {
  windows.clear();
}
