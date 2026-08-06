import { describe, it, expect, afterEach } from "vitest";
import { resetEnvCacheForTests } from "@/lib/env";
import { closeRedisClient } from "@/lib/rate-limit/redis-client";
import { enforceRateLimit } from "@/lib/rate-limit/policy";

const ORIGINAL_REDIS_URL = process.env.REDIS_URL;

async function setRedisUrl(url: string | undefined): Promise<void> {
  if (url === undefined) delete process.env.REDIS_URL;
  else process.env.REDIS_URL = url;
  await closeRedisClient();
  resetEnvCacheForTests();
}

describe("enforceRateLimit — Redis kesinti politikası (fail-open, no total lockout)", () => {
  afterEach(async () => {
    await setRedisUrl(ORIGINAL_REDIS_URL);
  });

  it("REDIS_URL tanımsızken (dev/test) süreç-içi yedeğe düşer ve isteği engellemez", async () => {
    await setRedisUrl(undefined);
    const decision = await enforceRateLimit("login", [`unit-test-unconfigured-${Date.now()}`]);
    expect(decision.allowed).toBe(true);
    expect(decision.source).toBe("memory-fallback");
  });

  it("Redis'e ulaşılamadığında (dinlenmeyen port) fail-open uygular ve kullanıcı kilitlenmez", async () => {
    // 127.0.0.1:1 — gerçek ama dinlenmeyen bir port, hızlı ECONNREFUSED verir.
    await setRedisUrl("redis://127.0.0.1:1");
    const decision = await enforceRateLimit("login", [`unit-test-unreachable-${Date.now()}`]);
    expect(decision.allowed).toBe(true);
    expect(decision.source).toBe("memory-fallback");
  }, 15_000);

  it("yedek modda da limit uygulanır — kesinti sırasında sınırsız istek geçmez", async () => {
    await setRedisUrl("redis://127.0.0.1:1");
    const key = `unit-test-fallback-limit-${Date.now()}`;
    let sawBlocked = false;
    for (let i = 0; i < 15; i++) {
      const decision = await enforceRateLimit("login", [key]);
      if (!decision.allowed) sawBlocked = true;
    }
    expect(sawBlocked).toBe(true);
  }, 30_000);
});
