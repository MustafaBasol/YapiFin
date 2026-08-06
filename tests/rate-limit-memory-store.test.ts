import { describe, it, expect, beforeEach } from "vitest";
import { checkMemoryFixedWindow, resetMemoryStoreForTests } from "@/lib/rate-limit/memory-store";

describe("checkMemoryFixedWindow (Redis kesintisinde per-instance yedek)", () => {
  beforeEach(() => resetMemoryStoreForTests());

  it("limit altındaki istekler geçer", () => {
    for (let i = 0; i < 5; i++) {
      expect(checkMemoryFixedWindow("k1", 60_000, 5).allowed).toBe(true);
    }
  });

  it("limit aşıldığında engellenir ve pozitif bir retryAfterMs döner", () => {
    for (let i = 0; i < 3; i++) checkMemoryFixedWindow("k2", 60_000, 3);
    const result = checkMemoryFixedWindow("k2", 60_000, 3);
    expect(result.allowed).toBe(false);
    expect(result.retryAfterMs).toBeGreaterThan(0);
  });

  it("farklı anahtarlar (scope) birbirini yanlışlıkla etkilemez", () => {
    for (let i = 0; i < 3; i++) checkMemoryFixedWindow("k3a", 60_000, 3);
    expect(checkMemoryFixedWindow("k3a", 60_000, 3).allowed).toBe(false);
    expect(checkMemoryFixedWindow("k3b", 60_000, 3).allowed).toBe(true);
  });

  it("pencere sona erdiğinde tekrar izin verir", async () => {
    for (let i = 0; i < 2; i++) checkMemoryFixedWindow("k4", 50, 2);
    expect(checkMemoryFixedWindow("k4", 50, 2).allowed).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(checkMemoryFixedWindow("k4", 50, 2).allowed).toBe(true);
  });
});
