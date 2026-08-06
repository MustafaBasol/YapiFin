import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import type { Redis } from "ioredis";
import { createRedisClient } from "@/lib/rate-limit/redis-client";
import { checkFixedWindow } from "@/lib/rate-limit/store";
import { enforceRateLimit } from "@/lib/rate-limit/policy";
import { db } from "@/lib/db";
import { authenticateUser } from "@/server/services/auth-service";
import { createInvitation } from "@/server/services/invitation-service";
import { cleanDatabase, createOwnerOrg } from "./helpers";

/**
 * YF-509 — GERÇEK bir Redis'e karşı çalışan dağıtık rate limit entegrasyon
 * testleri. `scripts/run-redis-integration-tests.mjs` tarafından
 * `REDIS_URL` bir disposable konteynere (ya da CI'da sağlanan servise)
 * işaret edecek şekilde ayarlanmış olarak çalıştırılır. `npm run test`
 * (vitest.config.ts) bu dosyayı hariç tutar — bkz. o dosyadaki `exclude`.
 */
if (!process.env.REDIS_URL) {
  throw new Error("REDIS_URL tanımlı değil — bu dosya yalnızca `npm run test:redis-integration` üzerinden çalıştırılmalıdır.");
}
const REDIS_URL: string = process.env.REDIS_URL;

let client: Redis;

beforeAll(async () => {
  client = createRedisClient(REDIS_URL);
  await client.connect();
  await cleanDatabase();
});

beforeEach(async () => {
  // Disposable, göreve özel bir Redis — testler arasında tam temizlik
  // güvenlidir ve senaryoları birbirinden tamamen izole eder.
  await client.flushdb();
});

afterAll(async () => {
  await cleanDatabase();
  await db.$disconnect();
  await client.quit();
});

describe("checkFixedWindow — atomik Redis store", () => {
  it("limit altındaki istekler geçer", async () => {
    for (let i = 0; i < 4; i++) {
      const result = await checkFixedWindow(client, "test:under-limit", 60_000, 5);
      expect(result.allowed).toBe(true);
    }
  });

  it("limit aşıldığında engellenir (429 karşılığı) ve pozitif retryAfterMs döner", async () => {
    for (let i = 0; i < 3; i++) {
      await checkFixedWindow(client, "test:over-limit", 60_000, 3);
    }
    const blocked = await checkFixedWindow(client, "test:over-limit", 60_000, 3);
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterMs).toBeGreaterThan(0);
  });

  it("pencere sona erdiğinde tekrar izin verir", async () => {
    const key = "test:window-reset";
    for (let i = 0; i < 2; i++) await checkFixedWindow(client, key, 300, 2);
    expect((await checkFixedWindow(client, key, 300, 2)).allowed).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect((await checkFixedWindow(client, key, 300, 2)).allowed).toBe(true);
  });

  it("iki farklı application instance (bağımsız Redis bağlantısı) ortak limiti görür", async () => {
    const instanceA = createRedisClient(REDIS_URL);
    const instanceB = createRedisClient(REDIS_URL);
    await instanceA.connect();
    await instanceB.connect();
    try {
      const key = "test:multi-instance";
      const limit = 5;

      const fromA = await Promise.all(Array.from({ length: 3 }, () => checkFixedWindow(instanceA, key, 60_000, limit)));
      const fromB = await Promise.all(Array.from({ length: 3 }, () => checkFixedWindow(instanceB, key, 60_000, limit)));

      const allowedCount = [...fromA, ...fromB].filter((r) => r.allowed).length;
      // Toplam 6 istek, paylaşımlı limit 5 — instance'lar arası sayaç
      // paylaşıldığı için tam olarak 5'i geçmeli (tek instance'a bağlı
      // bellek-içi bir sayaç olsaydı her instance kendi 3'lük limitini
      // ayrı ayrı uygular ve 6'sı da geçerdi).
      expect(allowedCount).toBe(5);
    } finally {
      await instanceA.quit();
      await instanceB.quit();
    }
  });

  it("atomik concurrency: eşzamanlı istekler arasında sayaç kaybı/aşımı olmaz", async () => {
    const key = "test:concurrency";
    const limit = 10;
    const totalRequests = 30;

    const results = await Promise.all(
      Array.from({ length: totalRequests }, () => checkFixedWindow(client, key, 60_000, limit)),
    );

    const allowedCount = results.filter((r) => r.allowed).length;
    // GET-sonra-SET gibi atomik olmayan bir desende yarış koşulu ya
    // limit'ten fazla isteğin geçmesine (sayaç kaybı) ya da limit'in altında
    // izin verilmesine (yanlış aşırı-sayım) yol açabilirdi. Lua script
    // atomikliği sayesinde sonuç her zaman tam olarak `limit` kadardır.
    expect(allowedCount).toBe(limit);
  });
});

