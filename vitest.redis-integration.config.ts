import "dotenv/config";
import { defineConfig } from "vitest/config";
import path from "path";

/**
 * YF-509 — gerçek bir Redis'e karşı çalışan dağıtık rate limit entegrasyon
 * testleri. Standart `npm run test` (vitest.config.ts) bu dosyayı dahil
 * ETMEZ — yalnızca `npm run test:redis-integration`
 * (scripts/run-redis-integration-tests.mjs) üzerinden, görev bazlı disposable
 * bir Redis konteynerine (veya CI'da sağlanan bir Redis servisine) karşı
 * çalıştırılmak üzere tasarlanmıştır.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/rate-limit-redis-integration.test.ts"],
    hookTimeout: 60000,
    testTimeout: 30000,
    fileParallelism: false,
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "."),
    },
  },
});
