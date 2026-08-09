import { describe, it, expect, vi, afterEach } from "vitest";
import { createFakeAiProvider } from "@/lib/ai/providers/fake-provider";
import { createDisabledAiProvider } from "@/lib/ai/providers/disabled-provider";
import { createAiProviderFromConfig } from "@/lib/ai/providers/resolve";
import { resolveAiConfig } from "@/lib/ai/config";
import { runAiCompletion } from "@/lib/ai/service";
import { AiError } from "@/lib/ai/errors";
import { createAiCorrelationId } from "@/lib/ai/correlation";
import { setAiUsageLogSinkForTests, resetAiUsageLogSinkForTests } from "@/lib/ai/logging";
import type { Env } from "@/lib/env";
import type { AiProvider } from "@/lib/ai/provider";
import type { AiUsageReportEntry } from "@/lib/ai/usage-reporting";

function fakeEnv(overrides: Partial<Env["ai"]> = {}, nodeEnv: Env["NODE_ENV"] = "development"): Env {
  return {
    NODE_ENV: nodeEnv,
    ai: { provider: "disabled", model: null, requestTimeoutMs: 15000, ...overrides },
  } as unknown as Env;
}

describe("lib/ai — sağlayıcı soyutlaması", () => {
  afterEach(() => {
    resetAiUsageLogSinkForTests();
  });

  describe("correlation id", () => {
    it("her çağrıda benzersiz bir kimlik üretir", () => {
      const a = createAiCorrelationId();
      const b = createAiCorrelationId();
      expect(a).not.toBe(b);
      expect(a.length).toBeGreaterThan(0);
    });
  });

  describe("fake provider", () => {
    it("varsayılan olarak deterministik bir yanıt döner", async () => {
      const provider = createFakeAiProvider();
      const result = await provider.complete({
        messages: [{ role: "user", content: "merhaba" }],
        promptVersion: "test-v1",
        correlationId: createAiCorrelationId(),
      });
      expect(result.text).toBe("fake-response");
      expect(result.provider).toBe("fake");
      expect(result.usage.totalTokens).toBe(20);
    });

    it("özel bir yanıt fonksiyonu enjekte edilebilir", async () => {
      const provider = createFakeAiProvider({ response: (req) => `yanıt: ${req.messages[0].content}` });
      const result = await provider.complete({
        messages: [{ role: "user", content: "test-girdi" }],
        promptVersion: "v1",
        correlationId: createAiCorrelationId(),
      });
      expect(result.text).toBe("yanıt: test-girdi");
    });

    it("behavior: provider_error ile sağlayıcı hatasını simüle eder", async () => {
      const provider = createFakeAiProvider({ behavior: "provider_error" });
      await expect(
        provider.complete({ messages: [], promptVersion: "v1", correlationId: createAiCorrelationId() }),
      ).rejects.toBeInstanceOf(AiError);
    });
  });

  describe("disabled provider", () => {
    it("her zaman not_configured kategorisiyle fail-closed reddeder", async () => {
      const provider = createDisabledAiProvider();
      await expect(
        provider.complete({ messages: [], promptVersion: "v1", correlationId: createAiCorrelationId() }),
      ).rejects.toMatchObject({ category: "not_configured" });
    });
  });

  describe("sağlayıcı seçimi (config → provider switching)", () => {
    it("provider: 'disabled' devre dışı sağlayıcıyı döner", () => {
      const config = resolveAiConfig(fakeEnv({ provider: "disabled" }));
      const provider = createAiProviderFromConfig(config);
      expect(provider.name).toBe("disabled");
    });

    it("provider: 'fake' sahte sağlayıcıyı döner", () => {
      const config = resolveAiConfig(fakeEnv({ provider: "fake" }, "test"));
      const provider = createAiProviderFromConfig(config);
      expect(provider.name).toBe("fake");
    });

    it("NODE_ENV=production iken 'fake' seçilse bile devre dışı sağlayıcıya düşer (ikinci güvenlik ağı)", () => {
      const config = resolveAiConfig(fakeEnv({ provider: "fake" }, "production"));
      expect(config.provider).toBe("disabled");
      const provider = createAiProviderFromConfig(config);
      expect(provider.name).toBe("disabled");
    });
  });

  describe("runAiCompletion — zaman aşımı/hata işleme + güvenli günlükleme", () => {
    it("başarılı bir çağrıda usage.status: success loglanır ve prompt/context İÇERİĞİ hiç geçmez", async () => {
      const logs: Record<string, unknown>[] = [];
      setAiUsageLogSinkForTests((entry) => logs.push(entry));

      const provider = createFakeAiProvider({ response: "gizli-finansal-veri-değil-sadece-log-metadatasi" });
      const result = await runAiCompletion({
        provider,
        organizationId: "org-1",
        idempotencyKey: "idem-1",
        messages: [{ role: "user", content: "İçinde ÇOK gizli bir tutar olan prompt" }],
        promptVersion: "v1",
      });

      expect(result.text).toBe("gizli-finansal-veri-değil-sadece-log-metadatasi");
      expect(logs).toHaveLength(1);
      expect(logs[0].status).toBe("success");
      expect(logs[0].organizationId).toBe("org-1");
      expect(JSON.stringify(logs[0])).not.toContain("İçinde ÇOK gizli bir tutar olan prompt");
    });

    it("sağlayıcı zaman aşımına uğrarsa AiError(category: timeout) fırlatır ve başarısızlığı loglar", async () => {
      const logs: Record<string, unknown>[] = [];
      setAiUsageLogSinkForTests((entry) => logs.push(entry));

      const provider = createFakeAiProvider({ behavior: "hang" });
      await expect(
        runAiCompletion({ provider, organizationId: "org-1", idempotencyKey: "idem-2", messages: [], promptVersion: "v1", timeoutMs: 20 }),
      ).rejects.toMatchObject({ category: "timeout" });

      expect(logs).toHaveLength(1);
      expect(logs[0].status).toBe("failure");
      expect(logs[0].failureCategory).toBe("timeout");
    });

    it("sağlayıcı hata fırlatırsa yakalanır, sınıflandırılır ve yeniden fırlatılır", async () => {
      const provider = createFakeAiProvider({ behavior: "provider_error" });
      await expect(
        runAiCompletion({ provider, organizationId: "org-1", idempotencyKey: "idem-3", messages: [], promptVersion: "v1" }),
      ).rejects.toMatchObject({ category: "provider_error" });
    });

    it("çağıran bir correlationId sağlamazsa otomatik üretilir ve sonuçta döner", async () => {
      const provider = createFakeAiProvider();
      const result = await runAiCompletion({ provider, organizationId: "org-1", idempotencyKey: "idem-4", messages: [], promptVersion: "v1" });
      expect(result.correlationId).toBeTruthy();
    });

    it("kota reddi (usageReporter.checkQuota) sağlayıcıyı hiç çağırmadan fail-closed reddeder ve reasonCode'u AiError'a taşır", async () => {
      const complete = vi.fn(async () => {
        throw new Error("sağlayıcı hiç çağrılmamalı");
      });
      const provider: AiProvider = { name: "fake", complete };
      await expect(
        runAiCompletion({
          provider,
          organizationId: "org-1",
          idempotencyKey: "idem-5",
          messages: [],
          promptVersion: "v1",
          usageReporter: {
            checkQuota: async () => ({ allowed: false, reason: "Kota doldu", reasonCode: "AI_QUOTA_EXCEEDED" }),
            reportUsage: async () => {},
          },
        }),
      ).rejects.toMatchObject({ category: "quota_exceeded", reasonCode: "AI_QUOTA_EXCEEDED" });
      expect(complete).not.toHaveBeenCalled();
    });

    it("başarılı bir çağrıda usageReporter.reportUsage status:success ve idempotencyKey ile çağrılır", async () => {
      const reportUsage = vi.fn<(entry: AiUsageReportEntry) => Promise<void>>(async () => {});
      const provider = createFakeAiProvider();
      await runAiCompletion({
        provider,
        organizationId: "org-1",
        idempotencyKey: "idem-6",
        messages: [],
        promptVersion: "v1",
        usageReporter: { checkQuota: async () => ({ allowed: true }), reportUsage },
      });
      expect(reportUsage).toHaveBeenCalledTimes(1);
      expect(reportUsage.mock.calls[0][0]).toMatchObject({
        organizationId: "org-1",
        provider: "fake",
        idempotencyKey: "idem-6",
        status: "success",
      });
    });

    it("sağlayıcı hatasında da usageReporter.reportUsage status:failure ile çağrılır (rezervasyon serbest bırakma kancası)", async () => {
      const reportUsage = vi.fn<(entry: AiUsageReportEntry) => Promise<void>>(async () => {});
      const provider = createFakeAiProvider({ behavior: "provider_error" });
      await expect(
        runAiCompletion({
          provider,
          organizationId: "org-1",
          idempotencyKey: "idem-7",
          messages: [],
          promptVersion: "v1",
          usageReporter: { checkQuota: async () => ({ allowed: true }), reportUsage },
        }),
      ).rejects.toMatchObject({ category: "provider_error" });
      expect(reportUsage).toHaveBeenCalledTimes(1);
      expect(reportUsage.mock.calls[0][0]).toMatchObject({
        idempotencyKey: "idem-7",
        status: "failure",
        failureCategory: "provider_error",
      });
    });
  });
});
