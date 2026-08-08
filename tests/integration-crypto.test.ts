import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { getEnv, resetEnvCacheForTests } from "@/lib/env";
import {
  encryptIntegrationSecret,
  decryptIntegrationSecret,
  IntegrationEncryptionConfigError,
  CURRENT_KEY_VERSION,
} from "@/lib/integration-crypto";

const KEY_A = "a".repeat(64);
const KEY_B = "b".repeat(64);

let originalEnv: Record<string, string | undefined>;

function setKey(value: string | undefined) {
  if (value === undefined) delete process.env.INTEGRATION_ENCRYPTION_KEY;
  else process.env.INTEGRATION_ENCRYPTION_KEY = value;
  resetEnvCacheForTests();
}

describe("lib/integration-crypto", () => {
  beforeEach(() => {
    originalEnv = { ...process.env };
    // Diğer testlerin (tests/env.test.ts) çektiği tüm zorunlu alanları
    // sağlıyoruz ki getEnv() burada da başarıyla parse edilsin.
    process.env.DATABASE_URL ??= "postgresql://user:pass@localhost:5432/db";
    process.env.AUTH_SECRET ??= "a".repeat(32);
    process.env.NEXT_PUBLIC_APP_URL ??= "https://app.example.com";
  });

  afterEach(() => {
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) delete process.env[key];
    }
    Object.assign(process.env, originalEnv);
    resetEnvCacheForTests();
  });

  it("düz metni şifreler ve aynı anahtarla doğru şekilde çözer (round-trip)", () => {
    setKey(KEY_A);
    const plaintext = "super-gizli-api-anahtari-12345";
    const encrypted = encryptIntegrationSecret(plaintext);
    expect(encrypted.keyVersion).toBe(CURRENT_KEY_VERSION);
    expect(encrypted.ciphertext).not.toContain(plaintext);

    const decrypted = decryptIntegrationSecret(encrypted);
    expect(decrypted).toBe(plaintext);
  });

  it("her şifrelemede farklı bir IV üretir (aynı düz metin için bile)", () => {
    setKey(KEY_A);
    const a = encryptIntegrationSecret("aynı-değer");
    const b = encryptIntegrationSecret("aynı-değer");
    expect(a.iv).not.toBe(b.iv);
    expect(a.ciphertext).not.toBe(b.ciphertext);
  });

  it("anahtar yapılandırılmamışsa şifreleme fail-closed hata fırlatır", () => {
    setKey(undefined);
    expect(() => encryptIntegrationSecret("değer")).toThrow(IntegrationEncryptionConfigError);
  });

  it("anahtar yapılandırılmamışsa çözme fail-closed hata fırlatır", () => {
    setKey(KEY_A);
    const encrypted = encryptIntegrationSecret("değer");
    setKey(undefined);
    expect(() => decryptIntegrationSecret(encrypted)).toThrow(IntegrationEncryptionConfigError);
  });

  it("yanlış anahtarla çözme güvenli şekilde başarısız olur (düz metin sızdırmaz)", () => {
    setKey(KEY_A);
    const encrypted = encryptIntegrationSecret("gizli-değer");
    setKey(KEY_B);
    expect(() => decryptIntegrationSecret(encrypted)).toThrow();
  });

  it("kurcalanmış ciphertext güvenli şekilde başarısız olur", () => {
    setKey(KEY_A);
    const encrypted = encryptIntegrationSecret("gizli-değer");
    const tamperedBytes = Buffer.from(encrypted.ciphertext, "base64");
    tamperedBytes[0] = tamperedBytes[0] ^ 0xff;
    const tampered = { ...encrypted, ciphertext: tamperedBytes.toString("base64") };
    expect(() => decryptIntegrationSecret(tampered)).toThrow();
  });

  it("kurcalanmış authTag güvenli şekilde başarısız olur", () => {
    setKey(KEY_A);
    const encrypted = encryptIntegrationSecret("gizli-değer");
    const tamperedBytes = Buffer.from(encrypted.authTag, "base64");
    tamperedBytes[0] = tamperedBytes[0] ^ 0xff;
    const tampered = { ...encrypted, authTag: tamperedBytes.toString("base64") };
    expect(() => decryptIntegrationSecret(tampered)).toThrow();
  });

  it("desteklenmeyen keyVersion fail-closed hata fırlatır", () => {
    setKey(KEY_A);
    const encrypted = encryptIntegrationSecret("gizli-değer");
    expect(() => decryptIntegrationSecret({ ...encrypted, keyVersion: 99 })).toThrow(IntegrationEncryptionConfigError);
  });

  it("hata mesajları düz metni veya anahtarı içermez", () => {
    setKey(KEY_A);
    const plaintext = "asla-sızmamalı-gizli-deger";
    const encrypted = encryptIntegrationSecret(plaintext);
    setKey(KEY_B);
    let message = "";
    try {
      decryptIntegrationSecret(encrypted);
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).not.toContain(plaintext);
    expect(message).not.toContain(KEY_A);
    expect(message).not.toContain(KEY_B);
  });

  it("anahtar tanımsızken getEnv() hatasız çalışır (opt-in — uygulama başlangıcı etkilenmez)", () => {
    setKey(undefined);
    const env = getEnv();
    expect(env.integrationEncryptionKey).toBeNull();
  });
});
