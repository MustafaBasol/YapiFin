import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

/**
 * YF-511 — Merkezi güvenlik başlıkları.
 *
 * `proxy.ts` (Next.js 16'da eski `middleware.ts` dosya adının yerini alan
 * kural — davranış aynıdır, yalnızca dosya/fonksiyon adı değişmiştir; bkz.
 * https://nextjs.org/docs/messages/middleware-to-proxy) burada, next.config.ts
 * `headers()` yerine kullanılır çünkü Next.js App Router kendi hydration/RSC
 * script'lerini inline olarak enjekte eder; bunlara izin vermek için
 * `script-src` ya `unsafe-inline` (kod enjeksiyonuna açık) ya da istek başına
 * üretilen bir nonce gerektirir. Nonce yalnızca bu istek-bazlı katmanda
 * üretilebilir — next.config.ts statiktir.
 * Bkz. https://nextjs.org/docs/app/building-your-application/configuring/content-security-policy
 *
 * Depodaki gerçek bağımlılıklara göre türetilmiştir (bkz. app/layout.tsx,
 * package.json): next/font/google ile self-hosted yazı tipleri (build-time,
 * çalışma zamanında dış istek yok), Tailwind ile derlenmiş statik CSS, harici
 * script/analytics/CDN yok, next.config.ts'de `images.remotePatterns` tanımlı
 * değil (yalnızca yerel görseller). Bu nedenle CSP dış kaynaklara geniş
 * wildcard açmaz.
 */

// `process.env` her çağrıda okunur (modül yükleme anında sabitlenmez) —
// testlerin ortam değişkenini değiştirip aynı proxy fonksiyonunu tekrar
// çağırabilmesi için, ayrıca çalışma zamanında da her zaman güncel değeri
// yansıtır.
function isProd(): boolean {
  return process.env.NODE_ENV === "production";
}

// Operasyonel geçiş valfi: prod'a doğrudan enforce ile çıkmadan önce, gerekirse
// ops bu bayrakla CSP'yi `Content-Security-Policy-Report-Only` moduna alıp
// tarayıcı ihlallerini (konsol/`report-to`) kırmadan gözlemleyebilir. Gerçek
// bağımlılık analizine göre türetildiği için varsayılan mod enforce'dur.
function isCspReportOnly(): boolean {
  return process.env.CSP_REPORT_ONLY === "true";
}

const PERMISSIONS_POLICY = [
  "camera=()",
  "microphone=()",
  "geolocation=()",
  "payment=()",
  "usb=()",
  "magnetometer=()",
  "gyroscope=()",
  "accelerometer=()",
  "interest-cohort=()",
].join(", ");

function buildCsp(nonce: string, prod: boolean): string {
  const scriptSrc = prod
    ? `'self' 'nonce-${nonce}' 'strict-dynamic'`
    : // Next.js dev sunucusu (Fast Refresh/webpack eval-source-map) yalnızca
      // development'ta `unsafe-eval` gerektirir; production build'de kullanılmaz.
      `'self' 'nonce-${nonce}' 'unsafe-eval'`;

  return [
    "default-src 'self'",
    `script-src ${scriptSrc}`,
    // Tailwind derlenmiş statik CSS kullanır; ancak React inline `style`
    // attribute'ları (dinamik grafik/rozet renkleri vb.) projede yaygındır ve
    // nonce ile korunamaz (style attribute'ları nonce'u desteklemez) — bu
    // yüzden style-src için `unsafe-inline` kabul edilir. Bu, script
    // enjeksiyonuna izin vermez (yalnızca CSS), Next.js'in kendi CSP
    // rehberinde de aynı gerekçeyle önerilir.
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    ...(prod ? ["upgrade-insecure-requests"] : []),
  ].join("; ");
}

export function proxy(request: NextRequest) {
  const prod = isProd();
  const nonce = Buffer.from(crypto.randomUUID()).toString("base64");
  const csp = buildCsp(nonce, prod);
  const cspHeaderName = isCspReportOnly() ? "Content-Security-Policy-Report-Only" : "Content-Security-Policy";

  // Nonce, sunucu bileşenlerine `x-nonce` request header'ı üzerinden iletilir
  // (bkz. Next.js CSP rehberi) — böylece uygulama kendi <Script nonce={...}>
  // etiketlerini gerektiğinde bu değerle işaretleyebilir.
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);

  const response = NextResponse.next({ request: { headers: requestHeaders } });

  response.headers.set(cspHeaderName, csp);
  response.headers.set("X-Content-Type-Options", "nosniff");
  response.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  // `frame-ancestors` (CSP) modern tarayıcılarda tek başına yeterlidir;
  // `X-Frame-Options` eski tarayıcı uyumluluğu için ek bir katman olarak kalır.
  response.headers.set("X-Frame-Options", "DENY");
  response.headers.set("Permissions-Policy", PERMISSIONS_POLICY);

  // HSTS yalnızca production'da eklenir: uygulama kendi TLS terminasyonunu
  // yapmaz (bkz. docs/operations/DEPLOYMENT_RUNBOOK.md "TLS / reverse proxy
  // beklentisi") — production dağıtımı her zaman bir reverse proxy/CDN
  // arkasında HTTPS ile yapılması varsayılır (lib/env.ts, production'da
  // NEXT_PUBLIC_APP_URL için https:// zorunlu kılarak bunu doğrular).
  // Development/test'te düz HTTP üzerinden çalışıldığı için eklenmez —
  // aksi halde tarayıcı yerel http://localhost'a bir süre sonra https
  // yönlendirmesi dayatabilir.
  if (prod) {
    response.headers.set("Strict-Transport-Security", "max-age=63072000; includeSubDomains; preload");
  }

  return response;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
