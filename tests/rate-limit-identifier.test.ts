import { describe, it, expect } from "vitest";
import { hashIdentifier } from "@/lib/rate-limit/identifier";

describe("hashIdentifier (PII-safe rate limit anahtarları)", () => {
  it("aynı kapsam ve değer için deterministiktir", () => {
    expect(hashIdentifier("login", "203.0.113.5")).toBe(hashIdentifier("login", "203.0.113.5"));
  });

  it("farklı kapsamlar aynı ham değer için farklı özet üretir (domain separation)", () => {
    const login = hashIdentifier("login", "user@example.com");
    const forgotPassword = hashIdentifier("forgot-password", "user@example.com");
    expect(login).not.toBe(forgotPassword);
  });

  it("farklı değerler için farklı özet üretir", () => {
    expect(hashIdentifier("login", "a@example.com")).not.toBe(hashIdentifier("login", "b@example.com"));
  });

  it("çıktı ham değeri içermez ve hex biçimindedir", () => {
    const raw = "gizli-kullanici@example.com";
    const hash = hashIdentifier("forgot-password", raw);
    expect(hash).not.toContain(raw);
    expect(hash).not.toContain("@");
    expect(hash).toMatch(/^[0-9a-f]+$/);
    expect(hash.length).toBeGreaterThan(0);
  });
});
