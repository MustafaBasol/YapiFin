import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { resetEnvCacheForTests } from "@/lib/env";
import { cleanDatabase, createOwnerOrg, createOrgUser } from "./helpers";
import {
  listConnectionsForOrg,
  getConnectionForUser,
  createConnection,
  updateConnectionMetadata,
  setConnectionCredential,
  disableConnection,
  enableConnection,
  deleteConnection,
  decryptCredentialForInternalUse,
} from "@/server/services/integrations/integration-service";

const TEST_KEY = "c".repeat(64);
let originalKey: string | undefined;

beforeAll(async () => {
  originalKey = process.env.INTEGRATION_ENCRYPTION_KEY;
  process.env.INTEGRATION_ENCRYPTION_KEY = TEST_KEY;
  // encryptIntegrationSecret/decryptIntegrationSecret getEnv()'i çağırır —
  // harness yalnızca DATABASE_URL'i enjekte eder, diğer zorunlu alanlar
  // (AUTH_SECRET vb.) burada güvenli test varsayılanlarıyla sağlanır
  // (bkz. tests/env.test.ts BASE_ENV ile aynı desen).
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
  await cleanDatabase();
});
afterAll(async () => {
  if (originalKey === undefined) delete process.env.INTEGRATION_ENCRYPTION_KEY;
  else process.env.INTEGRATION_ENCRYPTION_KEY = originalKey;
  resetEnvCacheForTests();
  await db.$disconnect();
});

const baseConnectionInput = {
  integrationType: "E_INVOICE" as const,
  provider: "NILVERA" as const,
  environment: "SANDBOX" as const,
  displayName: "Nilvera Test Bağlantısı",
  externalTenantId: undefined,
};

