import { createCipheriv, createDecipheriv, randomBytes } from "crypto";
import { getEnv } from "@/lib/env";

/**
 * YF-605-A — entegrasyon kimlik bilgileri için AES-256-GCM zarf şifreleme.
 * `INTEGRATION_ENCRYPTION_KEY` (bkz. lib/env.ts) AUTH_SECRET'ten KASITLI
 * olarak ayrıdır; Node'un yerleşik `crypto` modülü dışında hiçbir üçüncü
 * taraf şifreleme kütüphanesi kullanılmaz (bkz. görev talimatı "Do not
 * invent custom cryptography").
 *
 * `CURRENT_KEY_VERSION`, ileride anahtar rotasyonu gerektiğinde birden fazla
 * anahtarın bir arada desteklenebilmesi için her şifreli kayıtla birlikte
 * saklanır (bkz. IntegrationCredential.keyVersion) — bugün tek bir aktif
 * anahtar sürümü vardır, bu alan yalnızca gelecekteki rotasyonu migration
 * gerektirmeden mümkün kılar.
 */
const ALGORITHM = "aes-256-gcm";
const IV_LENGTH_BYTES = 12;
const KEY_LENGTH_BYTES = 32;
export const CURRENT_KEY_VERSION = 1;

export class IntegrationEncryptionConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IntegrationEncryptionConfigError";
  }
}

export interface EncryptedSecret {
  ciphertext: string;
  iv: string;
  authTag: string;
  keyVersion: number;
}

/**
 * Yapılandırılmış anahtarı çözer. Anahtar tanımsız/geçersizse fail-closed
 * bir hata fırlatır — bu, uygulama başlangıcını ETKİLEMEZ (bkz. lib/env.ts,
 * `INTEGRATION_ENCRYPTION_KEY` her ortamda opsiyoneldir); yalnızca gerçek
 * bir şifreleme/çözme çağrısı bu hatayla karşılaşır.
 */
function resolveKey(): Buffer {
  const raw = getEnv().integrationEncryptionKey;
  if (!raw) {
    throw new IntegrationEncryptionConfigError(
      "INTEGRATION_ENCRYPTION_KEY yapılandırılmamış — entegrasyon kimlik bilgisi işlemleri kullanılamaz.",
    );
  }
  const key = Buffer.from(raw, "hex");
  if (key.length !== KEY_LENGTH_BYTES) {
    // lib/env.ts zaten 64 karakterlik hex biçimini doğrular; bu yalnızca
    // savunma amaçlı ikinci bir kontroldür (ör. testlerde doğrudan enjekte
    // edilen bozuk bir değer).
    throw new IntegrationEncryptionConfigError("INTEGRATION_ENCRYPTION_KEY geçersiz uzunlukta.");
  }
  return key;
}

/** Düz metni AES-256-GCM ile şifreler. `plaintext` veya anahtar ASLA hata mesajlarına veya loglara yazılmaz. */
export function encryptIntegrationSecret(plaintext: string): EncryptedSecret {
  const key = resolveKey();
  const iv = randomBytes(IV_LENGTH_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return {
    ciphertext: ciphertext.toString("base64"),
    iv: iv.toString("base64"),
    authTag: authTag.toString("base64"),
    keyVersion: CURRENT_KEY_VERSION,
  };
}

/**
 * Şifreli materyali çözer. Yanlış anahtar veya bozulmuş ciphertext/authTag
 * (kurcalama) durumunda Node'un GCM auth doğrulaması `final()` içinde
 * fırlatır — bu, hiçbir düz metin sızdırmadan güvenle üst katmana yayılır
 * (bkz. server/services/integrations/integration-service.ts, ServiceError'a
 * çevrilir).
 */
export function decryptIntegrationSecret(payload: EncryptedSecret): string {
  const key = resolveKey();
  if (payload.keyVersion !== CURRENT_KEY_VERSION) {
    throw new IntegrationEncryptionConfigError("Desteklenmeyen şifreleme anahtarı sürümü.");
  }
  const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(payload.iv, "base64"));
  decipher.setAuthTag(Buffer.from(payload.authTag, "base64"));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(payload.ciphertext, "base64")),
    decipher.final(),
  ]);
  return plaintext.toString("utf8");
}
