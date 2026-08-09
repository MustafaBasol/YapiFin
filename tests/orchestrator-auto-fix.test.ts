import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

describe("orchestrator auto fix lifecycle", () => {
  it("expects the marker file to contain auto fix lifecycle ok", () => {
    const filePath = path.join(process.cwd(), "ORCHESTRATOR_AUTO_FIX_TEST.txt");
    const content = readFileSync(filePath, "utf-8");
    expect(content).toBe("auto fix lifecycle ok");
  });
});