describe("entegrasyon bağlantı yönetimi (YF-605-A)", () => {
  it("OWNER ve ADMIN bağlantı oluşturabilir; FINANCE ve PROJECT_MANAGER oluşturamaz", async () => {
    const { owner } = await createOwnerOrg();
    const admin = await createOrgUser(owner.organizationId, "ADMIN");
    const finance = await createOrgUser(owner.organizationId, "FINANCE");
    const pm = await createOrgUser(owner.organizationId, "PROJECT_MANAGER");

    await expect(createConnection(owner, baseConnectionInput)).resolves.toMatchObject({
      displayName: baseConnectionInput.displayName,
      status: "INACTIVE",
    });
    await expect(
      createConnection(admin, { ...baseConnectionInput, environment: "PRODUCTION" }),
    ).resolves.toMatchObject({ environment: "PRODUCTION" });
    await expect(createConnection(finance, baseConnectionInput)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(createConnection(pm, baseConnectionInput)).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("FINANCE ve PROJECT_MANAGER kimlik bilgisi tanımlayamaz/yönetemez", async () => {
    const { owner } = await createOwnerOrg();
    const finance = await createOrgUser(owner.organizationId, "FINANCE");
    const pm = await createOrgUser(owner.organizationId, "PROJECT_MANAGER");
    const connection = await createConnection(owner, baseConnectionInput);

    await expect(
      setConnectionCredential(finance, { connectionId: connection.id, secretValue: "gizli" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      setConnectionCredential(pm, { connectionId: connection.id, secretValue: "gizli" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(getConnectionForUser(finance, connection.id)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(listConnectionsForOrg(pm)).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("organizasyon A, organizasyon B'nin bağlantısına erişemez (NOT_FOUND, fail-closed)", async () => {
    const { owner: ownerA } = await createOwnerOrg();
    const { owner: ownerB } = await createOwnerOrg();
    const connectionA = await createConnection(ownerA, baseConnectionInput);

    await expect(getConnectionForUser(ownerB, connectionA.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      updateConnectionMetadata(ownerB, { id: connectionA.id, displayName: "Ele geçirme denemesi" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      setConnectionCredential(ownerB, { connectionId: connectionA.id, secretValue: "x" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(disableConnection(ownerB, connectionA.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(deleteConnection(ownerB, connectionA.id)).rejects.toMatchObject({ code: "NOT_FOUND" });

    const visibleForB = await listConnectionsForOrg(ownerB);
    expect(visibleForB.find((c) => c.id === connectionA.id)).toBeUndefined();
  });

  it("aynı organizasyon+tür+sağlayıcı+ortam için ikinci bağlantı reddedilir (unique constraint)", async () => {
    const { owner } = await createOwnerOrg();
    await createConnection(owner, baseConnectionInput);
    await expect(createConnection(owner, baseConnectionInput)).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("liste ve tekil görüntüleme asla şifreli materyal/düz metin döndürmez", async () => {
    const { owner } = await createOwnerOrg();
    const connection = await createConnection(owner, baseConnectionInput);
    await setConnectionCredential(owner, { connectionId: connection.id, secretValue: "çok-gizli-anahtar" });

    const list = await listConnectionsForOrg(owner);
    const detail = await getConnectionForUser(owner, connection.id);

    for (const row of [...list, detail]) {
      const serialized = JSON.stringify(row);
      expect(serialized).not.toContain("çok-gizli-anahtar");
      expect(row).not.toHaveProperty("ciphertext");
      expect(row).not.toHaveProperty("iv");
      expect(row).not.toHaveProperty("authTag");
    }
    expect(detail.credentialConfigured).toBe(true);
  });

  it("kimlik bilgisi dahili servis üzerinden doğru şekilde çözülür (round-trip)", async () => {
    const { owner } = await createOwnerOrg();
    const connection = await createConnection(owner, baseConnectionInput);
    await setConnectionCredential(owner, { connectionId: connection.id, secretValue: "orijinal-deger-42" });

    const decrypted = await decryptCredentialForInternalUse(owner, connection.id);
    expect(decrypted).toBe("orijinal-deger-42");
  });

  it("yanlış şifreleme anahtarıyla çözme güvenli şekilde başarısız olur (ServiceError, düz metin sızdırmaz)", async () => {
    const { owner } = await createOwnerOrg();
    const connection = await createConnection(owner, baseConnectionInput);
    await setConnectionCredential(owner, { connectionId: connection.id, secretValue: "gizli-deger" });

    process.env.INTEGRATION_ENCRYPTION_KEY = "d".repeat(64);
    resetEnvCacheForTests();
    try {
      await expect(decryptCredentialForInternalUse(owner, connection.id)).rejects.toMatchObject({ code: "CONFLICT" });
    } finally {
      process.env.INTEGRATION_ENCRYPTION_KEY = TEST_KEY;
      resetEnvCacheForTests();
    }
  });

  it("kurcalanmış ciphertext ile çözme güvenli şekilde başarısız olur", async () => {
    const { owner } = await createOwnerOrg();
    const connection = await createConnection(owner, baseConnectionInput);
    await setConnectionCredential(owner, { connectionId: connection.id, secretValue: "gizli-deger" });

    await db.integrationCredential.update({
      where: { connectionId: connection.id },
      data: { ciphertext: Buffer.from("kurcalanmış-veri").toString("base64") },
    });

    await expect(decryptCredentialForInternalUse(owner, connection.id)).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("INTEGRATION_ENCRYPTION_KEY yapılandırılmamışsa kimlik bilgisi kaydı fail-closed reddedilir", async () => {
    const { owner } = await createOwnerOrg();
    const connection = await createConnection(owner, baseConnectionInput);

    delete process.env.INTEGRATION_ENCRYPTION_KEY;
    resetEnvCacheForTests();
    try {
      await expect(
        setConnectionCredential(owner, { connectionId: connection.id, secretValue: "gizli" }),
      ).rejects.toMatchObject({ code: "CONFLICT" });
    } finally {
      process.env.INTEGRATION_ENCRYPTION_KEY = TEST_KEY;
      resetEnvCacheForTests();
    }

    const credential = await db.integrationCredential.findUnique({ where: { connectionId: connection.id } });
    expect(credential).toBeNull();
  });

  it("kimlik bilgisi değiştirildiğinde rotate olarak denetlenir ve şifreli değer güncellenir", async () => {
    const { owner } = await createOwnerOrg();
    const connection = await createConnection(owner, baseConnectionInput);

    await setConnectionCredential(owner, { connectionId: connection.id, secretValue: "ilk-deger" });
    await setConnectionCredential(owner, { connectionId: connection.id, secretValue: "ikinci-deger" });

    const decrypted = await decryptCredentialForInternalUse(owner, connection.id);
    expect(decrypted).toBe("ikinci-deger");

    const logs = await db.auditLog.findMany({
      where: { entityType: "IntegrationCredential" },
      orderBy: { createdAt: "asc" },
    });
    expect(logs.map((l) => l.action)).toEqual(["integration.credential.set", "integration.credential.rotate"]);
  });

  it("audit log ve IntegrationEventLog hiçbir zaman düz metin kimlik bilgisi içermez", async () => {
    const { owner } = await createOwnerOrg();
    const connection = await createConnection(owner, baseConnectionInput);
    const secret = "asla-loglanmamasi-gereken-gizli-deger";
    await setConnectionCredential(owner, { connectionId: connection.id, secretValue: secret });

    const auditLogs = await db.auditLog.findMany({ where: { organizationId: owner.organizationId } });
    const eventLogs = await db.integrationEventLog.findMany({ where: { organizationId: owner.organizationId } });

    for (const log of auditLogs) {
      expect(JSON.stringify(log)).not.toContain(secret);
    }
    for (const log of eventLogs) {
      expect(JSON.stringify(log)).not.toContain(secret);
    }
    expect(eventLogs.some((l) => l.eventType === "credential.set")).toBe(true);
  });

  it("devre dışı bırakma durumu kalıcı olarak günceller; yeniden etkinleştirme geri alır", async () => {
    const { owner } = await createOwnerOrg();
    const connection = await createConnection(owner, baseConnectionInput);
    await enableConnection(owner, connection.id);

    const disabled = await disableConnection(owner, connection.id);
    expect(disabled.status).toBe("INACTIVE");

    const persisted = await getConnectionForUser(owner, connection.id);
    expect(persisted.status).toBe("INACTIVE");

    const reenabled = await enableConnection(owner, connection.id);
    expect(reenabled.status).toBe("ACTIVE");
  });

  it("gerçek uygulama akışıyla (createConnection sonrası DB'ye elle dokunmadan) yeni oluşturulan bağlantı silinebilir", async () => {
    const { owner } = await createOwnerOrg();
    const connection = await createConnection(owner, baseConnectionInput);

    // createConnection() zaten bir "connection.create" IntegrationEventLog satırı
    // yazdı (bkz. logIntegrationEvent) — bu, yönetici yaşam döngüsü olayıdır ve
    // silmeyi engellememelidir (YF-605-A PR #26 merge blocker düzeltmesi).
    const eventLogsBeforeDelete = await db.integrationEventLog.findMany({
      where: { connectionId: connection.id },
    });
    expect(eventLogsBeforeDelete.some((l) => l.eventType === "connection.create")).toBe(true);

    await deleteConnection(owner, connection.id);

    const found = await db.integrationConnection.findUnique({ where: { id: connection.id } });
    expect(found).toBeNull();
  });

  it("kimlik bilgisi tanımlanmış bağlantı silinemez, yalnızca devre dışı bırakılabilir", async () => {
    const { owner } = await createOwnerOrg();
    const connection = await createConnection(owner, baseConnectionInput);
    await setConnectionCredential(owner, { connectionId: connection.id, secretValue: "gizli" });

    await expect(deleteConnection(owner, connection.id)).rejects.toMatchObject({ code: "CONFLICT" });

    await disableConnection(owner, connection.id);
    const stillThere = await getConnectionForUser(owner, connection.id);
    expect(stillThere.status).toBe("INACTIVE");
  });

  it("anlamlı sağlayıcı/dış geçmişi olan bağlantı silinemez (henüz gerçek sağlayıcı adaptörü yok — sentetik olay eklenir)", async () => {
    const { owner } = await createOwnerOrg();
    const connection = await createConnection(owner, baseConnectionInput);

    // YF-605-A bu fazda gerçek sağlayıcı çağrısı yapmaz; gelecekteki bir
    // adaptörün üreteceği sağlayıcı-tetiklemeli olayı test etmek için tek satır
    // doğrudan DB'ye eklenir (görev talimatı: "Direct DB insertion of a
    // synthetic meaningful provider event is acceptable for testing the
    // deletion guard if no real provider adapter exists yet").
    await db.integrationEventLog.create({
      data: {
        organizationId: owner.organizationId,
        connectionId: connection.id,
        actorId: null,
        eventType: "provider.sync.completed",
        direction: "INBOUND",
        status: "SUCCESS",
      },
    });

    await expect(deleteConnection(owner, connection.id)).rejects.toMatchObject({ code: "CONFLICT" });

    const stillThere = await db.integrationConnection.findUnique({ where: { id: connection.id } });
    expect(stillThere).not.toBeNull();
  });

  it("yönetici yaşam döngüsü olayları (create/update/enable/disable) tek başına silmeyi engellemez", async () => {
    const { owner } = await createOwnerOrg();
    const connection = await createConnection(owner, baseConnectionInput);
    await updateConnectionMetadata(owner, { id: connection.id, displayName: "Güncellenmiş İsim" });
    await enableConnection(owner, connection.id);
    await disableConnection(owner, connection.id);

    const eventTypes = (
      await db.integrationEventLog.findMany({ where: { connectionId: connection.id } })
    ).map((l) => l.eventType);
    expect(eventTypes).toEqual(
      expect.arrayContaining(["connection.create", "connection.update", "connection.enable", "connection.disable"]),
    );

    await deleteConnection(owner, connection.id);

    const found = await db.integrationConnection.findUnique({ where: { id: connection.id } });
    expect(found).toBeNull();
  });

  it("başka organizasyonun bağlantısını silme denemesi NOT_FOUND ile reddedilir (silinebilir olsa bile)", async () => {
    const { owner: ownerA } = await createOwnerOrg();
    const { owner: ownerB } = await createOwnerOrg();
    const connectionA = await createConnection(ownerA, baseConnectionInput);

    await expect(deleteConnection(ownerB, connectionA.id)).rejects.toMatchObject({ code: "NOT_FOUND" });

    const stillThere = await db.integrationConnection.findUnique({ where: { id: connectionA.id } });
    expect(stillThere).not.toBeNull();
  });

  it("silme sonrası: AuditLog kalıcı kalır, bağlantıya ait IntegrationEventLog satırları temizlenir", async () => {
    const { owner } = await createOwnerOrg();
    const connection = await createConnection(owner, baseConnectionInput);
    await updateConnectionMetadata(owner, { id: connection.id, displayName: "Yeniden Adlandırıldı" });

    await deleteConnection(owner, connection.id);

    const deleteAuditLog = await db.auditLog.findFirst({
      where: {
        organizationId: owner.organizationId,
        entityType: "IntegrationConnection",
        entityId: connection.id,
        action: "integration.connection.delete",
      },
    });
    expect(deleteAuditLog).not.toBeNull();

    const createAuditLog = await db.auditLog.findFirst({
      where: {
        organizationId: owner.organizationId,
        entityType: "IntegrationConnection",
        entityId: connection.id,
        action: "integration.connection.create",
      },
    });
    expect(createAuditLog).not.toBeNull();

    const remainingEventLogs = await db.integrationEventLog.findMany({ where: { connectionId: connection.id } });
    expect(remainingEventLogs).toHaveLength(0);
  });

  it("geçersiz sağlayıcı/tür kombinasyonu (ör. E_INVOICE + PARASUT) servis dışı bir zorunluluk olarak Zod katmanında reddedilir", async () => {
    const { createIntegrationConnectionSchema } = await import("@/lib/validation/integration");
    const parsed = createIntegrationConnectionSchema.safeParse({
      integrationType: "E_INVOICE",
      provider: "PARASUT",
      environment: "SANDBOX",
      displayName: "Geçersiz kombinasyon",
    });
    expect(parsed.success).toBe(false);
  });

  it("gerçek bir dış sağlayıcı çağrısı yapılmaz (fetch/network kullanılmaz) — kimlik bilgisi işlemleri saf DB+crypto'dur", async () => {
    const { owner } = await createOwnerOrg();
    const connection = await createConnection(owner, baseConnectionInput);
    const originalFetch = globalThis.fetch;
    let fetchCalled = false;
    globalThis.fetch = ((...args: unknown[]) => {
      fetchCalled = true;
      throw new Error("fetch çağrılmamalıydı: " + JSON.stringify(args));
    }) as typeof fetch;
    try {
      await setConnectionCredential(owner, { connectionId: connection.id, secretValue: "gizli" });
      await enableConnection(owner, connection.id);
      await decryptCredentialForInternalUse(owner, connection.id);
    } finally {
      globalThis.fetch = originalFetch;
    }
    expect(fetchCalled).toBe(false);
  });
});
