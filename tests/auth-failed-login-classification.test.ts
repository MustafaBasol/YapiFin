import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { resetSamplerForTests } from "@/lib/monitoring/sampler";
import { resetMemoryStoreForTests } from "@/lib/rate-limit/memory-store";
import { ServiceError } from "@/server/services/errors";
import type { MonitoringAdapter } from "@/lib/monitoring/adapter";

const { authenticateUserMock, createSessionMock } = vi.hoisted(() => ({
  authenticateUserMock: vi.fn(),
  createSessionMock: vi.fn(async () => {}),
}));

vi.mock("@/server/services/auth-service", () => ({
  authenticateUser: authenticateUserMock,
}));

vi.mock("@/lib/auth/session", () => ({
  createSession: createSessionMock,
}));

vi.mock("next/headers", () => ({
  headers: async () => ({ get: () => null }),
}));

import { loginAction } from "@/app/actions/auth";

function createMockAdapter(): MonitoringAdapter & {
  exceptions: Array<{ error: unknown }>;
  messages: Array<{ message: string; options?: { extra?: Record<string, unknown> } }>;
} {
  const exceptions: Array<{ error: unknown }> = [];
  const messages: Array<{ message: string; options?: { extra?: Record<string, unknown> } }> = [];
  return {
    exceptions,
    messages,
    captureException(error) {
      exceptions.push({ error });
    },
    captureMessage(message, options) {
      messages.push({ message, options });
    },
    async flush() {
      return true;
    },
  };
}

function loginFormData(email: string, password: string): FormData {
  const formData = new FormData();
  formData.set("email", email);
  formData.set("password", password);
  return formData;
}

describe("loginAction — failed_login güvenlik olayı yalnızca gerçek kimlik doğrulama hatasında üretilir", () => {
  let mock: ReturnType<typeof createMockAdapter>;

  beforeEach(async () => {
    resetSamplerForTests();
    resetMemoryStoreForTests();
    authenticateUserMock.mockReset();
    createSessionMock.mockReset();
    createSessionMock.mockImplementation(async () => {});
    const { setMonitoringAdapterForTests } = await import("@/lib/monitoring");
    mock = createMockAdapter();
    setMonitoringAdapterForTests(mock);
  });

  afterEach(async () => {
    const { resetMonitoringAdapterForTests } = await import("@/lib/monitoring");
    resetMonitoringAdapterForTests();
  });

  it("geçersiz kimlik bilgisi (ServiceError) => tam olarak bir sanitize edilmiş failed_login olayı ve toActionError'ın bilinen-hata mesajı", async () => {
    authenticateUserMock.mockRejectedValueOnce(new ServiceError("Geçersiz e-posta veya parola", "VALIDATION"));

    const result = await loginAction({}, loginFormData("kullanici@example.com", "yanlis-parola"));

    expect(mock.messages).toHaveLength(1);
    expect(mock.messages[0].message).toBe("security.failed_login");
    const payload = JSON.stringify(mock.messages[0]);
    expect(payload).not.toContain("kullanici@example.com");
    expect(payload).not.toContain("yanlis-parola");

    // Bilinen (ServiceError) hata dalı — captureException/genel istisna
    // yakalama TETİKLENMEZ, kullanıcıya doğrudan servis mesajı döner.
    expect(mock.exceptions).toHaveLength(0);
    expect(result).toEqual({ error: "Geçersiz e-posta veya parola" });
  });

  it("DB/altyapı hatası (authenticateUser içinde) => failed_login olayı YOK, hata yine de toActionError üzerinden genel işlenir", async () => {
    authenticateUserMock.mockRejectedValueOnce(new Error("connection terminated unexpectedly"));

    const result = await loginAction({}, loginFormData("kullanici@example.com", "herhangi-parola"));

    expect(mock.messages).toHaveLength(0);
    expect(mock.exceptions).toHaveLength(1);
    expect(result).toEqual({ error: "Beklenmeyen bir hata oluştu. Lütfen tekrar deneyin." });
  });

  it("oturum oluşturma hatası (createSession içinde, kimlik bilgisi doğruydu) => failed_login olayı YOK, hata toActionError üzerinden genel işlenir", async () => {
    authenticateUserMock.mockResolvedValueOnce({ id: "user-1" });
    createSessionMock.mockRejectedValueOnce(new Error("session insert failed"));

    const result = await loginAction({}, loginFormData("kullanici@example.com", "dogru-parola"));

    expect(mock.messages).toHaveLength(0);
    expect(mock.exceptions).toHaveLength(1);
    expect(result).toEqual({ error: "Beklenmeyen bir hata oluştu. Lütfen tekrar deneyin." });
  });

  it("beklenmeyen dahili istisna (ör. programlama hatası) => failed_login olayı YOK", async () => {
    authenticateUserMock.mockImplementationOnce(() => {
      throw new TypeError("unexpected internal failure");
    });

    const result = await loginAction({}, loginFormData("kullanici@example.com", "herhangi-parola"));

    expect(mock.messages).toHaveLength(0);
    expect(mock.exceptions).toHaveLength(1);
    expect(result).toEqual({ error: "Beklenmeyen bir hata oluştu. Lütfen tekrar deneyin." });
  });
});
