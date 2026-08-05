import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { resetEnvCacheForTests } from "@/lib/env";

const sendMailMock = vi.fn();
const createTransportMock = vi.fn(() => ({ sendMail: sendMailMock }));

vi.mock("nodemailer", () => ({
  createTransport: createTransportMock,
}));

const BASE_ENV: Record<string, string> = {
  NODE_ENV: "development",
  DATABASE_URL: "postgresql://user:pass@localhost:5432/db",
  AUTH_SECRET: "a".repeat(32),
  NEXT_PUBLIC_APP_URL: "https://app.example.com",
  NEXT_PUBLIC_APP_NAME: "YapiFin",
};

const SMTP_ENV: Record<string, string> = {
  SMTP_HOST: "smtp.example.com",
  SMTP_PORT: "587",
  SMTP_USER: "smtp-user@example.com",
  SMTP_PASSWORD: "very-secret-smtp-password",
  SMTP_FROM: "YapiFin <noreply@example.com>",
};

const ALL_KEYS = [...Object.keys(BASE_ENV), ...Object.keys(SMTP_ENV)];

let originalEnv: Record<string, string | undefined>;

function setEnv(overrides: Record<string, string | undefined>) {
  for (const key of ALL_KEYS) delete process.env[key];
  for (const [key, value] of Object.entries({ ...BASE_ENV, ...overrides })) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  resetEnvCacheForTests();
}

describe("sendMail / mailer", () => {
  beforeEach(() => {
    originalEnv = { ...process.env };
    sendMailMock.mockReset();
    sendMailMock.mockResolvedValue(undefined);
    createTransportMock.mockClear();
  });

  afterEach(() => {
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) delete process.env[key];
    }
    Object.assign(process.env, originalEnv);
    resetEnvCacheForTests();
    vi.restoreAllMocks();
  });

  it("development + SMTP yok: e-postayı konsola yazar (dev outbox), nodemailer çağrılmaz", async () => {
    setEnv({ NODE_ENV: "development" });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const { sendVerificationEmail } = await import("@/lib/email/mailer");

    await sendVerificationEmail("kullanici@example.com", "raw-token-123");

    expect(createTransportMock).not.toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledTimes(1);
    const logged = JSON.parse(logSpy.mock.calls[0][0] as string);
    expect(logged.event).toBe("email.dev_outbox");
    expect(logged.to).toBe("kullanici@example.com");
  });

  it("production + SMTP yok: fail-closed hata fırlatır, dev outbox'a düşmez", async () => {
    setEnv({
      NODE_ENV: "production",
      NEXT_PUBLIC_APP_URL: "https://app.example.com",
      SMTP_HOST: undefined,
      SMTP_PORT: undefined,
      SMTP_USER: undefined,
      SMTP_PASSWORD: undefined,
      SMTP_FROM: undefined,
    });
    // getEnv() zaten instrumentation.ts'te fırlatır, ama burada mailer'ın
    // kendi savunma katmanını da (env doğrulaması atlanmışsa) doğruluyoruz.
    const { sendVerificationEmail } = await import("@/lib/email/mailer");

    await expect(sendVerificationEmail("kullanici@example.com", "raw-token-123")).rejects.toThrow();
    expect(createTransportMock).not.toHaveBeenCalled();
  });

  it("SMTP yapılandırılmışsa nodemailer ile gönderir ve doğru parametreleri kullanır", async () => {
    setEnv({ NODE_ENV: "production", ...SMTP_ENV });
    const { sendPasswordResetEmail } = await import("@/lib/email/mailer");

    await sendPasswordResetEmail("kullanici@example.com", "reset-token-abc");

    expect(createTransportMock).toHaveBeenCalledWith(
      expect.objectContaining({
        host: "smtp.example.com",
        port: 587,
        secure: false,
        auth: { user: "smtp-user@example.com", pass: "very-secret-smtp-password" },
      }),
    );
    expect(sendMailMock).toHaveBeenCalledWith(
      expect.objectContaining({ to: "kullanici@example.com", from: "YapiFin <noreply@example.com>" }),
    );
  });

  it("port 465 için secure:true kullanır", async () => {
    setEnv({ NODE_ENV: "production", ...SMTP_ENV, SMTP_PORT: "465" });
    const { sendPasswordResetEmail } = await import("@/lib/email/mailer");

    await sendPasswordResetEmail("kullanici@example.com", "reset-token-abc");

    expect(createTransportMock).toHaveBeenCalledWith(expect.objectContaining({ secure: true }));
  });

  it("güvenilir relay (SMTP_USER/PASSWORD boş) için auth:undefined gönderir", async () => {
    setEnv({
      NODE_ENV: "production",
      SMTP_HOST: "relay.internal",
      SMTP_PORT: "25",
      SMTP_FROM: "YapiFin <noreply@example.com>",
      SMTP_USER: undefined,
      SMTP_PASSWORD: undefined,
    });
    const { sendPasswordResetEmail } = await import("@/lib/email/mailer");

    await sendPasswordResetEmail("kullanici@example.com", "reset-token-abc");

    expect(createTransportMock).toHaveBeenCalledWith(expect.objectContaining({ auth: undefined }));
  });

  it("SMTP gönderim hatası yutulmaz, çağırana yansır", async () => {
    setEnv({ NODE_ENV: "production", ...SMTP_ENV });
    sendMailMock.mockRejectedValueOnce(new Error("SMTP bağlantısı reddedildi"));
    const { sendInvitationEmail } = await import("@/lib/email/mailer");

    await expect(
      sendInvitationEmail("kullanici@example.com", "invite-token", "Test İnşaat", "Ayşe Yılmaz"),
    ).rejects.toThrow("SMTP bağlantısı reddedildi");
  });

  it("SMTP_PASSWORD hiçbir konsol çıktısına yazılmaz (başarı ya da hata durumunda)", async () => {
    setEnv({ NODE_ENV: "production", ...SMTP_ENV });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { sendVerificationEmail } = await import("@/lib/email/mailer");

    await sendVerificationEmail("kullanici@example.com", "raw-token-123");
    sendMailMock.mockRejectedValueOnce(new Error("geçici SMTP hatası"));
    await expect(sendVerificationEmail("kullanici@example.com", "raw-token-456")).rejects.toThrow();

    const allLoggedText = [...logSpy.mock.calls, ...errorSpy.mock.calls].flat().map(String).join("\n");
    expect(allLoggedText).not.toContain(SMTP_ENV.SMTP_PASSWORD);
  });
});
