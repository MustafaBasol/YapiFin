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
  windowMs: number;
}

const windows = new Map<string, WindowState>();

/**
 * `windows` anahtarları çağıranın verdiği key'e dayanır (ör.
 * `failed_login:<subjectHash>`) — subjectHash yüksek kardinaliteli
 * olabileceğinden (her deneme farklı e-posta/IP), saldırgan sürekli yeni
 * anahtar üreterek Map'i sınırsız büyütebilir. Bu üst sınır, o senaryoda bile
 * bellek kullanımını sabit tutar: sınıra ulaşıldığında önce süresi dolmuş
 * pencereler temizlenir, hâlâ doluysa en eski (windowStart'ı en küçük)
 * pencere atılır. Arka plan zamanlayıcısı veya dış bağımlılık gerekmez —
 * temizlik yalnızca yeni bir anahtar eklenirken, iş üzerinde (on-insertion)
 * yapılır.
 */
const MAX_WINDOWS = 5000;

export interface SampleOptions {
  windowMs: number;
  /** Bu pencere içinde uzak sisteme iletilecek maksimum olay sayısı; ötesi düşürülür (yerel log her zaman ayrıca yazılır, bu yalnızca uzak iletimi sınırlar). */
  maxPerWindow: number;
}

/** `key` için bu olayın uzak monitoring adapter'ına iletilip iletilmeyeceğine karar verir. */
export function shouldForwardToRemote(key: string, opts: SampleOptions): boolean {
  const now = Date.now();
  const state = windows.get(key);

  if (!state || now - state.windowStart >= state.windowMs) {
    if (!state) makeRoomForNewKey(now);
    windows.set(key, { count: 1, windowStart: now, windowMs: opts.windowMs });
    return true;
  }

  state.count += 1;
  return state.count <= opts.maxPerWindow;
}

/** Yeni bir anahtar için yer açar: önce süresi dolmuş pencereleri, gerekirse en eskisini atar. */
function makeRoomForNewKey(now: number): void {
  if (windows.size < MAX_WINDOWS) return;

  for (const [key, state] of windows) {
    if (now - state.windowStart >= state.windowMs) windows.delete(key);
  }
  if (windows.size < MAX_WINDOWS) return;

  let oldestKey: string | undefined;
  let oldestStart = Infinity;
  for (const [key, state] of windows) {
    if (state.windowStart < oldestStart) {
      oldestStart = state.windowStart;
      oldestKey = key;
    }
  }
  if (oldestKey !== undefined) windows.delete(oldestKey);
}

/** Yalnızca testlerde: pencere sayaçlarını temizler. */
export function resetSamplerForTests(): void {
  windows.clear();
}

/** Yalnızca testlerde: mevcut anahtar sayısını gözlemler (üst sınır davranışını doğrulamak için). */
export function samplerWindowCountForTests(): number {
  return windows.size;
}
