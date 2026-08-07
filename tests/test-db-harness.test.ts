import { describe, expect, it } from "vitest";
import {
  sanitizeIdentifier,
  generateRunId,
  containerName,
  databaseName,
  roleName,
  generatePassword,
} from "../scripts/test-db/identifiers.mjs";
import { assertDisposableTestTarget, UnsafeTestTargetError } from "../scripts/test-db/safety.mjs";
import { redactConnectionString } from "../scripts/test-db/redact.mjs";
import {
  validateContainerMetadata,
  MissingContainerMetadataError,
  buildDatabaseUrl,
  decideReviveAction,
} from "../scripts/test-db/connection-info.mjs";

describe("test-db harness — identifier sterilizasyonu ve benzersizliği", () => {
  it("güvensiz karakterleri alt çizgiyle değiştirir ve küçük harfe çevirir", () => {
    expect(sanitizeIdentifier("Some Weird!! Name@123")).toBe("some_weird_name_123");
  });

  it("baştaki/sondaki alt çizgileri temizler ve boş girdi için düşmez", () => {
    expect(sanitizeIdentifier("")).toBe("run");
    expect(sanitizeIdentifier("---")).toBe("run");
  });

  it("çok uzun kimlikleri güvenli bir uzunluğa kırpar", () => {
    const long = "a".repeat(200);
    expect(sanitizeIdentifier(long).length).toBeLessThanOrEqual(40);
  });

  it("farklı pid/rastgele tohumlar farklı runId üretir", () => {
    const a = generateRunId({ pid: 111, random: "aaaaaa" });
    const b = generateRunId({ pid: 222, random: "bbbbbb" });
    expect(a).not.toBe(b);
  });

  it("aynı tohum aynı runId'yi üretir (deterministik, idempotent)", () => {
    const a = generateRunId({ pid: 111, random: "aaaaaa" });
    const b = generateRunId({ pid: 111, random: "aaaaaa" });
    expect(a).toBe(b);
  });

  it("konteyner/veritabanı/rol adları runId'ye göre benzersizdir ve çakışmaz", () => {
    const runIdA = generateRunId({ pid: 111, random: "aaaaaa" });
    const runIdB = generateRunId({ pid: 222, random: "bbbbbb" });

    expect(containerName(runIdA)).not.toBe(containerName(runIdB));
    expect(databaseName(runIdA)).not.toBe(databaseName(runIdB));
    expect(roleName(runIdA)).not.toBe(roleName(runIdB));

    expect(containerName(runIdA)).toMatch(/^yf514-testdb-/);
    expect(databaseName(runIdA)).toMatch(/^yf514_/);
  });

  it("veritabanı adı PostgreSQL 63 bayt tanımlayıcı sınırını aşmaz", () => {
    const runId = generateRunId({ pid: 999999999, random: "f".repeat(50) });
    expect(databaseName(runId).length).toBeLessThanOrEqual(63);
    expect(roleName(runId).length).toBeLessThanOrEqual(63);
  });

  it("parola her çağrıda farklı ve yeterince uzundur", () => {
    const p1 = generatePassword();
    const p2 = generatePassword();
    expect(p1).not.toBe(p2);
    expect(p1.length).toBeGreaterThanOrEqual(32);
  });
});

describe("test-db harness — disposable hedef doğrulaması (fail closed)", () => {
  const validUrl = "postgresql://yf514_abc123:secret@127.0.0.1:55432/yf514_abc123?schema=public";

  it("harness tarafından üretilen yerel, yf514_ önekli bir hedefi kabul eder", () => {
    expect(() => assertDisposableTestTarget(validUrl)).not.toThrow();
  });

  it("beklenen port/veritabanı adıyla eşleştiğinde de kabul eder", () => {
    expect(() =>
      assertDisposableTestTarget(validUrl, { port: "55432", database: "yf514_abc123" }),
    ).not.toThrow();
  });

  it("yerel olmayan bir host'u reddeder", () => {
    expect(() =>
      assertDisposableTestTarget("postgresql://user:pass@db.prod-example.com:5432/yf514_abc123"),
    ).toThrow(UnsafeTestTargetError);
  });

  it("yf514_ önekine sahip olmayan veritabanı adını reddeder (paylaşılan dev DB'si dahil)", () => {
    expect(() =>
      assertDisposableTestTarget("postgresql://yapifin:pw@127.0.0.1:5432/yapifin"),
    ).toThrow(UnsafeTestTargetError);
  });

  it.each(["yf514_production_x", "yf514_prod", "yf514_staging_db", "yf514_live_data"])(
    "üretim/staging benzeri bir dize içeren veritabanı adını reddeder: %s",
    (dbName) => {
      expect(() =>
        assertDisposableTestTarget(`postgresql://u:pw@127.0.0.1:5432/${dbName}`),
      ).toThrow(UnsafeTestTargetError);
    },
  );

  it("beklenen porttan farklı bir portu reddeder (savunma amaçlı ikinci kontrol)", () => {
    expect(() => assertDisposableTestTarget(validUrl, { port: "9999" })).toThrow(UnsafeTestTargetError);
  });

  it("beklenen veritabanı adından farklı bir adı reddeder", () => {
    expect(() => assertDisposableTestTarget(validUrl, { database: "yf514_other" })).toThrow(
      UnsafeTestTargetError,
    );
  });

  it("ayrıştırılamayan bir URL'i reddeder", () => {
    expect(() => assertDisposableTestTarget("not-a-url")).toThrow(UnsafeTestTargetError);
  });

  it("postgres(ql):// dışındaki bir protokolü reddeder", () => {
    expect(() => assertDisposableTestTarget("mysql://u:pw@127.0.0.1:3306/yf514_abc123")).toThrow(
      UnsafeTestTargetError,
    );
  });
});

