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

  afterEach(() => {
    resetHealthCacheForTests();
  });
});
