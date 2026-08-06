import "dotenv/config";
import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    // report-export-integration.test.ts gerçek bir `next start` sunucusu
    // gerektirir ve yalnızca `npm run test:report-export-integration`
    // (scripts/run-export-integration-tests.mjs) üzerinden çalıştırılır —
    // bkz. vitest.integration.config.ts. rate-limit-redis-integration.test.ts
    // aynı gerekçeyle gerçek bir Redis gerektirir — bkz.
    // vitest.redis-integration.config.ts / scripts/run-redis-integration-tests.mjs.
    exclude: [
      "**/node_modules/**",
      "tests/report-export-integration.test.ts",
      "tests/rate-limit-redis-integration.test.ts",
    ],
    hookTimeout: 30000,
    testTimeout: 30000,
    fileParallelism: false,
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "."),
    },
  },
});
