import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { getEnv, resetEnvCacheForTests } from "@/lib/env";

const BASE_ENV: Record<string, string> = {
  NODE_ENV: "development",
  DATABASE_URL: "postgresql://user:pass@localhost:5432/db",
  AUTH_SECRET: "a".repeat(32),
  NEXT_PUBLIC_APP_URL: "https://app.example.com",
  NEXT_PUBLIC_APP_NAME: "YapiFin",
  SMTP_HOST: "smtp.example.com",
  SMTP_PORT: "587",
  SMTP_USER: "smtp-user@example.com",
  SMTP_PASSWORD: "super-secret-smtp-password",
  SMTP_FROM: "YapiFin <noreply@example.com>",
};

let originalEnv: Record<string, string | undefined>;

function setEnv(overrides: Record<string, string | undefined>) {
  for (const key of Object.keys(BASE_ENV)) delete process.env[key];
  for (const [key, value] of Object.entries({ ...BASE_ENV, ...overrides })) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  resetEnvCacheForTests();
}

describe("getEnv", () => {
  beforeEach(() => {
    originalEnv = { ...process.env };
  });

  afterEach(() => {
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) delete process.env[key];
    }
    Object.assign(process.env, originalEnv);
    resetEnvCacheForTests();
  });

  it("development: SMTP olmadan hatasız doğrulanır ve smtp null döner (dev outbox)", () => {
    setEnv({
      NODE_ENV: "development",
      SMTP_HOST: undefined,
      SMTP_PORT: undefined,
      SMTP_USER: undefined,
      SMTP_PASSWORD: undefined,
      SMTP_FROM: undefined,
    });
    const env = getEnv();
    expect(env.smtp).toBeNull();
  });

  it("production: SMTP hiç yapılandırılmamışsa hata fırlatır (fail-closed)", () => {
    setEnv({
      NODE_ENV: "production",
      SMTP_HOST: undefined,
      SMTP_PORT: undefined,
      SMTP_USER: undefined,
      SMTP_PASSWORD: undefined,
      SMTP_FROM: undefined,
    });
    expect(() => getEnv()).toThrow(/SMTP_HOST/);
  });

  it("production: SMTP eksik alanlarla (port/from yok) hata fırlatır", () => {
    setEnv({ NODE_ENV: "production", SMTP_PORT: undefined, SMTP_FROM: undefined });
    expect(() => getEnv()).toThrow(/SMTP_PORT/);
  });

  it("production: placeholder AUTH_SECRET reddedilir", () => {
    setEnv({ NODE_ENV: "production", AUTH_SECRET: "change-me-with-a-long-random-secret" });
    expect(() => getEnv()).toThrow(/AUTH_SECRET/);
  });

  it("production: kısa AUTH_SECRET reddedilir", () => {
    setEnv({ NODE_ENV: "production", AUTH_SECRET: "a".repeat(20) });
    expect(() => getEnv()).toThrow(/AUTH_SECRET/);
  });

  it("production: http NEXT_PUBLIC_APP_URL (localhost olmayan) reddedilir", () => {
    setEnv({ NODE_ENV: "production", NEXT_PUBLIC_APP_URL: "http://app.example.com" });
    expect(() => getEnv()).toThrow(/NEXT_PUBLIC_APP_URL/);
  });

  it("production: localhost http NEXT_PUBLIC_APP_URL istisnası kabul edilir", () => {
    setEnv({ NODE_ENV: "production", NEXT_PUBLIC_APP_URL: "http://localhost:4000" });
    expect(() => getEnv()).not.toThrow();
  });

  it("production: geliştirme DB parolası (yapifin_dev_password) reddedilir", () => {
    setEnv({
      NODE_ENV: "production",
      DATABASE_URL: "postgresql://yapifin:yapifin_dev_password@localhost:5432/yapifin",
    });
    expect(() => getEnv()).toThrow(/DATABASE_URL/);
  });

  it("production: eksiksiz, geçerli yapılandırmayı kabul eder", () => {
    setEnv({ NODE_ENV: "production" });
    const env = getEnv();
    expect(env.smtp).not.toBeNull();
    expect(env.smtp?.host).toBe("smtp.example.com");
    expect(env.smtp?.auth).toEqual({ user: "smtp-user@example.com", password: "super-secret-smtp-password" });
  });

  it("production: kimlik doğrulamasız güvenilir relay (SMTP_USER/PASSWORD boş) kabul edilir", () => {
    setEnv({ NODE_ENV: "production", SMTP_USER: undefined, SMTP_PASSWORD: undefined });
    const env = getEnv();
    expect(env.smtp?.auth).toBeNull();
  });

  it("SMTP_USER olup SMTP_PASSWORD olmadığında (herhangi bir ortamda) reddedilir", () => {
    setEnv({ NODE_ENV: "development", SMTP_PASSWORD: undefined });
    expect(() => getEnv()).toThrow(/SMTP_USER/);
  });

  it("geçersiz DATABASE_URL formatını her ortamda reddeder", () => {
    setEnv({ DATABASE_URL: "not-a-database-url" });
    expect(() => getEnv()).toThrow(/DATABASE_URL/);
  });

  it("test ortamında SMTP olmadan çalışır (console outbox)", () => {
    setEnv({
      NODE_ENV: "test",
      SMTP_HOST: undefined,
      SMTP_PORT: undefined,
      SMTP_USER: undefined,
      SMTP_PASSWORD: undefined,
      SMTP_FROM: undefined,
    });
    const env = getEnv();
    expect(env.smtp).toBeNull();
  });

  it("hata mesajı sırları (AUTH_SECRET, SMTP_PASSWORD) sızdırmaz", () => {
    setEnv({
      NODE_ENV: "production",
      SMTP_HOST: undefined,
      SMTP_PORT: undefined,
      SMTP_USER: undefined,
      SMTP_PASSWORD: undefined,
      SMTP_FROM: undefined,
    });
    let message = "";
    try {
      getEnv();
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).not.toBe("");
    expect(message).not.toContain(BASE_ENV.AUTH_SECRET);
    expect(message).not.toContain(BASE_ENV.SMTP_PASSWORD);
  });

  it("getEnv() sonucu donmuştur (immutable)", () => {
    setEnv({});
    const env = getEnv();
    expect(Object.isFrozen(env)).toBe(true);
    expect(Object.isFrozen(env.smtp)).toBe(true);
  });
});
