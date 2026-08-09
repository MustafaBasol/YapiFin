import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { resetEnvCacheForTests } from "@/lib/env";
import { cleanDatabase, createOwnerOrg, createOrgUser } from "./helpers";
import { createConnection, setConnectionCredential } from "@/server/services/integrations/integration-service";
import { testProviderConnection, executeOutboundOperation } from "@/server/services/integrations/provider-lifecycle-service";
import {
  resolveProviderAdapter,
  registerProviderAdapterForTests,
  resetProviderRegistryForTests,
} from "@/server/services/integrations/provider-registry";
import { createFakeProviderAdapter } from "@/server/services/integrations/providers/fake-provider";
import { ProviderError } from "@/server/services/integrations/provider-adapter";

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

const genericConnectionInput = {
  integrationType: "E_INVOICE" as const,
  provider: "GENERIC" as const,
  environment: "SANDBOX" as const,
  displayName: "Sahte Sağlayıcı Bağlantısı",
  externalTenantId: undefined,
};

const nilveraConnectionInput = {
  integrationType: "E_INVOICE" as const,
  provider: "NILVERA" as const,
  environment: "SANDBOX" as const,
  displayName: "Nilvera Test Bağlantısı",
  externalTenantId: undefined,
};

async function createConnectionWithCredential(owner: Awaited<ReturnType<typeof createOwnerOrg>>["owner"], input: typeof genericConnectionInput | typeof nilveraConnectionInput, secretValue = "test-sir-degeri") {
  const connection = await createConnection(owner, input);
  await setConnectionCredential(owner, { connectionId: connection.id, secretValue });
  return connection;
}