describe("enforceRateLimit — politika kataloğu (gerçek Redis)", () => {
  it("endpointler (politikalar) birbirinden doğru scope edilir", async () => {
    const ip = "198.51.100.10";
    const email = "scope-test@example.com";

    for (let i = 0; i < 10; i++) await enforceRateLimit("login", [ip, email]);
    const loginExhausted = await enforceRateLimit("login", [ip, email]);
    expect(loginExhausted.allowed).toBe(false);

    // Aynı ip+email, FARKLI bir politika (forgot-password) altında hâlâ
    // kendi (henüz tüketilmemiş) bütçesine sahiptir.
    const forgotPassword = await enforceRateLimit("forgot-password", [ip, email]);
    expect(forgotPassword.allowed).toBe(true);
  });

  it("farklı IP/e-posta scope'ları birbirini yanlışlıkla etkilemez", async () => {
    const email = "shared-email@example.com";
    for (let i = 0; i < 10; i++) await enforceRateLimit("login", ["198.51.100.20", email]);
    expect((await enforceRateLimit("login", ["198.51.100.20", email])).allowed).toBe(false);

    // Farklı IP, aynı e-posta — ayrı bütçe.
    expect((await enforceRateLimit("login", ["198.51.100.21", email])).allowed).toBe(true);

    const ip = "198.51.100.22";
    for (let i = 0; i < 10; i++) await enforceRateLimit("login", [ip, "user-a@example.com"]);
    expect((await enforceRateLimit("login", [ip, "user-a@example.com"])).allowed).toBe(false);

    // Aynı IP, farklı e-posta — ayrı bütçe.
    expect((await enforceRateLimit("login", [ip, "user-b@example.com"])).allowed).toBe(true);
  });

  it("organizationId ile scope edilen politikalarda (invite-create) tenant'lar arası bütçe karışmaz", async () => {
    const orgA = "org-aaaaaaaa-1111";
    const orgB = "org-bbbbbbbb-2222";
    for (let i = 0; i < 20; i++) await enforceRateLimit("invite-create", [orgA]);
    expect((await enforceRateLimit("invite-create", [orgA])).allowed).toBe(false);

    // organizationId'si farklı bir tenant, A'nın tükettiği bütçeden
    // etkilenmez — rate limiter tenant izolasyonunu BOZMAZ, ayrıca
    // kendi kapsamında da izole çalışır.
    expect((await enforceRateLimit("invite-create", [orgB])).allowed).toBe(true);
  });

  it("key ve loglarda PII bulunmaz (ham IP/e-posta Redis anahtarlarında veya log satırlarında geçmez)", async () => {
    const rawIp = "203.0.113.77";
    const rawEmail = "pii-marker-should-not-leak@example.com";

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      for (let i = 0; i < 11; i++) await enforceRateLimit("login", [rawIp, rawEmail]);

      const keys = await client.keys("ratelimit:*");
      expect(keys.length).toBeGreaterThan(0);
      for (const key of keys) {
        expect(key).not.toContain(rawIp);
        expect(key).not.toContain(rawEmail);
        expect(key).not.toContain("pii-marker");
      }

      const loggedRaw = logSpy.mock.calls.some(
        (call) => typeof call[0] === "string" && (call[0].includes(rawIp) || call[0].includes(rawEmail)),
      );
      expect(loggedRaw).toBe(false);
    } finally {
      logSpy.mockRestore();
    }
  });
});

describe("auth davranışı rate limiter ile bozulmaz (gerçek DB + gerçek Redis)", () => {
  it("limit altındayken başarılı giriş servis katmanında normal çalışır", async () => {
    const { owner } = await createOwnerOrg({ password: "Sifre1234" });
    const decision = await enforceRateLimit("login", ["203.0.113.50", owner.email]);
    expect(decision.allowed).toBe(true);

    const user = await authenticateUser(owner.email, "Sifre1234");
    expect(user.id).toBe(owner.id);
  });

  it("yanlış parolayla giriş, rate limit'ten bağımsız olarak yine reddedilir", async () => {
    const { owner } = await createOwnerOrg({ password: "Sifre1234" });
    const decision = await enforceRateLimit("login", ["203.0.113.51", owner.email]);
    expect(decision.allowed).toBe(true);

    await expect(authenticateUser(owner.email, "YanlisParola1")).rejects.toMatchObject({ code: "VALIDATION" });
  });

  it("bir organizasyonun daveti sınırına ulaşması diğer organizasyonun davet oluşturmasını etkilemez (tenant izolasyonu korunur)", async () => {
    const { owner: ownerA } = await createOwnerOrg();
    const { owner: ownerB } = await createOwnerOrg();

    for (let i = 0; i < 20; i++) await enforceRateLimit("invite-create", [ownerA.organizationId]);
    expect((await enforceRateLimit("invite-create", [ownerA.organizationId])).allowed).toBe(false);

    // B'nin kendi bütçesi hâlâ dolu değil — gerçek createInvitation servis
    // çağrısı da (rate limiter'dan bağımsız olarak) normal çalışmaya devam eder.
    const decisionB = await enforceRateLimit("invite-create", [ownerB.organizationId]);
    expect(decisionB.allowed).toBe(true);
    await expect(
      createInvitation(ownerB, { email: "davetli@example.com", role: "FINANCE", projectIds: [] }),
    ).resolves.toBeTruthy();
  });
});
