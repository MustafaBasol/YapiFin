import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { resetEnvCacheForTests } from "@/lib/env";
import { cleanDatabase, createOwnerOrg, createOrgUser } from "./helpers";
import { createConnection, setConnectionCredential } from "@/server/services/integrations/integration-service";
import { lookupTaxpayer, lookupDocumentStatus } from "@/server/services/integrations/provider-lifecycle-service";
import { registerProviderAdapterForTests, resetProviderRegistryForTests } from "@/server/services/integrations/provider-registry";
import { createNilveraProviderAdapter } from "@/server/services/integrations/providers/nilvera-provider";
import { createFakeProviderAdapter } from "@/server/services/integrations/providers/fake-provider";

/**
 * YF-605-D — `lookupTaxpayer`/`lookupDocumentStatus` domain fonksiyonlarının
 * uçtan uca testleri (tenant izolasyonu, rol yetkisi, audit/event lifecycle,
 * sır sızıntısı YOKTUR). Gerçek Nilvera adaptörü, HTTP mock'u enjekte
 * edilerek registry üzerinden çözülür — gerçek ağ çağrısı YAPILMAZ (görev
 * talimatı "Use HTTP mocks/fakes around the Nilvera adapter boundary").
 */
const TEST_KEY = "e".repeat(64);
let originalKey: string | undefined;

beforeAll(async () => {
  originalKey = process.env.INTEGRATION_ENCRYPTION_KEY;
  process.env.INTEGRATION_ENCRYPTION_KEY = TEST_KEY;
  process.env.AUTH_SECRET ??= "a".repeat(32);
  process.env.NEXT_PUBLIC_APP_URL ??= "https://app.example.com";
  resetEnvCacheForTests();
  await cleanDatabase();
});
beforeEach(() => {
  process.env.INTEGRATION_ENCRYPTION_KEY = TEST_KEY;
  resetEnvCacheForTests();
});
afterEach(async () => {
  resetProviderRegistryForTests();
  await cleanDatabase();
});
afterAll(async () => {
  if (originalKey === undefined) delete process.env.INTEGRATION_ENCRYPTION_KEY;
  else process.env.INTEGRATION_ENCRYPTION_KEY = originalKey;
  resetEnvCacheForTests();
  await db.$disconnect();
});

const nilveraConnectionInput = {
  integrationType: "E_INVOICE" as const,
  provider: "NILVERA" as const,
  environment: "SANDBOX" as const,
  displayName: "Nilvera Sandbox Bağlantısı",
  externalTenantId: undefined,
};

const genericConnectionInput = {
  integrationType: "E_INVOICE" as const,
  provider: "GENERIC" as const,
  environment: "SANDBOX" as const,
  displayName: "Sahte Sağlayıcı Bağlantısı",
  externalTenantId: undefined,
};

function jsonResponse(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response;
}

async function createConnectionWithCredential(
  owner: Awaited<ReturnType<typeof createOwnerOrg>>["owner"],
  input: typeof nilveraConnectionInput | typeof genericConnectionInput,
  secretValue = "nilvera-test-sir-degeri",
) {
  const connection = await createConnection(owner, input);
  await setConnectionCredential(owner, { connectionId: connection.id, secretValue });
  return connection;
}

function registerNilveraWithFetch(fetchImpl: typeof fetch) {
  registerProviderAdapterForTests("NILVERA", () => createNilveraProviderAdapter({ fetchImpl }));
}

