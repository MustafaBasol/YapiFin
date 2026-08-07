import { db } from "@/lib/db";

/**
 * YF-511 — `/api/health` için sınırlı (bounded) veritabanı erişilebilirlik
 * kontrolü.
 *
 * İki koruma katmanı vardır:
 * 1. `TIMEOUT_MS`: tek bir yavaş/asılı kalmış DB bağlantısı health probe'unu
 *    (dolayısıyla onu bekleyen load balancer/orkestratör kararını) süresiz
 *    beklemesin diye `Promise.race` ile sınırlanır — `lib/rate-limit/redis-client.ts`'teki
 *    aynı gerekçe (CONNECT_TIMEOUT_MS/COMMAND_TIMEOUT_MS).
 * 2. `CACHE_TTL_MS`: izleme sistemleri health endpoint'ini genellikle çok
 *    sık (birkaç saniyede bir) çağırır — her çağrıda gerçek bir DB sorgusu
 *    çalıştırmak (tek instance başına) gereksiz yük oluşturur. Kısa bir
 *    TTL, gerçek kesinti tespitini anlamlı ölçüde geciktirmeden bu yükü
 *    sınırlar.
 */
const TIMEOUT_MS = 2000;
const CACHE_TTL_MS = 1000;

let cached: { healthy: boolean; expiresAt: number } | null = null;
// Aynı anda gelen çağrılar arasında tek `SELECT 1` paylaşılsın diye devam
// eden probe'un promise'i tutulur — üst üste gelen istekler DB'yi tekrar
// dövmez, hepsi aynı sonucu bekler.
let inFlight: Promise<boolean> | null = null;

function timeout(ms: number): Promise<never> {
  return new Promise((_, reject) => {
    setTimeout(() => reject(new Error("db_check_timeout")), ms);
  });
}

/** DB'ye minimal maliyetli `SELECT 1` ile ulaşılabilirliği doğrular; hata/timeout durumunda `false` döner (asla fırlatmaz). */
export async function checkDatabase(): Promise<boolean> {
  const now = Date.now();
  if (cached && now < cached.expiresAt) return cached.healthy;
  if (inFlight) return inFlight;

  inFlight = (async () => {
    let healthy: boolean;
    try {
      await Promise.race([db.$queryRaw`SELECT 1`, timeout(TIMEOUT_MS)]);
      healthy = true;
    } catch {
      // Ham hata (bağlantı dizesi, host, sürücü mesajı içerebilir) kasıtlı
      // olarak yutulur — çağıran taraf (route handler) yalnızca boolean görür,
      // asla DB hata detayını dışa yansıtmaz.
      healthy = false;
    }

    // TTL, probe TAMAMLANDIKTAN sonraki zamana göre hesaplanır — yavaş/timeout
    // olan bir sonuç, `now` (probe başlangıcı) yerine tamamlanma anından
    // itibaren tam CACHE_TTL_MS süresince önbellekte kalır. Aksi halde 2s'ye
    // yakın süren bir probe, kaydedildiği anda zaten süresi dolmuş bir önbellek
    // girdisi üretir ve kesinti sırasında her istek DB'yi tekrar dövmüş olur.
    cached = { healthy, expiresAt: Date.now() + CACHE_TTL_MS };
    return healthy;
  })();

  try {
    return await inFlight;
  } finally {
    inFlight = null;
  }
}

/** Yalnızca testlerde: önbelleği temizler. */
export function resetHealthCacheForTests(): void {
  cached = null;
  inFlight = null;
}
