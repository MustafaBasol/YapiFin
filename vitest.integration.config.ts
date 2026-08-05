import "dotenv/config";
import { defineConfig } from "vitest/config";
import path from "path";

/**
 * YF-405 — yalnızca `scripts/run-export-integration-tests.mjs` tarafından,
 * gerçek bir `next start` sunucusu ayaktayken çalıştırılan ayrı bir Vitest
 * yapılandırması. Standart `npm run test` (vitest.config.ts) bu dosyayı
 * dahil ETMEZ — bkz. vitest.config.ts `exclude`.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/report-export-integration.test.ts"],
    hookTimeout: 120000,
    testTimeout: 30000,
    fileParallelism: false,
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "."),
    },
  },
});
