import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import type { SessionUser } from "@/lib/auth/session";

/**
 * YF-702 review fix — `POST /api/ai/insights` daha önce geçersiz istek
 * gövdesinde (`safeParse` başarısız) sessizce `idempotencyKey: undefined` ile
 * devam ediyordu; bu da geçersiz girdiyle bile finansal sinyal çıkarımını,
 * AI kota rezervasyonunu ve sağlayıcı çağrısını tetikleyebiliyordu. Bu test,
 * geçersiz gövdenin artık hiçbir yan etki (sinyal çıkarımı/kota/AI çağrısı)
 * OLMADAN erkenden 400 ile reddedildiğini doğrular (fail-closed).
 */

const { getSessionUserMock, getAiInsightsMock } = vi.hoisted(() => ({
  getSessionUserMock: vi.fn(),
  getAiInsightsMock: vi.fn(),
}));

vi.mock("@/lib/auth/session", () => ({
  getSessionUser: getSessionUserMock,
}));
vi.mock("@/server/services/ai-insights-service", () => ({
  getAiInsights: getAiInsightsMock,
}));

import { POST } from "@/app/api/ai/insights/route";

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

function postRequest(body: unknown) {
  return new NextRequest("https://app.example.com/api/ai/insights", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/ai/insights — fail-closed istek doğrulaması", () => {
  beforeEach(() => {
    getSessionUserMock.mockReset();
    getAiInsightsMock.mockReset();
    getSessionUserMock.mockResolvedValue(actor);
  });

  it("aşırı uzun idempotencyKey -> 400, sinyal çıkarımı/kota/AI sağlayıcısı hiç tetiklenmez", async () => {
    const res = await POST(postRequest({ idempotencyKey: "x".repeat(201) }));
    expect(res.status).toBe(400);
    expect(getAiInsightsMock).not.toHaveBeenCalled();
  });

  it("geçersiz tipte idempotencyKey (number) -> 400, sinyal çıkarımı/kota/AI sağlayıcısı hiç tetiklenmez", async () => {
    const res = await POST(postRequest({ idempotencyKey: 12345 }));
    expect(res.status).toBe(400);
    expect(getAiInsightsMock).not.toHaveBeenCalled();
  });

  it("boş string idempotencyKey (min(1) ihlali) -> 400", async () => {
    const res = await POST(postRequest({ idempotencyKey: "" }));
    expect(res.status).toBe(400);
    expect(getAiInsightsMock).not.toHaveBeenCalled();
  });

  it("geçerli (veya eksik) idempotencyKey doğrulamayı geçer ve getAiInsights çağrılır", async () => {
    getAiInsightsMock.mockResolvedValue({ insights: [], generatedAt: new Date().toISOString(), signalCount: 0, truncated: false });
    const res = await POST(postRequest({}));
    expect(res.status).toBe(200);
    expect(getAiInsightsMock).toHaveBeenCalledTimes(1);
  });
});
