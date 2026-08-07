// YF-514 — Konteyner meta verisinden DATABASE_URL kurulumu için saf
// yardımcılar. Docker çağrısı YAPMAZ (testlenebilir olması için Docker
// çağıran koddan ayrıştırılmıştır) — bkz. test-db-harness.mjs.

const FIELD_LABELS = {
  port: "port (label)",
  dbName: "veritabanı adı (label)",
  password: "POSTGRES_PASSWORD (env)",
};

export class MissingContainerMetadataError extends Error {
  constructor(containerName, missingFields) {
    super(
      `Konteyner '${containerName}' için gerekli meta veri okunamadı: ` +
        `${missingFields.map((f) => FIELD_LABELS[f]).join(", ")}. ` +
        `Konteyner bozulmuş ya da bu harness dışında değiştirilmiş olabilir. ` +
        `Kurtarma: node scripts/test-db-harness.mjs down --run-id <runId> ile temizleyip yeniden 'up'/'run' çalıştırın.`,
    );
    this.name = "MissingContainerMetadataError";
    this.containerName = containerName;
    this.missingFields = missingFields;
  }
}

// Zorunlu bağlantı meta verisini doğrular. Eksik alan varsa DATABASE_URL
// HİÇ oluşturulmadan, hangi alanın eksik olduğunu açıkça belirten bir hata
// fırlatır — parola değeri asla hata mesajına yazılmaz.
export function validateContainerMetadata(containerName, { port, dbName, password }) {
  const missing = [];
  if (!port) missing.push("port");
  if (!dbName) missing.push("dbName");
  if (!password) missing.push("password");
  if (missing.length > 0) {
    throw new MissingContainerMetadataError(containerName, missing);
  }
  return { port, dbName, password };
}

export function buildDatabaseUrl({ dbName, password, port }) {
  return `postgresql://${dbName}:${password}@127.0.0.1:${port}/${dbName}?schema=public`;
}

// Mevcut bir runId konteyneriyle karşılaşıldığında hangi eylemin
// uygulanacağına karar veren saf fonksiyon: çalışıyorsa yalnızca hazırlık
// doğrulanır (yeniden başlatılmaz); durmuşsa yeniden başlatılır.
export function decideReviveAction({ running }) {
  return running ? "verify" : "restart";
}
