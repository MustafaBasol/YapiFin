import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  agentRules: false,
  // YF-511: `X-Powered-By: Next.js` header'ı kaldırılır — sürüm/çatı
  // bilgisini gereksiz yere sızdırır (bkz. middleware.ts, diğer güvenlik
  // başlıkları için).
  poweredByHeader: false,
  turbopack: {
    root: process.cwd(),
  },
};

export default nextConfig;
