import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { resetEnvCacheForTests } from "@/lib/env";
import { redact } from "@/lib/monitoring/redact";
import { resetSamplerForTests } from "@/lib/monitoring/sampler";
import type { MonitoringAdapter } from "@/lib/monitoring/adapter";

const BASE_ENV: Record<string, string> = {
  NODE_ENV: "development",
  DATABASE_URL: "postgresql://user:pass@localhost:5432/db",
  AUTH_SECRET: "a".repeat(32),
  NEXT_PUBLIC_APP_URL: "https://app.example.com",
  NEXT_PUBLIC_APP_NAME: "YapiFin",
  REDIS_URL: "rediss://user:pass@redis.example.com:6380",
  TRUSTED_PROXY_COUNT: "1",
};

const MANAGED_KEYS = [
  ...Object.keys(BASE_ENV),
  "SENTRY_DSN",
  "SENTRY_ENVIRONMENT",
  "SENTRY_TRACES_SAMPLE_RATE",
  "SMTP_HOST",
  "SMTP_PORT",
  "SMTP_USER",
  "SMTP_PASSWORD",
  "SMTP_FROM",
];

let originalEnv: Record<string, string | undefined>;

function setEnv(overrides: Record<string, string | undefined>) {
  for (const key of MANAGED_KEYS) {
    delete process.env[key];
  }
  for (const [key, value] of Object.entries({ ...BASE_ENV, ...overrides })) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  resetEnvCacheForTests();
}

function createMockAdapter(): MonitoringAdapter & {
  exceptions: Array<{ error: unknown; options?: { tags?: Record<string, string>; extra?: Record<string, unknown> } }>;
  messages: Array<{ message: string; options?: { tags?: Record<string, string>; extra?: Record<string, unknown> } }>;
} {
  const exceptions: Array<{ error: unknown; options?: { tags?: Record<string, string>; extra?: Record<string, unknown> } }> = [];
  const messages: Array<{ message: string; options?: { tags?: Record<string, string>; extra?: Record<string, unknown> } }> = [];
  return {
    exceptions,
    messages,
    captureException(error, options) {
      exceptions.push({ error, options });
    },
    captureMessage(message, options) {
      messages.push({ message, options });
    },
    async flush() {
      return true;
    },
  };
}

