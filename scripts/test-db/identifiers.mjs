// YF-514 — Paralel worktree/agent'ların aynı yerel Postgres'i paylaşmasını
// önlemek için görev bazlı, benzersiz kaynak adları üreten saf fonksiyonlar.
// Yan etkisizdir (I/O yapmaz) — `tests/test-db-harness.test.ts` tarafından
// doğrudan test edilir.

import crypto from "node:crypto";

const MAX_IDENTIFIER_LENGTH = 40;
// PostgreSQL tanımlayıcı sınırı 63 bayttır (NAMEDATALEN - 1).
const MAX_POSTGRES_IDENTIFIER_LENGTH = 63;

/** Herhangi bir dizeyi güvenli, küçük harfli bir kimlik parçasına indirger. */
export function sanitizeIdentifier(input) {
  const lowered = String(input ?? "").toLowerCase();
  const cleaned = lowered.replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  const safe = cleaned.length > 0 ? cleaned : "run";
  return safe.length > MAX_IDENTIFIER_LENGTH ? safe.slice(0, MAX_IDENTIFIER_LENGTH) : safe;
}

/**
 * Görev bazlı benzersiz bir çalışma kimliği üretir. `seed` yalnızca testler
 * için deterministik değerler enjekte etmeye yarar; normal kullanımda
 * process.pid + kriptografik rastgelelik yeterlidir (aynı makinede paralel
 * çalışan iki worktree/agent'ın aynı anda aynı kimliği üretme olasılığı
 * ihmal edilebilir düzeydedir).
 */
export function generateRunId(seed = {}) {
  const pid = seed.pid ?? process.pid;
  const random = seed.random ?? crypto.randomBytes(3).toString("hex");
  return sanitizeIdentifier(`${pid}-${random}`);
}

export function containerName(runId) {
  return `yf514-testdb-${sanitizeIdentifier(runId)}`;
}

export function databaseName(runId) {
  const name = `yf514_${sanitizeIdentifier(runId)}`;
  return name.length > MAX_POSTGRES_IDENTIFIER_LENGTH ? name.slice(0, MAX_POSTGRES_IDENTIFIER_LENGTH) : name;
}

export function roleName(runId) {
  const name = `yf514_role_${sanitizeIdentifier(runId)}`;
  return name.length > MAX_POSTGRES_IDENTIFIER_LENGTH ? name.slice(0, MAX_POSTGRES_IDENTIFIER_LENGTH) : name;
}

export function generatePassword() {
  return crypto.randomBytes(18).toString("hex");
}

export const HARNESS_LABEL = "com.yapifin.testdb";
export const RUN_ID_LABEL = "com.yapifin.testdb.runid";
export const PORT_LABEL = "com.yapifin.testdb.port";
export const DB_LABEL = "com.yapifin.testdb.dbname";
