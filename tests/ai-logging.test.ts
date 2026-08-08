import { describe, it, expect, afterEach } from "vitest";
import { logAiUsage, setAiUsageLogSinkForTests, resetAiUsageLogSinkForTests } from "@/lib/ai/logging";

describe("lib/ai/logging — güvenli kullanım günlüğü", () => {
  afterEach(() => {
    resetAiUsageLogSinkForTests();
  });

  it("AiUsageLogEntry yalnızca sabit meta veri alanları taşır — prompt/context içeriği için bir alan bulunmaz", () => {
    const logs: Record<string, unknown>[] = [];
    setAiUsageLogSinkForTests((entry) => logs.push(entry));

    logAiUsage({
      provider: "fake",
      model: "test-model",
      promptVersion: "v1",
      correlationId: "corr-1",
      organizationId: "org-1",
      latencyMs: 12,
      status: "success",
      usage: { promptTokens: 5, completionTokens: 5, totalTokens: 10 },
    });

    expect(logs).toHaveLength(1);
    expect(logs[0]).not.toHaveProperty("prompt");
    expect(logs[0]).not.toHaveProperty("context");
    expect(logs[0]).not.toHaveProperty("messages");
  });

  it("serbest metin alanlarına kaçan bağlantı dizesi/Bearer token'ı savunma amaçlı redakte eder", () => {
    const logs: Record<string, unknown>[] = [];
    setAiUsageLogSinkForTests((entry) => logs.push(entry));

    logAiUsage({
      provider: "fake",
      model: "test-model",
      promptVersion: "v1 postgres://user:secret@db-host:5432/prod",
      correlationId: "corr-2",
      organizationId: "org-1",
      latencyMs: 12,
      status: "failure",
      failureCategory: "provider_error: Authorization: Bearer very-secret-token",
      usage: { promptTokens: null, completionTokens: null, totalTokens: null },
    });

    const serialized = JSON.stringify(logs[0]);
    expect(serialized).not.toContain("secret@db-host");
    expect(serialized).not.toContain("very-secret-token");
  });

  it("usage token sayıları redakte EDİLMEZ — alan adında 'token' geçmesi (promptTokens/completionTokens/totalTokens) gözlemlenebilirliği kırmamalı", () => {
    const logs: Record<string, unknown>[] = [];
    setAiUsageLogSinkForTests((entry) => logs.push(entry));

    logAiUsage({
      provider: "fake",
      model: "test-model",
      promptVersion: "v1",
      correlationId: "corr-4",
      organizationId: "org-1",
      latencyMs: 12,
      status: "success",
      usage: { promptTokens: 42, completionTokens: 8, totalTokens: 50 },
    });

    expect(logs[0].usage).toEqual({ promptTokens: 42, completionTokens: 8, totalTokens: 50 });
  });

  it("status alanı doğru şekilde başarı/başarısızlık olarak taşınır", () => {
    const logs: Record<string, unknown>[] = [];
    setAiUsageLogSinkForTests((entry) => logs.push(entry));

    logAiUsage({
      provider: "disabled",
      model: null,
      promptVersion: "v1",
      correlationId: "corr-3",
      organizationId: "org-1",
      latencyMs: 1,
      status: "failure",
      failureCategory: "not_configured",
      usage: { promptTokens: null, completionTokens: null, totalTokens: null },
    });

    expect(logs[0].status).toBe("failure");
    expect(logs[0].failureCategory).toBe("not_configured");
  });
});
