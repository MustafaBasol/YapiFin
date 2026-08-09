import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("orchestrator auto-fix lifecycle (kasıtlı başarısız)", () => {
  it("ORCHESTRATOR_AUTO_FIX_TEST.txt içeriği 'WRONG EXPECTATION' olmalı", () => {
    const filePath = join(process.cwd(), "ORCHESTRATOR_AUTO_FIX_TEST.txt");
    const content = readFileSync(filePath, "utf-8");
    expect(content).toBe("WRONG EXPECTATION");
  });
});