describe("Nilvera sorgu servisleri (YF-605-D) — lookupTaxpayer / lookupDocumentStatus", () => {
  describe("mükellef sorgulama", () => {
    it("geçerli sorgu normalize edilmiş sonuçla döner ve SUCCESS olay kaydı üretir", async () => {
      const { owner } = await createOwnerOrg();
      registerNilveraWithFetch(vi.fn(async () => jsonResponse(200, [{ DocumentType: "Invoice" }])) as unknown as typeof fetch);
      const connection = await createConnectionWithCredential(owner, nilveraConnectionInput);

      const result = await lookupTaxpayer(owner, { connectionId: connection.id, identifier: "34918613960" });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.result).toEqual({
          identifier: "34918613960",
          isEDocumentTaxpayer: true,
          supportedDocumentType: "Invoice",
        });
      }

      const logs = await db.integrationEventLog.findMany({ where: { connectionId: connection.id, eventType: "taxpayer.lookup" } });
      expect(logs).toHaveLength(1);
      expect(logs[0].status).toBe("SUCCESS");
      expect(logs[0].direction).toBe("OUTBOUND");
    });

    it("desteklenmeyen yetenek (GENERIC) VALIDATION ile temiz şekilde başarısız olur", async () => {
      const { owner } = await createOwnerOrg();
      const connection = await createConnectionWithCredential(owner, genericConnectionInput);

      const result = await lookupTaxpayer(owner, { connectionId: connection.id, identifier: "34918613960" });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.category).toBe("VALIDATION");
    });

    it("boş tanımlayıcı VALIDATION ile reddedilir (adaptöre hiç ulaşmaz)", async () => {
      const { owner } = await createOwnerOrg();
      const connection = await createConnectionWithCredential(owner, nilveraConnectionInput);
      await expect(lookupTaxpayer(owner, { connectionId: connection.id, identifier: "   " })).rejects.toMatchObject({
        code: "VALIDATION",
      });
    });
  });

  describe("belge durumu sorgulama", () => {
    it("geçerli sorgu normalize edilmiş sonuçla döner ve SUCCESS olay kaydı üretir", async () => {
      const { owner } = await createOwnerOrg();
      registerNilveraWithFetch(
        vi.fn(async () =>
          jsonResponse(200, {
            Answer: { AnswerCode: "approved" },
            InvoiceStatus: { Code: "succeed" },
            EnvelopeInfo: { CreatedDate: "2026-02-01T00:00:00Z" },
          }),
        ) as unknown as typeof fetch,
      );
      const connection = await createConnectionWithCredential(owner, nilveraConnectionInput);

      const result = await lookupDocumentStatus(owner, { connectionId: connection.id, externalDocumentId: "uuid-99" });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.result).toEqual({
          externalDocumentId: "uuid-99",
          status: "ACCEPTED",
          providerStatusCode: "succeed",
          lastKnownProviderTimestamp: "2026-02-01T00:00:00Z",
        });
      }

      const logs = await db.integrationEventLog.findMany({ where: { connectionId: connection.id, eventType: "document.status.lookup" } });
      expect(logs).toHaveLength(1);
      expect(logs[0].status).toBe("SUCCESS");
    });

    it("desteklenmeyen yetenek (GENERIC) VALIDATION ile temiz şekilde başarısız olur", async () => {
      const { owner } = await createOwnerOrg();
      const connection = await createConnectionWithCredential(owner, genericConnectionInput);

      const result = await lookupDocumentStatus(owner, { connectionId: connection.id, externalDocumentId: "uuid-1" });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.category).toBe("VALIDATION");
    });
  });

  describe("HTTP hata sınıflandırması domain katmanında", () => {
    it("401 -> AUTH_CONFIG", async () => {
      const { owner } = await createOwnerOrg();
      registerNilveraWithFetch(vi.fn(async () => jsonResponse(401, {})) as unknown as typeof fetch);
      const connection = await createConnectionWithCredential(owner, nilveraConnectionInput);
      const result = await lookupTaxpayer(owner, { connectionId: connection.id, identifier: "1" });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.category).toBe("AUTH_CONFIG");
    });

    it("403 -> AUTH_CONFIG", async () => {
      const { owner } = await createOwnerOrg();
      registerNilveraWithFetch(vi.fn(async () => jsonResponse(403, {})) as unknown as typeof fetch);
      const connection = await createConnectionWithCredential(owner, nilveraConnectionInput);
      const result = await lookupDocumentStatus(owner, { connectionId: connection.id, externalDocumentId: "uuid-1" });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.category).toBe("AUTH_CONFIG");
    });

    it("400 -> VALIDATION", async () => {
      const { owner } = await createOwnerOrg();
      registerNilveraWithFetch(vi.fn(async () => jsonResponse(400, {})) as unknown as typeof fetch);
      const connection = await createConnectionWithCredential(owner, nilveraConnectionInput);
      const result = await lookupTaxpayer(owner, { connectionId: connection.id, identifier: "1" });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.category).toBe("VALIDATION");
    });

    it("404 (belge durumu) -> VALIDATION", async () => {
      const { owner } = await createOwnerOrg();
      registerNilveraWithFetch(vi.fn(async () => jsonResponse(404, {})) as unknown as typeof fetch);
      const connection = await createConnectionWithCredential(owner, nilveraConnectionInput);
      const result = await lookupDocumentStatus(owner, { connectionId: connection.id, externalDocumentId: "bilinmeyen" });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.category).toBe("VALIDATION");
    });

    it("429 -> RATE_LIMIT", async () => {
      const { owner } = await createOwnerOrg();
      registerNilveraWithFetch(vi.fn(async () => jsonResponse(429, {})) as unknown as typeof fetch);
      const connection = await createConnectionWithCredential(owner, nilveraConnectionInput);
      const result = await lookupTaxpayer(owner, { connectionId: connection.id, identifier: "1" });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.category).toBe("RATE_LIMIT");
    });

    it("5xx -> TEMPORARY_PROVIDER", async () => {
      const { owner } = await createOwnerOrg();
      registerNilveraWithFetch(vi.fn(async () => jsonResponse(502, {})) as unknown as typeof fetch);
      const connection = await createConnectionWithCredential(owner, nilveraConnectionInput);
      const result = await lookupDocumentStatus(owner, { connectionId: connection.id, externalDocumentId: "uuid-1" });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.category).toBe("TEMPORARY_PROVIDER");
    });

    it("zaman aşımı -> TIMEOUT_NETWORK", async () => {
      const { owner } = await createOwnerOrg();
      registerNilveraWithFetch(
        vi.fn(async () => {
          const err = new Error("aborted");
          err.name = "AbortError";
          throw err;
        }) as unknown as typeof fetch,
      );
      const connection = await createConnectionWithCredential(owner, nilveraConnectionInput);
      const result = await lookupTaxpayer(owner, { connectionId: connection.id, identifier: "1" });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.category).toBe("TIMEOUT_NETWORK");
    });

    it("bozuk yanıt gövdesi -> UNKNOWN", async () => {
      const { owner } = await createOwnerOrg();
      registerNilveraWithFetch(
        vi.fn(async () => ({
          ok: true,
          status: 200,
          json: async () => {
            throw new Error("bozuk");
          },
        })) as unknown as typeof fetch,
      );
      const connection = await createConnectionWithCredential(owner, nilveraConnectionInput);
      const result = await lookupDocumentStatus(owner, { connectionId: connection.id, externalDocumentId: "uuid-1" });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.category).toBe("UNKNOWN");
    });
  });

  describe("kimlik bilgisi eksikliği fail-closed davranışı", () => {
    it("kimlik bilgisi hiç tanımlanmamışsa NOT_FOUND ile reddedilir (adaptöre hiç ulaşmaz)", async () => {
      const { owner } = await createOwnerOrg();
      const connection = await createConnection(owner, nilveraConnectionInput);
      await expect(lookupTaxpayer(owner, { connectionId: connection.id, identifier: "1" })).rejects.toMatchObject({
        code: "NOT_FOUND",
      });
      await expect(
        lookupDocumentStatus(owner, { connectionId: connection.id, externalDocumentId: "uuid-1" }),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
    });
  });

  describe("sır sızıntısı yok", () => {
    it("kimlik bilgisi hiçbir log/hata mesajında düz metin olarak görünmez", async () => {
      const { owner } = await createOwnerOrg();
      const secret = "asla-sizmamasi-gereken-nilvera-sir-42";
      registerNilveraWithFetch(
        vi.fn(async () => {
          throw new TypeError(`network error while using token ${secret}`);
        }) as unknown as typeof fetch,
      );
      const connection = await createConnectionWithCredential(owner, nilveraConnectionInput, secret);

      const result = await lookupTaxpayer(owner, { connectionId: connection.id, identifier: "1" });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.summary).not.toContain(secret);

      const logs = await db.integrationEventLog.findMany({ where: { connectionId: connection.id } });
      for (const log of logs) {
        expect(JSON.stringify(log)).not.toContain(secret);
      }
    });
  });

  describe("tenant izolasyonu", () => {
    it("başka organizasyonun bağlantısı için sorgu NOT_FOUND ile reddedilir", async () => {
      const { owner: ownerA } = await createOwnerOrg();
      const { owner: ownerB } = await createOwnerOrg();
      const connection = await createConnectionWithCredential(ownerA, nilveraConnectionInput);

      await expect(
        lookupTaxpayer(ownerB, { connectionId: connection.id, identifier: "1" }),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
      await expect(
        lookupDocumentStatus(ownerB, { connectionId: connection.id, externalDocumentId: "uuid-1" }),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
    });

    it("FINANCE ve PROJECT_MANAGER sorgu başlatamaz", async () => {
      const { owner } = await createOwnerOrg();
      const finance = await createOrgUser(owner.organizationId, "FINANCE");
      const pm = await createOrgUser(owner.organizationId, "PROJECT_MANAGER");
      const connection = await createConnectionWithCredential(owner, nilveraConnectionInput);

      await expect(lookupTaxpayer(finance, { connectionId: connection.id, identifier: "1" })).rejects.toMatchObject({
        code: "FORBIDDEN",
      });
      await expect(lookupDocumentStatus(pm, { connectionId: connection.id, externalDocumentId: "uuid-1" })).rejects.toMatchObject({
        code: "FORBIDDEN",
      });
    });
  });

  describe("mutasyon işlemi eklenmedi", () => {
    it("GENERIC adaptör hâlâ değişmeden çalışır (bağlantı testi/giden işlem)", async () => {
      const { owner } = await createOwnerOrg();
      const adapter = createFakeProviderAdapter("GENERIC");
      const ctx = {
        connectionId: "c1",
        organizationId: owner.organizationId,
        provider: "GENERIC" as const,
        environment: "SANDBOX" as const,
        externalTenantId: null,
      };
      await expect(adapter.testConnection({ secretValue: "x" }, ctx)).resolves.toMatchObject({ ok: true });
    });

    it("NILVERA bağlantısı için giden işlem (executeOutboundOperation) hâlâ desteklenmiyor — VALIDATION ile kalıcı başarısız", async () => {
      const { owner } = await createOwnerOrg();
      const connection = await createConnectionWithCredential(owner, nilveraConnectionInput);
      const { executeOutboundOperation } = await import("@/server/services/integrations/provider-lifecycle-service");
      const result = await executeOutboundOperation(owner, {
        connectionId: connection.id,
        operationType: "EINVOICE_SUBMIT",
        idempotencyKey: "should-not-be-supported",
      });
      expect(result.operation.status).toBe("FAILED");
      expect(result.operation.errorCategory).toBe("VALIDATION");
    });
  });
});
