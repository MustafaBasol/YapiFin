import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const queryRawMock = vi.fn();

vi.mock("@/lib/db", () => ({
  db: { $queryRaw: (...args: unknown[]) => queryRawMock(...args) },
}));

const { checkDatabase, resetHealthCacheForTests } = await import("@/lib/health/db-check");
const { GET } = await import("@/app/api/health/route");

describe("GET /api/health", () => {
  beforeEach(() => {
    resetHealthCacheForTests();
    queryRawMock.mockReset();
  });

  it("DB erişilebilir → 200, minimal gövde, no-store", async () => {
    queryRawMock.mockResolvedValue([{ "?column?": 1 }]);
    const res = await GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
  });

  it("DB hatası → 503, hata detayı sızdırmaz", async () => {
    queryRawMock.mockRejectedValue(new Error("connection refused to postgres://user:secret@db-host:5432/prod"));
    const res = await GET();
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body).toEqual({ status: "error" });
    expect(JSON.stringify(body)).not.toContain("postgres://");
    expect(JSON.stringify(body)).not.toContain("secret");
    expect(JSON.stringify(body)).not.toContain("db-host");
  });

  it("YF-512: DB hatası güvenli, sınıflandırılmış bir log satırı üretir — ham hata mesajını/bağlantı dizesini içermez", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    queryRawMock.mockRejectedValue(new Error("connection refused to postgres://user:secret@db-host:5432/prod"));

    await checkDatabase();

    expect(warnSpy).toHaveBeenCalledTimes(1);
    const logged = JSON.parse(warnSpy.mock.calls[0][0] as string);
    expect(logged.event).toBe("db.health_check_failed");
    expect(logged.category).toBeTypeOf("string");
    const rawLoggedText = warnSpy.mock.calls[0][0] as string;
    expect(rawLoggedText).not.toContain("postgres://");
    expect(rawLoggedText).not.toContain("secret");
    expect(rawLoggedText).not.toContain("db-host");

    warnSpy.mockRestore();
  });

  it("YF-511 davranışı değişmez: başarılı probe'da güvenlik/hata log satırı yazılmaz", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    queryRawMock.mockResolvedValue([{ "?column?": 1 }]);

    const res = await GET();

    expect(res.status).toBe(200);
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("DB zaman aşımına uğrarsa (asılı kalırsa) → 503", async () => {
    queryRawMock.mockImplementation(() => new Promise(() => {})); // asla resolve olmaz
    const res = await GET();
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ status: "error" });
  }, 10_000);

  it("ardışık probe'lar kısa pencerede tek DB sorgusu üretir (önbellek)", async () => {
    queryRawMock.mockResolvedValue([{ "?column?": 1 }]);
    await checkDatabase();
    await checkDatabase();
    await checkDatabase();
    expect(queryRawMock).toHaveBeenCalledTimes(1);
  });

  it("önbellek süresi dolduktan sonra yeniden sorgu çalıştırır", async () => {
    queryRawMock.mockResolvedValue([{ "?column?": 1 }]);
    await checkDatabase();
    expect(queryRawMock).toHaveBeenCalledTimes(1);
    await new Promise((r) => setTimeout(r, 1100));
    await checkDatabase();
    expect(queryRawMock).toHaveBeenCalledTimes(2);
  }, 10_000);

  it("yavaş/timeout olan sonuç, TAMAMLANMA anından itibaren tam TTL süresince önbellekte kalır", async () => {
    queryRawMock.mockImplementation(() => new Promise(() => {})); // asla resolve olmaz → 2s timeout'a düşer
    const started = Date.now();
    const first = await checkDatabase();
    const probeElapsedMs = Date.now() - started;
    expect(first).toBe(false);
    // Probe'un kendisi ~2s sürdü; TTL bu tamamlanma anından itibaren sayılmalı.
    expect(probeElapsedMs).toBeGreaterThanOrEqual(1900);

    // Tamamlanmadan hemen sonra, TTL (1s) dolmadan önbellek hâlâ geçerli olmalı —
    // eski davranışta (start-time'dan hesaplanan expiresAt) bu noktada önbellek
    // zaten süresi dolmuş sayılıp yeniden sorgu tetiklerdi.
    await new Promise((r) => setTimeout(r, 900));
    const second = await checkDatabase();
    expect(second).toBe(false);
    expect(queryRawMock).toHaveBeenCalledTimes(1);

    // Tamamlanma anından itibaren tam TTL geçince yeniden sorgulanır.
    await new Promise((r) => setTimeout(r, 300));
    await checkDatabase();
    expect(queryRawMock).toHaveBeenCalledTimes(2);
  }, 15_000);

  it("eşzamanlı çağrılar devam eden probe'u paylaşır, yinelenen sorgu üretmez", async () => {
    let resolveQuery: (value: unknown) => void = () => {};
    queryRawMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveQuery = resolve;
        }),
    );

    const [p1, p2, p3] = [checkDatabase(), checkDatabase(), checkDatabase()];
    resolveQuery([{ "?column?": 1 }]);
    const results = await Promise.all([p1, p2, p3]);

    expect(results).toEqual([true, true, true]);
    expect(queryRawMock).toHaveBeenCalledTimes(1);
  });

  afterEach(() => {
    resetHealthCacheForTests();
  });
});
