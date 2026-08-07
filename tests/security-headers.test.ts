import { describe, it, expect, afterEach } from "vitest";
import { NextRequest } from "next/server";
import { proxy } from "../proxy";

const ORIGINAL_NODE_ENV = process.env.NODE_ENV;
const ORIGINAL_CSP_REPORT_ONLY = process.env.CSP_REPORT_ONLY;

function setNodeEnv(value: string | undefined) {
  Object.defineProperty(process.env, "NODE_ENV", { value, configurable: true, writable: true, enumerable: true });
}

function request(path = "/dashboard") {
  return new NextRequest(new URL(path, "https://app.example.com"));
}

describe("proxy (middleware) — güvenlik başlıkları", () => {
  afterEach(() => {
    setNodeEnv(ORIGINAL_NODE_ENV);
    if (ORIGINAL_CSP_REPORT_ONLY === undefined) delete process.env.CSP_REPORT_ONLY;
    else process.env.CSP_REPORT_ONLY = ORIGINAL_CSP_REPORT_ONLY;
  });

  it("gerekli tüm başlıkları ekler", () => {
    setNodeEnv("production");
    const res = proxy(request());
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(res.headers.get("Referrer-Policy")).toBe("strict-origin-when-cross-origin");
    expect(res.headers.get("X-Frame-Options")).toBe("DENY");
    expect(res.headers.get("Permissions-Policy")).toContain("camera=()");
    expect(res.headers.get("Content-Security-Policy")).toBeTruthy();
  });

  it("production'da HSTS eklenir", () => {
    setNodeEnv("production");
    const res = proxy(request());
    const hsts = res.headers.get("Strict-Transport-Security");
    expect(hsts).toContain("max-age=63072000");
    expect(hsts).toContain("includeSubDomains");
  });

  it("development'ta HSTS eklenmez", () => {
    setNodeEnv("development");
    const res = proxy(request());
    expect(res.headers.get("Strict-Transport-Security")).toBeNull();
  });

  it("CSP: frame-ancestors 'none', object-src 'none', production'da unsafe-eval yok", () => {
    setNodeEnv("production");
    const csp = proxy(request()).headers.get("Content-Security-Policy") ?? "";
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).not.toContain("unsafe-eval");
    expect(csp).toMatch(/script-src 'self' 'nonce-[A-Za-z0-9+/=]+' 'strict-dynamic'/);
  });

  it("CSP: development'ta script-src unsafe-eval içerir (Fast Refresh için)", () => {
    setNodeEnv("development");
    const csp = proxy(request()).headers.get("Content-Security-Policy") ?? "";
    expect(csp).toContain("unsafe-eval");
  });

  it("CSP: dış kaynaklara wildcard açmaz (yalnızca 'self'/data:/blob:)", () => {
    setNodeEnv("production");
    const csp = proxy(request()).headers.get("Content-Security-Policy") ?? "";
    expect(csp).not.toContain("*");
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("connect-src 'self'");
  });

  it("her istek için farklı bir nonce üretir", () => {
    setNodeEnv("production");
    const csp1 = proxy(request()).headers.get("Content-Security-Policy") ?? "";
    const csp2 = proxy(request()).headers.get("Content-Security-Policy") ?? "";
    const nonce1 = csp1.match(/nonce-([A-Za-z0-9+/=]+)/)?.[1];
    const nonce2 = csp2.match(/nonce-([A-Za-z0-9+/=]+)/)?.[1];
    expect(nonce1).toBeTruthy();
    expect(nonce1).not.toBe(nonce2);
  });

  it("CSP_REPORT_ONLY=true iken Content-Security-Policy-Report-Only kullanılır, enforce edilmez", () => {
    setNodeEnv("production");
    process.env.CSP_REPORT_ONLY = "true";
    const res = proxy(request());
    expect(res.headers.get("Content-Security-Policy")).toBeNull();
    expect(res.headers.get("Content-Security-Policy-Report-Only")).toBeTruthy();
  });
});
