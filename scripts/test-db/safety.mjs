// YF-514 — Harness'in üreteceği/kullanacağı her DATABASE_URL, testleri
// çalıştırmadan ÖNCE bu koruma katmanından geçmelidir. Amaç: bir yanlış
// yapılandırma (yanlış .env, kalıntı ortam değişkeni, kopyala-yapıştır
// hatası) yüzünden gerçek/paylaşılan bir veritabanına yanlışlıkla
// bağlanılmasını (ve `cleanDatabase()` ile TÜM tablolarının silinmesini)
// engellemektir. Kapalı-durumda-başarısız (fail closed): şüpheli her şey
// reddedilir, yalnızca açıkça disposable/yerel görünen hedefler kabul edilir.

const LOCAL_HOSTNAMES = new Set(["localhost", "127.0.0.1", "::1"]);

// Üretim/staging benzeri veritabanı adlarında görülmesi muhtemel alt
// dizeler — harness'in kendi ürettiği adlar (yf514_<runId>) bunları asla
// içermez, bu yüzden eşleşme her zaman bir yapılandırma hatasına işaret eder.
const FORBIDDEN_DB_SUBSTRINGS = ["prod", "production", "staging", "stage", "live"];

export class UnsafeTestTargetError extends Error {
  constructor(message) {
    super(message);
    this.name = "UnsafeTestTargetError";
  }
}

/**
 * `databaseUrl`'nin disposable bir test hedefi olduğunu doğrular; değilse
 * fırlatır. `expected.port` / `expected.database` verilirse ek olarak tam
 * eşleşme zorunlu kılınır (harness'in az önce oluşturduğu konteynerle
 * gerçekten konuştuğumuzu doğrulamak için savunma amaçlı ikinci kontrol).
 */
export function assertDisposableTestTarget(databaseUrl, expected = {}) {
  let parsed;
  try {
    parsed = new URL(String(databaseUrl));
  } catch {
    throw new UnsafeTestTargetError("DATABASE_URL ayrıştırılamadı — disposable test hedefi olarak doğrulanamıyor.");
  }

  if (!/^postgres(ql)?:$/.test(parsed.protocol)) {
    throw new UnsafeTestTargetError(`Beklenmeyen protokol: ${parsed.protocol}`);
  }

  if (!LOCAL_HOSTNAMES.has(parsed.hostname)) {
    throw new UnsafeTestTargetError(
      `Host yerel değil (${parsed.hostname}) — yalnızca localhost/127.0.0.1 üzerindeki disposable konteynerlere bağlanılabilir.`,
    );
  }

  const dbName = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
  if (!dbName) {
    throw new UnsafeTestTargetError("DATABASE_URL bir veritabanı adı içermiyor.");
  }
  if (!dbName.startsWith("yf514_")) {
    throw new UnsafeTestTargetError(
      `Veritabanı adı ("${dbName}") bu harness tarafından üretilmiş görünmüyor (yf514_ öneki yok) — paylaşılan/kalıcı bir veritabanına yanlışlıkla bağlanılmış olabilir.`,
    );
  }
  const lowered = dbName.toLowerCase();
  for (const forbidden of FORBIDDEN_DB_SUBSTRINGS) {
    if (lowered.includes(forbidden)) {
      throw new UnsafeTestTargetError(`Veritabanı adı üretim/staging benzeri bir dize içeriyor ("${forbidden}"): ${dbName}`);
    }
  }

  if (expected.port !== undefined && String(parsed.port) !== String(expected.port)) {
    throw new UnsafeTestTargetError(`Port beklenenden farklı: ${parsed.port || "(boş)"} != ${expected.port}`);
  }
  if (expected.database !== undefined && dbName !== expected.database) {
    throw new UnsafeTestTargetError(`Veritabanı adı beklenenden farklı: ${dbName} != ${expected.database}`);
  }

  return { hostname: parsed.hostname, port: parsed.port, database: dbName };
}
