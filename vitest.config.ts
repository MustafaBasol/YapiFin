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
    // bkz. vitest.integration.config.ts.
    exclude: ["**/node_modules/**", "tests/report-export-integration.test.ts"],
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
