import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import type { SessionUser } from "@/lib/auth/session";

/**
 * YF-703 — `POST /api/ai/ask` geçersiz/eksik istek gövdesini, sınıflandırma/
 * kanıt üretimi/AI kota rezervasyonu tetiklenmeden erkenden 400 ile
 * reddetmelidir (fail-closed) — bkz. app/api/ai/insights/route.ts için
 * tests/ai-insights-route-validation.test.ts ile aynı desen.
 */

const { getSessionUserMock, askYapiFinMock } = vi.hoisted(() => ({
  getSessionUserMock: vi.fn(),
  askYapiFinMock: vi.fn(),
}));

vi.mock("@/lib/auth/session", () => ({
  getSessionUser: getSessionUserMock,
}));
vi.mock("@/server/services/ask-yapifin-service", () => ({
  askYapiFin: askYapiFinMock,
}));

import { POST } from "@/app/api/ai/ask/route";

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
  return new NextRequest("https://app.example.com/api/ai/ask", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/ai/ask — fail-closed istek doğrulaması", () => {
  beforeEach(() => {
    getSessionUserMock.mockReset();
    askYapiFinMock.mockReset();
    getSessionUserMock.mockResolvedValue(actor);
  });

  it("oturum yoksa 401, servis hiç tetiklenmez", async () => {
    getSessionUserMock.mockResolvedValue(null);
    const res = await POST(postRequest({ question: "Bu ay toplam giderimiz ne kadar?" }));
    expect(res.status).toBe(401);
    expect(askYapiFinMock).not.toHaveBeenCalled();
  });

  it("soru alanı eksik -> 400, servis hiç tetiklenmez", async () => {
    const res = await POST(postRequest({}));
    expect(res.status).toBe(400);
    expect(askYapiFinMock).not.toHaveBeenCalled();
  });

  it("çok kısa soru (min(3) ihlali) -> 400", async () => {
    const res = await POST(postRequest({ question: "ok" }));
    expect(res.status).toBe(400);
    expect(askYapiFinMock).not.toHaveBeenCalled();
  });

  it("çok uzun soru (max(400) ihlali) -> 400", async () => {
    const res = await POST(postRequest({ question: "x".repeat(401) }));
    expect(res.status).toBe(400);
    expect(askYapiFinMock).not.toHaveBeenCalled();
  });

  it("geçersiz tipte question (number) -> 400", async () => {
    const res = await POST(postRequest({ question: 12345 }));
    expect(res.status).toBe(400);
    expect(askYapiFinMock).not.toHaveBeenCalled();
  });

  it("bozuk JSON gövdesi -> 400, servis hiç tetiklenmez", async () => {
    const req = new NextRequest("https://app.example.com/api/ai/ask", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not valid json",
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
    expect(askYapiFinMock).not.toHaveBeenCalled();
  });

  it("geçerli soru doğrulamayı geçer ve askYapiFin çağrılır", async () => {
    askYapiFinMock.mockResolvedValue({
      status: "unsupported",
      question: "test",
      reason: "x",
      generatedAt: new Date().toISOString(),
    });
    const res = await POST(postRequest({ question: "Bu ay toplam giderimiz ne kadar?" }));
    expect(res.status).toBe(200);
    expect(askYapiFinMock).toHaveBeenCalledTimes(1);
  });

  it("aşırı uzun idempotencyKey -> 400, servis hiç tetiklenmez", async () => {
    const res = await POST(postRequest({ question: "Bu ay toplam giderimiz ne kadar?", idempotencyKey: "x".repeat(201) }));
    expect(res.status).toBe(400);
    expect(askYapiFinMock).not.toHaveBeenCalled();
  });
});