describe("sağlayıcı adaptör sözleşmesi ve yaşam döngüsü (YF-605-B)", () => {
  describe("registry çözümleme", () => {
    it("GENERIC için varsayılan sahte adaptör çözümlenir ve doğru yetenekleri bildirir", () => {
      const adapter = resolveProviderAdapter("GENERIC");
      expect(adapter.provider).toBe("GENERIC");
      expect(adapter.capabilities).toEqual(expect.arrayContaining(["CONNECTION_TEST", "OUTBOUND_OPERATION"]));
    });

    it("henüz adaptörü olmayan bir sağlayıcı (UYUMSOFT) sınıflandırılmış VALIDATION hatasıyla reddedilir", () => {
      // YF-605-D — NILVERA artık gerçek (salt-okunur) bir adaptöre sahip (bkz.
      // providers/nilvera-provider.ts); "adaptörü olmayan sağlayıcı" senaryosu
      // için hâlâ somut bir adaptörü olmayan UYUMSOFT kullanılır.
      expect(() => resolveProviderAdapter("UYUMSOFT")).toThrow(ProviderError);
      try {
        resolveProviderAdapter("UYUMSOFT");
        expect.unreachable();
      } catch (err) {
        expect(err).toBeInstanceOf(ProviderError);
        expect((err as ProviderError).category).toBe("VALIDATION");
      }
    });

    it("test override kaydedildiğinde bir sağlayıcı için geçici olarak sahte adaptör kullanılabilir", () => {
      registerProviderAdapterForTests("UYUMSOFT", () => createFakeProviderAdapter("UYUMSOFT"));
      const adapter = resolveProviderAdapter("UYUMSOFT");
      expect(adapter.provider).toBe("UYUMSOFT");

      resetProviderRegistryForTests();
      expect(() => resolveProviderAdapter("UYUMSOFT")).toThrow(ProviderError);
    });

    it("NILVERA için gerçek salt-okunur sandbox adaptörü çözümlenir ve yalnızca sorgu yeteneklerini bildirir", () => {
      const adapter = resolveProviderAdapter("NILVERA");
      expect(adapter.provider).toBe("NILVERA");
      expect(adapter.capabilities).toEqual(
        expect.arrayContaining(["TAXPAYER_LOOKUP", "DOCUMENT_STATUS_LOOKUP"]),
      );
      expect(adapter.capabilities).not.toContain("CONNECTION_TEST");
      expect(adapter.capabilities).not.toContain("OUTBOUND_OPERATION");
    });
  });

  describe("sahte adaptör davranışı", () => {
    it("kimlik bilgisi boşsa AUTH_CONFIG kategorisiyle başarısız olur", async () => {
      const adapter = createFakeProviderAdapter("GENERIC");
      await expect(
        adapter.testConnection({ secretValue: "" }, {
          connectionId: "c1",
          organizationId: "o1",
          provider: "GENERIC",
          environment: "SANDBOX",
          externalTenantId: null,
        }),
      ).rejects.toMatchObject({ category: "AUTH_CONFIG" });
    });

    it("kimlik bilgisi doluysa varsayılan davranış başarılıdır", async () => {
      const adapter = createFakeProviderAdapter("GENERIC");
      const ctx = { connectionId: "c1", organizationId: "o1", provider: "GENERIC" as const, environment: "SANDBOX" as const, externalTenantId: null };
      await expect(adapter.testConnection({ secretValue: "x" }, ctx)).resolves.toMatchObject({ ok: true });
      await expect(
        adapter.executeOutboundOperation({ operationType: "TEST_OP", idempotencyKey: "k1" }, { secretValue: "x" }, ctx),
      ).resolves.toMatchObject({ ok: true });
    });
  });

  describe("bağlantı testi (connection test / health-check)", () => {
    it("GENERIC bağlantı için başarıyla tamamlanır ve SUCCESS olay kaydı üretir", async () => {
      const { owner } = await createOwnerOrg();
      const connection = await createConnectionWithCredential(owner, genericConnectionInput);

      const result = await testProviderConnection(owner, connection.id);
      expect(result.ok).toBe(true);

      const logs = await db.integrationEventLog.findMany({ where: { connectionId: connection.id, eventType: "connection.test" } });
      expect(logs).toHaveLength(1);
      expect(logs[0].status).toBe("SUCCESS");
      expect(logs[0].direction).toBe("OUTBOUND");
    });

    it("adaptör başarısız olduğunda ok:false + kategori döner ve FAILURE olay kaydı üretir", async () => {
      const { owner } = await createOwnerOrg();
      registerProviderAdapterForTests("NILVERA", () =>
        createFakeProviderAdapter("NILVERA", {
          testConnection: () => {
            throw new ProviderError("Sağlayıcı geçici olarak yanıt vermiyor", "TEMPORARY_PROVIDER");
          },
        }),
      );
      const connection = await createConnectionWithCredential(owner, nilveraConnectionInput);

      const result = await testProviderConnection(owner, connection.id);
      expect(result.ok).toBe(false);
      expect(result.category).toBe("TEMPORARY_PROVIDER");

      const logs = await db.integrationEventLog.findMany({ where: { connectionId: connection.id, eventType: "connection.test" } });
      expect(logs).toHaveLength(1);
      expect(logs[0].status).toBe("FAILURE");
      expect(logs[0].errorCode).toBe("TEMPORARY_PROVIDER");
    });

    it("sağlayıcı için adaptör tanımlı değilse (NILVERA) VALIDATION kategorisiyle başarısız olur", async () => {
      const { owner } = await createOwnerOrg();
      const connection = await createConnectionWithCredential(owner, nilveraConnectionInput);

      const result = await testProviderConnection(owner, connection.id);
      expect(result.ok).toBe(false);
      expect(result.category).toBe("VALIDATION");
    });

    it("kimlik bilgisi hiçbir log/hata mesajında düz metin olarak görünmez", async () => {
      const { owner } = await createOwnerOrg();
      const secret = "asla-sizmamasi-gereken-cok-gizli-deger";
      registerProviderAdapterForTests("NILVERA", () =>
        createFakeProviderAdapter("NILVERA", {
          testConnection: (credentials) => {
            // Kasıtlı olarak kötü davranan bir adaptör simülasyonu: mesaja sır değerini
            // sızdırmaya çalışır — provider-lifecycle-service.ts bunu redaksiyonla temizlemelidir.
            throw new ProviderError(`Kimlik doğrulama başarısız: ${credentials.secretValue}`, "AUTH_CONFIG");
          },
        }),
      );
      const connection = await createConnectionWithCredential(owner, nilveraConnectionInput, secret);

      const result = await testProviderConnection(owner, connection.id);
      expect(result.summary).not.toContain(secret);

      const logs = await db.integrationEventLog.findMany({ where: { connectionId: connection.id } });
      for (const log of logs) {
        expect(JSON.stringify(log)).not.toContain(secret);
      }
    });

    it("başka organizasyonun bağlantısı için test denemesi NOT_FOUND ile reddedilir", async () => {
      const { owner: ownerA } = await createOwnerOrg();
      const { owner: ownerB } = await createOwnerOrg();
      const connection = await createConnectionWithCredential(ownerA, genericConnectionInput);

      await expect(testProviderConnection(ownerB, connection.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
    });

    it("FINANCE ve PROJECT_MANAGER bağlantı testi başlatamaz", async () => {
      const { owner } = await createOwnerOrg();
      const finance = await createOrgUser(owner.organizationId, "FINANCE");
      const pm = await createOrgUser(owner.organizationId, "PROJECT_MANAGER");
      const connection = await createConnectionWithCredential(owner, genericConnectionInput);

      await expect(testProviderConnection(finance, connection.id)).rejects.toMatchObject({ code: "FORBIDDEN" });
      await expect(testProviderConnection(pm, connection.id)).rejects.toMatchObject({ code: "FORBIDDEN" });
    });

    it("gerçek bir dış sağlayıcı çağrısı yapılmaz (fetch kullanılmaz)", async () => {
      const { owner } = await createOwnerOrg();
      const connection = await createConnectionWithCredential(owner, genericConnectionInput);
      const originalFetch = globalThis.fetch;
      let fetchCalled = false;
      globalThis.fetch = ((...args: unknown[]) => {
        fetchCalled = true;
        throw new Error("fetch çağrılmamalıydı: " + JSON.stringify(args));
      }) as typeof fetch;
      try {
        await testProviderConnection(owner, connection.id);
      } finally {
        globalThis.fetch = originalFetch;
      }
      expect(fetchCalled).toBe(false);
    });
  });

  describe("giden işlem yaşam döngüsü (outbound operation lifecycle) ve idempotency", () => {
    it("aynı idempotencyKey ile ikinci çağrı sağlayıcıyı tekrar çağırmaz, kayıtlı sonucu döner", async () => {
      const { owner } = await createOwnerOrg();
      const connection = await createConnectionWithCredential(owner, genericConnectionInput);

      let callCount = 0;
      registerProviderAdapterForTests("GENERIC", () =>
        createFakeProviderAdapter("GENERIC", {
          executeOutboundOperation: () => {
            callCount += 1;
            return { ok: true, resultSummary: { call: callCount } };
          },
        }),
      );

      const input = { connectionId: connection.id, operationType: "TEST_SUBMIT", idempotencyKey: "op-1" };
      const first = await executeOutboundOperation(owner, input);
      const second = await executeOutboundOperation(owner, input);

      expect(first.alreadyCompleted).toBe(false);
      expect(second.alreadyCompleted).toBe(true);
      expect(callCount).toBe(1);
      expect(second.operation.id).toBe(first.operation.id);

      const rows = await db.integrationOutboundOperation.findMany({ where: { connectionId: connection.id } });
      expect(rows).toHaveLength(1);
      expect(rows[0].status).toBe("SUCCESS");
    });

    it("eşzamanlı (concurrent) aynı idempotencyKey denemeleri ikinci bağımsız bir kayıt oluşturmaz", async () => {
      const { owner } = await createOwnerOrg();
      const connection = await createConnectionWithCredential(owner, genericConnectionInput);

      const input = { connectionId: connection.id, operationType: "TEST_SUBMIT", idempotencyKey: "concurrent-op" };
      await Promise.all([executeOutboundOperation(owner, input), executeOutboundOperation(owner, input)]);

      const rows = await db.integrationOutboundOperation.findMany({ where: { connectionId: connection.id, idempotencyKey: "concurrent-op" } });
      expect(rows).toHaveLength(1);
    });

    it("farklı idempotencyKey değerleri bağımsız işlemler olarak izlenir", async () => {
      const { owner } = await createOwnerOrg();
      const connection = await createConnectionWithCredential(owner, genericConnectionInput);

      await executeOutboundOperation(owner, { connectionId: connection.id, operationType: "TEST_SUBMIT", idempotencyKey: "a" });
      await executeOutboundOperation(owner, { connectionId: connection.id, operationType: "TEST_SUBMIT", idempotencyKey: "b" });

      const rows = await db.integrationOutboundOperation.findMany({ where: { connectionId: connection.id } });
      expect(rows).toHaveLength(2);
    });

    it("yeniden denenebilir hata (TIMEOUT_NETWORK) RETRYING durumuna geçer, MAX deneme sonrası DEAD_LETTER olur", async () => {
      const { owner } = await createOwnerOrg();
      registerProviderAdapterForTests("NILVERA", () =>
        createFakeProviderAdapter("NILVERA", {
          executeOutboundOperation: () => {
            throw new ProviderError("Bağlantı zaman aşımına uğradı", "TIMEOUT_NETWORK");
          },
        }),
      );
      const connection = await createConnectionWithCredential(owner, nilveraConnectionInput);
      const input = { connectionId: connection.id, operationType: "TEST_SUBMIT", idempotencyKey: "retry-op" };

      let last = await executeOutboundOperation(owner, input);
      expect(last.operation.status).toBe("RETRYING");
      expect(last.operation.attempts).toBe(1);
      expect(last.operation.errorCategory).toBe("TIMEOUT_NETWORK");

      for (let i = 2; i <= 5; i += 1) {
        last = await executeOutboundOperation(owner, input);
      }
      expect(last.operation.status).toBe("DEAD_LETTER");
      expect(last.operation.attempts).toBe(5);

      await expect(executeOutboundOperation(owner, input)).rejects.toMatchObject({ code: "CONFLICT" });
    });

    it("kalıcı hata (PERMANENT_REJECTION) tek denemede FAILED olur ve yeniden denenemez", async () => {
      const { owner } = await createOwnerOrg();
      registerProviderAdapterForTests("NILVERA", () =>
        createFakeProviderAdapter("NILVERA", {
          executeOutboundOperation: () => {
            throw new ProviderError("Sağlayıcı belgeyi kalıcı olarak reddetti", "PERMANENT_REJECTION", "REJ-01");
          },
        }),
      );
      const connection = await createConnectionWithCredential(owner, nilveraConnectionInput);
      const input = { connectionId: connection.id, operationType: "TEST_SUBMIT", idempotencyKey: "permanent-op" };

      const result = await executeOutboundOperation(owner, input);
      expect(result.operation.status).toBe("FAILED");
      expect(result.operation.attempts).toBe(1);
      expect(result.operation.errorCategory).toBe("PERMANENT_REJECTION");
      expect(result.operation.errorCode).toBe("REJ-01");

      await expect(executeOutboundOperation(owner, input)).rejects.toMatchObject({ code: "CONFLICT" });
    });

    it("adaptör OUTBOUND_OPERATION yeteneğini bildirmiyorsa VALIDATION ile kalıcı başarısız olur", async () => {
      const { owner } = await createOwnerOrg();
      registerProviderAdapterForTests("NILVERA", () => createFakeProviderAdapter("NILVERA", { capabilities: ["CONNECTION_TEST"] }));
      const connection = await createConnectionWithCredential(owner, nilveraConnectionInput);

      const result = await executeOutboundOperation(owner, {
        connectionId: connection.id,
        operationType: "TEST_SUBMIT",
        idempotencyKey: "no-capability-op",
      });
      expect(result.operation.status).toBe("FAILED");
      expect(result.operation.errorCategory).toBe("VALIDATION");
    });

    it("sağlayıcı için adaptör tanımlı değilse (NILVERA) işlem VALIDATION ile kalıcı başarısız olur", async () => {
      const { owner } = await createOwnerOrg();
      const connection = await createConnectionWithCredential(owner, nilveraConnectionInput);

      const result = await executeOutboundOperation(owner, {
        connectionId: connection.id,
        operationType: "TEST_SUBMIT",
        idempotencyKey: "unsupported-op",
      });
      expect(result.operation.status).toBe("FAILED");
      expect(result.operation.errorCategory).toBe("VALIDATION");
    });

    it("her deneme IntegrationEventLog'a yazılır ve hiçbir zaman ham sır içermez", async () => {
      const { owner } = await createOwnerOrg();
      const secret = "gizli-outbound-sir-42";
      registerProviderAdapterForTests("NILVERA", () =>
        createFakeProviderAdapter("NILVERA", {
          executeOutboundOperation: (_input, credentials) => {
            throw new ProviderError(`Reddedildi: ${credentials.secretValue}`, "PERMANENT_REJECTION");
          },
        }),
      );
      const connection = await createConnectionWithCredential(owner, nilveraConnectionInput, secret);

      await executeOutboundOperation(owner, { connectionId: connection.id, operationType: "TEST_SUBMIT", idempotencyKey: "log-op" });

      const logs = await db.integrationEventLog.findMany({ where: { connectionId: connection.id }, orderBy: { createdAt: "asc" } });
      const eventTypes = logs.map((l) => l.eventType);
      expect(eventTypes).toEqual(expect.arrayContaining(["outbound.TEST_SUBMIT.create", "outbound.TEST_SUBMIT.failure"]));
      for (const log of logs) {
        expect(JSON.stringify(log)).not.toContain(secret);
      }
    });

    it("başka organizasyonun bağlantısı için giden işlem NOT_FOUND ile reddedilir", async () => {
      const { owner: ownerA } = await createOwnerOrg();
      const { owner: ownerB } = await createOwnerOrg();
      const connection = await createConnectionWithCredential(ownerA, genericConnectionInput);

      await expect(
        executeOutboundOperation(ownerB, { connectionId: connection.id, operationType: "TEST_SUBMIT", idempotencyKey: "cross-tenant" }),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });

      const rows = await db.integrationOutboundOperation.findMany({ where: { connectionId: connection.id } });
      expect(rows).toHaveLength(0);
    });

    it("FINANCE ve PROJECT_MANAGER giden işlem başlatamaz", async () => {
      const { owner } = await createOwnerOrg();
      const finance = await createOrgUser(owner.organizationId, "FINANCE");
      const pm = await createOrgUser(owner.organizationId, "PROJECT_MANAGER");
      const connection = await createConnectionWithCredential(owner, genericConnectionInput);

      await expect(
        executeOutboundOperation(finance, { connectionId: connection.id, operationType: "TEST_SUBMIT", idempotencyKey: "auth-op" }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
      await expect(
        executeOutboundOperation(pm, { connectionId: connection.id, operationType: "TEST_SUBMIT", idempotencyKey: "auth-op" }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
    });

    it("boş operationType/idempotencyKey VALIDATION ile reddedilir", async () => {
      const { owner } = await createOwnerOrg();
      const connection = await createConnectionWithCredential(owner, genericConnectionInput);

      await expect(
        executeOutboundOperation(owner, { connectionId: connection.id, operationType: "", idempotencyKey: "x" }),
      ).rejects.toMatchObject({ code: "VALIDATION" });
      await expect(
        executeOutboundOperation(owner, { connectionId: connection.id, operationType: "x", idempotencyKey: "  " }),
      ).rejects.toMatchObject({ code: "VALIDATION" });
    });
  });
});
