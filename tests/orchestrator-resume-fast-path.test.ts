import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("orchestrator resume fast path", () => {
  it("ORCHESTRATOR_RESUME_TEST.txt beklenen (kasıtlı yanlış) içeriği içerir", () => {
    const content = readFileSync(
      join(process.cwd(), "ORCHESTRATOR_RESUME_TEST.txt"),
      "utf-8",
    );
    expect(content).toContain("WRONG RESUME EXPECTATION");
  });
});