describe("test-db harness — sır redaksiyonu", () => {
  it("kullanıcı adı ve parolayı *** ile değiştirir", () => {
    const redacted = redactConnectionString("postgresql://yf514_abc:s3cr3t-pass@127.0.0.1:5432/yf514_abc");
    expect(redacted).not.toContain("s3cr3t-pass");
    expect(redacted).not.toContain("yf514_abc:");
    expect(redacted).toBe("postgresql://***@127.0.0.1:5432/yf514_abc");
  });

  it("kimlik bilgisi olmayan bir URL'i olduğu gibi bırakır", () => {
    const url = "postgresql://127.0.0.1:5432/yf514_abc";
    expect(redactConnectionString(url)).toBe(url);
  });

  it("geçersiz/boş girdi için güvenli bir yer tutucu döndürür", () => {
    expect(redactConnectionString("")).toBe("***");
    expect(redactConnectionString(undefined)).toBe("***");
  });
});

describe("test-db harness — mevcut konteyner meta veri doğrulaması (fail closed)", () => {
  const full = { port: "55432", dbName: "yf514_abc123", password: "s3cr3t-pass" };

  it("tüm alanlar mevcutsa doğrulamayı geçer ve aynı değerleri döndürür", () => {
    expect(validateContainerMetadata("yf514-testdb-abc123", full)).toEqual(full);
  });

  it("port eksikse MissingContainerMetadataError fırlatır ve alanı adlandırır", () => {
    try {
      validateContainerMetadata("c1", { ...full, port: undefined });
      throw new Error("beklenen hata fırlatılmadı");
    } catch (err) {
      expect(err).toBeInstanceOf(MissingContainerMetadataError);
      expect((err as Error).message).toContain("port");
    }
  });

  it("veritabanı adı eksikse hata mesajında ilgili alanı belirtir", () => {
    try {
      validateContainerMetadata("c1", { ...full, dbName: undefined });
      throw new Error("beklenen hata fırlatılmadı");
    } catch (err) {
      expect(err).toBeInstanceOf(MissingContainerMetadataError);
      expect((err as Error).message).toContain("veritabanı adı");
    }
  });

  it("parola eksikse hata mesajı, parola değerini sızdırmadan yalnızca alan adını belirtir", () => {
    try {
      validateContainerMetadata("c1", { ...full, password: undefined });
      throw new Error("beklenen hata fırlatılmadı");
    } catch (err) {
      expect(err).toBeInstanceOf(MissingContainerMetadataError);
      expect((err as Error).message).toContain("POSTGRES_PASSWORD");
      expect((err as Error).message).not.toContain(full.password);
    }
  });

  it("birden fazla alan eksikse eksik alanların tamamını raporlar", () => {
    try {
      validateContainerMetadata("c1", { port: undefined, dbName: undefined, password: undefined });
      throw new Error("beklenen hata fırlatılmadı");
    } catch (err) {
      expect(err).toBeInstanceOf(MissingContainerMetadataError);
      expect((err as InstanceType<typeof MissingContainerMetadataError>).missingFields).toEqual([
        "port",
        "dbName",
        "password",
      ]);
    }
  });

  it("geçerli meta veriden ayrıştırılabilir (malformed olmayan) bir DATABASE_URL üretir", () => {
    const url = buildDatabaseUrl(full);
    expect(() => new URL(url)).not.toThrow();
    expect(url).toBe("postgresql://yf514_abc123:s3cr3t-pass@127.0.0.1:55432/yf514_abc123?schema=public");
  });
});

describe("test-db harness — durmuş/çalışan mevcut konteyner canlandırma kararı", () => {
  it("konteyner çalışıyorsa yalnızca hazırlığın doğrulanmasına karar verir (yeniden başlatmaz)", () => {
    expect(decideReviveAction({ running: true })).toBe("verify");
  });

  it("konteyner durmuşsa yeniden başlatma kararı verir", () => {
    expect(decideReviveAction({ running: false })).toBe("restart");
  });
});
