import { randomBytes, createHash } from "crypto";

/**
 * Opak token üretir: ham değer yalnızca kullanıcıya (cookie/e-posta linki)
 * gönderilir, veritabanında yalnızca SHA-256 özeti saklanır. Böylece DB
 * sızıntısı tek başına oturum/token ele geçirmeye yetmez.
 */
export function generateToken(): { raw: string; hash: string } {
  const raw = randomBytes(32).toString("base64url");
  return { raw, hash: hashToken(raw) };
}

export function hashToken(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}
