import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SessionUser } from "@/lib/auth/session";
import { ServiceError } from "@/server/services/errors";

/**
 * YF-805 — GET /api/plans route testleri. `ai-insights-route-validation.test.ts`
 * ile AYNI kalıp: oturum ve servis katmanı mock'lanır, yalnızca route
 * handler'ın auth/hata-eşleme davranışı doğrulanır (iş mantığı zaten
 * tests/plan-comparison.test.ts'te DB-backed olarak test edilir).
 */

const { getSessionUserMock, getPlanComparisonMock } = vi.hoisted(() => ({
  getSessionUserMock: vi.fn(),
  getPlanComparisonMock: vi.fn(),
}));

vi.mock("@/lib/auth/session", () => ({
  getSessionUser: getSessionUserMock,
}));
vi.mock("@/server/services/plan-comparison-service", () => ({
  getPlanComparison: getPlanComparisonMock,
}));

import { GET } from "@/app/api/plans/route";

const actor: SessionUser = {
  id: "user-1",
  organizationId: "org-1",
  firstName: "Test",
  lastName: "Owner",
  email: "owner@example.com",
  role: "OWNER",
  status: "ACTIVE",
  emailVerifiedAt: new Date(),
  organizationName: "Test Organizasyonu",
};

describe("GET /api/plans", () => {
  beforeEach(() => {
    getSessionUserMock.mockReset();
    getPlanComparisonMock.mockReset();
  });

  it("oturum yoksa 401 döner, servis HİÇ çağrılmaz", async () => {
    getSessionUserMock.mockResolvedValue(null);

    const res = await GET();

    expect(res.status).toBe(401);
    expect(getPlanComparisonMock).not.toHaveBeenCalled();
  });

  it("oturumdaki KULLANICININ organizationId'si dolaylı olarak kullanılır — istemciden org kimliği alınmaz", async () => {
    getSessionUserMock.mockResolvedValue(actor);
    getPlanComparisonMock.mockResolvedValue({ currentPlanCode: "PROFESSIONAL", plans: [], currentUsage: {} });

    await GET();

    // getPlanComparison YALNIZCA session'dan gelen actor ile çağrılır; route
    // handler hiçbir sorgu parametresi/gövde okumaz (istemciden org id kabul
    // edilmez, bkz. app/api/plans/route.ts).
    expect(getPlanComparisonMock).toHaveBeenCalledTimes(1);
    expect(getPlanComparisonMock).toHaveBeenCalledWith(actor);
  });

  it("geçerli oturumda servis sonucu 200 ile aynen döner", async () => {
    getSessionUserMock.mockResolvedValue(actor);
    const payload = { currentPlanCode: "PROFESSIONAL", plans: [{ code: "PROFESSIONAL" }], currentUsage: {} };
    getPlanComparisonMock.mockResolvedValue(payload);

    const res = await GET();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual(payload);
  });

  it("servis FORBIDDEN fırlatırsa 403 döner", async () => {
    getSessionUserMock.mockResolvedValue(actor);
    getPlanComparisonMock.mockRejectedValue(new ServiceError("Bu işlem için yetkiniz yok", "FORBIDDEN"));

    const res = await GET();

    expect(res.status).toBe(403);
  });

  it("beklenmeyen bir hata 500 ile Türkçe genel mesaj döner", async () => {
    getSessionUserMock.mockResolvedValue(actor);
    getPlanComparisonMock.mockRejectedValue(new Error("boom"));

    const res = await GET();
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body.error).toMatch(/beklenmeyen bir hata/);
  });
});