describe("lib/monitoring", () => {
  beforeEach(() => {
    originalEnv = { ...process.env };
    resetSamplerForTests();
  });

  afterEach(async () => {
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) delete process.env[key];
    }
    Object.assign(process.env, originalEnv);
    resetEnvCacheForTests();
    resetSamplerForTests();
    vi.resetModules();
  });

  describe("redact()", () => {
    it("bilinen hassas alan adlarını [redacted] ile değiştirir", () => {
      const input = {
        password: "hunter2",
        passwordHash: "$2b$10$abc",
        token: "raw-token-value",
        sessionToken: "raw-session-token",
        Authorization: "Bearer abc.def.ghi",
        Cookie: "yapifin_session=raw-cookie-value",
        smtpUser: "smtp@example.com",
        smtpPassword: "smtp-secret",
        databaseUrl: "postgresql://user:pass@host:5432/db",
        apiKey: "sk-live-abcdef",
        safeField: "bu değer kalmalı",
      };
      const result = redact(input) as Record<string, unknown>;

      expect(result.password).toBe("[redacted]");
      expect(result.passwordHash).toBe("[redacted]");
      expect(result.token).toBe("[redacted]");
      expect(result.sessionToken).toBe("[redacted]");
      expect(result.Authorization).toBe("[redacted]");
      expect(result.Cookie).toBe("[redacted]");
      expect(result.smtpUser).toBe("[redacted]");
      expect(result.smtpPassword).toBe("[redacted]");
      expect(result.databaseUrl).toBe("[redacted]");
      expect(result.apiKey).toBe("[redacted]");
      expect(result.safeField).toBe("bu değer kalmalı");
    });

    it("iç içe nesnelerde ve dizilerde özyinelemeli çalışır", () => {
      const input = {
        user: { email: "user@example.com", password: "hunter2" },
        items: [{ token: "abc" }, { safe: "ok" }],
      };
      const result = redact(input) as unknown as {
        user: { email: string; password: string };
        items: Array<Record<string, unknown>>;
      };
      expect(result.user.password).toBe("[redacted]");
      expect(result.user.email).toBe("user@example.com");
      expect(result.items[0].token).toBe("[redacted]");
      expect(result.items[1].safe).toBe("ok");
    });

    it("serbest metin içine gömülü bağlantı dizelerini ve Bearer token'ları redakte eder", () => {
      const message = "connection refused to postgres://user:secret@db-host:5432/prod, header Authorization: Bearer abc123XYZ.def456";
      const result = redact(message) as string;
      expect(result).not.toContain("postgres://user:secret@db-host");
      expect(result).not.toContain("secret");
      expect(result).not.toContain("abc123XYZ.def456");
      expect(result).toContain("postgres://[redacted]");
    });

    it("null/undefined/primitive değerleri olduğu gibi döner", () => {
      expect(redact(null)).toBeNull();
      expect(redact(undefined)).toBeUndefined();
      expect(redact(42)).toBe(42);
      expect(redact(true)).toBe(true);
    });
  });

  describe("monitoring devre dışı (yapılandırma yok)", () => {
    it("SENTRY_DSN tanımlı değilse initMonitoring() hatasız çalışır ve captureException/captureSecurityEvent no-op'tur", async () => {
      setEnv({ NODE_ENV: "development", SENTRY_DSN: undefined });
      const { initMonitoring, captureException, captureSecurityEvent, resetMonitoringAdapterForTests } = await import(
        "@/lib/monitoring"
      );
      resetMonitoringAdapterForTests();

      expect(() => initMonitoring()).not.toThrow();
      expect(() => captureException(new Error("test"))).not.toThrow();
      expect(() =>
        captureSecurityEvent({ type: "rate_limit", result: "blocked", forward: true }),
      ).not.toThrow();

      resetMonitoringAdapterForTests();
    });

    it("test ortamında (NODE_ENV=test) SENTRY_DSN tanımlı olsa bile gerçek adapter kullanılmaz", async () => {
      setEnv({ NODE_ENV: "test", SENTRY_DSN: "https://fakekey@o0.ingest.sentry.io/1" });
      const { resolveMonitoringConfig } = await import("@/lib/monitoring/config");
      const { getEnv } = await import("@/lib/env");

      const config = resolveMonitoringConfig(getEnv());
      expect(config.enabled).toBe(false);
    });

    it("production'da SENTRY_DSN eksikse getEnv() yine de hata fırlatmaz (opsiyonel alan)", async () => {
      setEnv({
        NODE_ENV: "production",
        SENTRY_DSN: undefined,
        SMTP_HOST: "smtp.example.com",
        SMTP_PORT: "587",
        SMTP_FROM: "YapiFin <noreply@example.com>",
      });
      const { getEnv } = await import("@/lib/env");
      expect(() => getEnv()).not.toThrow();
    });
  });

  describe("mock adapter ile kontrollü olay yakalama", () => {
    it("setMonitoringAdapterForTests ile enjekte edilen mock, captureException çağrısını alır", async () => {
      setEnv({ NODE_ENV: "development" });
      const { captureException, setMonitoringAdapterForTests, resetMonitoringAdapterForTests } = await import(
        "@/lib/monitoring"
      );
      const mock = createMockAdapter();
      setMonitoringAdapterForTests(mock);

      captureException(new Error("kontrollü test hatası"), { extra: { password: "hunter2", safe: "ok" } });

      expect(mock.exceptions).toHaveLength(1);
      expect(mock.exceptions[0].options?.extra?.password).toBe("[redacted]");
      expect(mock.exceptions[0].options?.extra?.safe).toBe("ok");

      resetMonitoringAdapterForTests();
    });

    it("resetMonitoringAdapterForTests sonrası mock artık çağrılmaz", async () => {
      setEnv({ NODE_ENV: "development" });
      const { captureException, setMonitoringAdapterForTests, resetMonitoringAdapterForTests } = await import(
        "@/lib/monitoring"
      );
      const mock = createMockAdapter();
      setMonitoringAdapterForTests(mock);
      resetMonitoringAdapterForTests();

      captureException(new Error("bu yakalanmamalı"));
      expect(mock.exceptions).toHaveLength(0);
    });
  });

  describe("güvenlik olayları — sanitization ve örnekleme", () => {
    it("recordRateLimitSecurityEvent: ham IP/e-posta içermez, yalnızca subjectHash/policy/source taşır", async () => {
      setEnv({ NODE_ENV: "development" });
      const { setMonitoringAdapterForTests, resetMonitoringAdapterForTests } = await import("@/lib/monitoring");
      const { recordRateLimitSecurityEvent } = await import("@/lib/monitoring/security-events");
      const mock = createMockAdapter();
      setMonitoringAdapterForTests(mock);

      recordRateLimitSecurityEvent({
        policy: "login",
        outcome: "blocked",
        source: "redis",
        subjectHash: "abc123def456",
      });

      expect(mock.messages).toHaveLength(1);
      const payload = JSON.stringify(mock.messages[0]);
      expect(payload).not.toContain("@example.com");
      expect(payload).toContain("abc123def456");
      expect(mock.messages[0].message).toBe("security.rate_limit");

      resetMonitoringAdapterForTests();
    });

    it("recordRateLimitSecurityEvent: aynı politika/sonuç için pencere içinde yalnızca ilk N olay uzak adapter'a iletilir", async () => {
      setEnv({ NODE_ENV: "development" });
      const { setMonitoringAdapterForTests, resetMonitoringAdapterForTests } = await import("@/lib/monitoring");
      const { recordRateLimitSecurityEvent } = await import("@/lib/monitoring/security-events");
      const mock = createMockAdapter();
      setMonitoringAdapterForTests(mock);

      for (let i = 0; i < 20; i++) {
        recordRateLimitSecurityEvent({ policy: "login", outcome: "blocked", source: "redis", subjectHash: `hash-${i}` });
      }

      // Her istekte bir uzak APM olayı GÖNDERİLMEMELİDİR (bkz. görev talimatı) — sampler 5'te sınırlar.
      expect(mock.messages.length).toBeLessThan(20);
      expect(mock.messages.length).toBeGreaterThan(0);

      resetMonitoringAdapterForTests();
    });

    it("recordFailedLoginSecurityEvent: ham e-posta/IP içermez, yalnızca subjectHash/route taşır", async () => {
      setEnv({ NODE_ENV: "development" });
      const { setMonitoringAdapterForTests, resetMonitoringAdapterForTests } = await import("@/lib/monitoring");
      const { recordFailedLoginSecurityEvent } = await import("@/lib/monitoring/security-events");
      const mock = createMockAdapter();
      setMonitoringAdapterForTests(mock);

      recordFailedLoginSecurityEvent({ route: "/login", subjectHash: "login-fail-hash-1" });

      expect(mock.messages).toHaveLength(1);
      expect(mock.messages[0].message).toBe("security.failed_login");
      const payload = JSON.stringify(mock.messages[0]);
      expect(payload).not.toContain("@example.com");
      expect(payload).not.toContain("hunter2");

      resetMonitoringAdapterForTests();
    });

    it("recordSmtpFailureSecurityEvent: ham alıcı adresi/token içermez, yalnızca kategori/recipientHash taşır", async () => {
      setEnv({ NODE_ENV: "development" });
      const { setMonitoringAdapterForTests, resetMonitoringAdapterForTests } = await import("@/lib/monitoring");
      const { recordSmtpFailureSecurityEvent } = await import("@/lib/monitoring/security-events");
      const mock = createMockAdapter();
      setMonitoringAdapterForTests(mock);

      recordSmtpFailureSecurityEvent({ category: "CONNECTION_REFUSED", retryable: true, recipientHash: "recipient-hash-1" });

      expect(mock.messages).toHaveLength(1);
      expect(mock.messages[0].message).toBe("security.smtp_failure");
      const payload = JSON.stringify(mock.messages[0]);
      expect(payload).not.toContain("@example.com");

      resetMonitoringAdapterForTests();
    });

    it("recordDatabaseFailureSecurityEvent: yalnızca kategori/source taşır, kısa pencerede tekrarları sınırlar", async () => {
      setEnv({ NODE_ENV: "development" });
      const { setMonitoringAdapterForTests, resetMonitoringAdapterForTests } = await import("@/lib/monitoring");
      const { recordDatabaseFailureSecurityEvent } = await import("@/lib/monitoring/security-events");
      const mock = createMockAdapter();
      setMonitoringAdapterForTests(mock);

      recordDatabaseFailureSecurityEvent({ category: "CONNECTION_REFUSED", source: "health_check" });
      recordDatabaseFailureSecurityEvent({ category: "CONNECTION_REFUSED", source: "health_check" });
      recordDatabaseFailureSecurityEvent({ category: "CONNECTION_REFUSED", source: "health_check" });

      // DB kesintisi sürerken her health-check probe'unda ayrı bir uzak
      // olay gönderilmemeli (bkz. görev talimatı, "Do not make /api/health
      // itself noisy in APM").
      expect(mock.messages).toHaveLength(1);

      resetMonitoringAdapterForTests();
    });
  });

  describe("captureException / captureRequestError — Authorization/Cookie sızdırmaz", () => {
    it("context.extra'daki Authorization/Cookie/token alanları redakte edilmiş olarak adapter'a ulaşır", async () => {
      setEnv({ NODE_ENV: "development" });
      const { captureException, setMonitoringAdapterForTests, resetMonitoringAdapterForTests } = await import(
        "@/lib/monitoring"
      );
      const mock = createMockAdapter();
      setMonitoringAdapterForTests(mock);

      captureException(new Error("route hatası"), {
        extra: {
          headers: { authorization: "Bearer secret-token-value", cookie: "yapifin_session=abc123" },
          path: "/api/health",
        },
      });

      const serialized = JSON.stringify(mock.exceptions[0].options?.extra);
      expect(serialized).not.toContain("secret-token-value");
      expect(serialized).not.toContain("yapifin_session=abc123");
      expect(serialized).toContain("/api/health");

      resetMonitoringAdapterForTests();
    });

    it("captureRequestError, ham request.headers'ı adapter'a hiç iletmez", async () => {
      setEnv({ NODE_ENV: "development" });
      const { captureRequestError, setMonitoringAdapterForTests, resetMonitoringAdapterForTests } = await import(
        "@/lib/monitoring"
      );
      const mock = createMockAdapter();
      setMonitoringAdapterForTests(mock);

      captureRequestError(
        new Error("beklenmeyen route hatası"),
        { path: "/api/health", method: "GET", headers: { authorization: "Bearer very-secret", cookie: "yapifin_session=xyz" } },
        { routerKind: "App Router", routePath: "/api/health", routeType: "route" },
      );

      expect(mock.exceptions).toHaveLength(1);
      const serialized = JSON.stringify(mock.exceptions[0]);
      expect(serialized).not.toContain("very-secret");
      expect(serialized).not.toContain("yapifin_session=xyz");

      resetMonitoringAdapterForTests();
    });
  });
});
