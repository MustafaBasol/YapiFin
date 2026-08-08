import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { writeAuditLog } from "@/lib/audit";
import { canManageIntegrations } from "@/lib/permissions";
import { forbidden, notFound, conflict, ServiceError } from "@/server/services/errors";
import {
  encryptIntegrationSecret,
  decryptIntegrationSecret,
  IntegrationEncryptionConfigError,
} from "@/lib/integration-crypto";
import type { SessionUser } from "@/lib/auth/session";
import type {
  CreateIntegrationConnectionInput,
  UpdateIntegrationConnectionInput,
  SetIntegrationCredentialInput,
} from "@/lib/validation/integration";

type Tx = Prisma.TransactionClient;

/**
 * YF-605-A — provider-nötr entegrasyon temeli servis katmanı. Gerçek bir
 * sağlayıcı çağrısı YAPMAZ (bkz. docs/architecture/YF-605_...md, görev
 * talimatı "No real provider adapter"); yalnızca `IntegrationConnection`/
 * `IntegrationCredential`/`IntegrationEventLog` CRUD'ını yönetir.
 *
 * Yetki: yalnızca OWNER/ADMIN (bkz. lib/permissions.ts canManageIntegrations).
 * Tenant izolasyonu: her sorgu `id + organizationId` ile scope edilir,
 * bulunamayan/başka organizasyona ait kayıt NOT_FOUND olarak fail-closed
 * döner (mevcut customer-service.ts ile aynı desen).
 */

/**
 * `direction` yalnızca YF-605-B+ (gerçek giden/gelen sağlayıcı işlemleri,
 * bkz. provider-lifecycle-service.ts) tarafından geçirilir; bu dosyadaki
 * yönetici-tetiklemeli çağrılar (create/update/enable/disable/credential)
 * kasıtlı olarak `direction`'ı boş bırakır (bkz. IntegrationEventLog model
 * yorumu — yönetici olayları ne INBOUND ne OUTBOUND'dur).
 */
export async function logIntegrationEvent(
  tx: Tx,
  params: {
    organizationId: string;
    connectionId: string;
    actorId: string | null;
    eventType: string;
    direction?: "INBOUND" | "OUTBOUND" | null;
    status?: "SUCCESS" | "FAILURE";
    errorCode?: string | null;
    errorSummary?: string | null;
  },
) {
  await tx.integrationEventLog.create({
    data: {
      organizationId: params.organizationId,
      connectionId: params.connectionId,
      actorId: params.actorId,
      eventType: params.eventType,
      direction: params.direction ?? null,
      status: params.status ?? "SUCCESS",
      errorCode: params.errorCode ?? null,
      errorSummary: params.errorSummary ?? null,
    },
  });
}

/**
 * `connection.create/update/enable/disable` ve `credential.set/rotate`
 * yönetici-tetiklemeli yaşam döngüsü olaylarıdır — kimlik bilgisi olayları
 * zaten `deleteConnection`'da kimlik bilgisi varlığı kontrolüyle ayrıca
 * engellendiği için burada tekrar "anlamlı" sayılmaz. Bu listede OLMAYAN her
 * `eventType` (ör. gelecekteki sağlayıcı istek/yanıtı, senkronizasyon,
 * belge/webhook olayları) fail-closed olarak "anlamlı geçmiş" kabul edilir —
 * bkz. `hasMeaningfulIntegrationHistory`.
 */
const ADMINISTRATIVE_INTEGRATION_EVENT_TYPES = [
  "connection.create",
  "connection.update",
  "connection.enable",
  "connection.disable",
  "credential.set",
  "credential.rotate",
];

/** Silme güvenliği için: yalnızca yönetici yaşam döngüsü olayları DIŞINDA en az bir olay varsa true döner. */
async function hasMeaningfulIntegrationHistory(tx: Tx, connectionId: string) {
  const event = await tx.integrationEventLog.findFirst({
    where: {
      connectionId,
      OR: [
        { direction: { not: null } },
        { eventType: { notIn: ADMINISTRATIVE_INTEGRATION_EVENT_TYPES } },
      ],
    },
    select: { id: true },
  });
  return Boolean(event);
}

/** Diğer entegrasyon servisleri (ör. provider-lifecycle-service.ts) tenant yetkilendirme mantığını YİNELEMEK yerine bunu içe aktarmalıdır (görev talimatı "Do not duplicate tenant authorization logic"). */
export async function findOwnedConnection(actor: SessionUser, id: string) {
  const connection = await db.integrationConnection.findFirst({
    where: { id, organizationId: actor.organizationId },
  });
  if (!connection) throw notFound("Entegrasyon bağlantısı bulunamadı");
  return connection;
}

export async function listConnectionsForOrg(actor: SessionUser) {
  if (!canManageIntegrations(actor.role)) throw forbidden();

  const connections = await db.integrationConnection.findMany({
    where: { organizationId: actor.organizationId },
    orderBy: { createdAt: "desc" },
  });
  const credentials = await db.integrationCredential.findMany({
    where: { organizationId: actor.organizationId, connectionId: { in: connections.map((c) => c.id) } },
    select: { connectionId: true, updatedAt: true },
  });
  const credentialByConnection = new Map(credentials.map((c) => [c.connectionId, c.updatedAt]));

  return connections.map((connection) => ({
    ...connection,
    credentialConfigured: credentialByConnection.has(connection.id),
    credentialUpdatedAt: credentialByConnection.get(connection.id) ?? null,
  }));
}

export async function getConnectionForUser(actor: SessionUser, id: string) {
  if (!canManageIntegrations(actor.role)) throw forbidden();

  const connection = await findOwnedConnection(actor, id);
  const credential = await db.integrationCredential.findUnique({
    where: { connectionId: connection.id },
    select: { updatedAt: true },
  });

  return {
    ...connection,
    credentialConfigured: Boolean(credential),
    credentialUpdatedAt: credential?.updatedAt ?? null,
  };
}

export async function createConnection(actor: SessionUser, input: CreateIntegrationConnectionInput) {
  if (!canManageIntegrations(actor.role)) throw forbidden();

  return db
    .$transaction(async (tx) => {
      const connection = await tx.integrationConnection.create({
        data: {
          organizationId: actor.organizationId,
          integrationType: input.integrationType,
          provider: input.provider,
          environment: input.environment,
          displayName: input.displayName,
          externalTenantId: input.externalTenantId ?? null,
          status: "INACTIVE",
          createdById: actor.id,
        },
      });
      await writeAuditLog(tx, {
        organizationId: actor.organizationId,
        actorId: actor.id,
        action: "integration.connection.create",
        entityType: "IntegrationConnection",
        entityId: connection.id,
        after: {
          integrationType: connection.integrationType,
          provider: connection.provider,
          environment: connection.environment,
          displayName: connection.displayName,
        },
      });
      await logIntegrationEvent(tx, {
        organizationId: actor.organizationId,
        connectionId: connection.id,
        actorId: actor.id,
        eventType: "connection.create",
      });
      return connection;
    })
    .catch((err) => {
      if (err?.code === "P2002") throw conflict("Bu sağlayıcı/ortam için zaten bir bağlantı var");
      throw err;
    });
}

export async function updateConnectionMetadata(actor: SessionUser, input: UpdateIntegrationConnectionInput) {
  if (!canManageIntegrations(actor.role)) throw forbidden();

  const existing = await findOwnedConnection(actor, input.id);

  return db.$transaction(async (tx) => {
    const updated = await tx.integrationConnection.update({
      where: { id: existing.id },
      data: {
        displayName: input.displayName,
        externalTenantId: input.externalTenantId ?? null,
        updatedById: actor.id,
      },
    });
    await writeAuditLog(tx, {
      organizationId: actor.organizationId,
      actorId: actor.id,
      action: "integration.connection.update",
      entityType: "IntegrationConnection",
      entityId: updated.id,
      before: { displayName: existing.displayName, externalTenantId: existing.externalTenantId },
      after: { displayName: updated.displayName, externalTenantId: updated.externalTenantId },
    });
    await logIntegrationEvent(tx, {
      organizationId: actor.organizationId,
      connectionId: updated.id,
      actorId: actor.id,
      eventType: "connection.update",
    });
    return updated;
  });
}

async function setConnectionStatus(actor: SessionUser, id: string, status: "ACTIVE" | "INACTIVE") {
  if (!canManageIntegrations(actor.role)) throw forbidden();

  const existing = await findOwnedConnection(actor, id);

  return db.$transaction(async (tx) => {
    const updated = await tx.integrationConnection.update({
      where: { id: existing.id },
      data: { status, updatedById: actor.id },
    });
    await writeAuditLog(tx, {
      organizationId: actor.organizationId,
      actorId: actor.id,
      action: status === "ACTIVE" ? "integration.connection.enable" : "integration.connection.disable",
      entityType: "IntegrationConnection",
      entityId: updated.id,
      before: { status: existing.status },
      after: { status: updated.status },
    });
    await logIntegrationEvent(tx, {
      organizationId: actor.organizationId,
      connectionId: updated.id,
      actorId: actor.id,
      eventType: status === "ACTIVE" ? "connection.enable" : "connection.disable",
    });
    return updated;
  });
}

/** IntegrationConnection.status varsayılan INACTIVE'dir (opt-in) — bu, organizasyonun bağlantıyı bilinçli olarak etkinleştirmesi içindir. */
export const enableConnection = (actor: SessionUser, id: string) => setConnectionStatus(actor, id, "ACTIVE");
export const disableConnection = (actor: SessionUser, id: string) => setConnectionStatus(actor, id, "INACTIVE");

/**
 * Kimlik bilgisini şifreleyip saklar (ilk tanımlamada `credential.set`,
 * mevcut bir kaydın üzerine yazıldığında `credential.rotate` olarak
 * denetlenir). Dönüş değeri KASITLI olarak yalnızca `configured`/`updatedAt`
 * içerir — düz metin veya şifreli materyal hiçbir zaman çağırana döndürülmez.
 */
export async function setConnectionCredential(actor: SessionUser, input: SetIntegrationCredentialInput) {
  if (!canManageIntegrations(actor.role)) throw forbidden();

  const connection = await findOwnedConnection(actor, input.connectionId);
  const existing = await db.integrationCredential.findUnique({
    where: { connectionId: connection.id },
    select: { id: true },
  });

  let encrypted;
  try {
    encrypted = encryptIntegrationSecret(input.secretValue);
  } catch (err) {
    if (err instanceof IntegrationEncryptionConfigError) {
      throw new ServiceError(
        "Entegrasyon kimlik bilgisi şifreleme anahtarı yapılandırılmamış — INTEGRATION_ENCRYPTION_KEY ayarlanmadan kimlik bilgisi kaydedilemez.",
        "CONFLICT",
      );
    }
    throw err;
  }

  const action = existing ? "integration.credential.rotate" : "integration.credential.set";
  const eventType = existing ? "credential.rotate" : "credential.set";

  return db.$transaction(async (tx) => {
    const credential = await tx.integrationCredential.upsert({
      where: { connectionId: connection.id },
      create: {
        organizationId: actor.organizationId,
        connectionId: connection.id,
        ciphertext: encrypted.ciphertext,
        iv: encrypted.iv,
        authTag: encrypted.authTag,
        keyVersion: encrypted.keyVersion,
        updatedById: actor.id,
      },
      update: {
        ciphertext: encrypted.ciphertext,
        iv: encrypted.iv,
        authTag: encrypted.authTag,
        keyVersion: encrypted.keyVersion,
        updatedById: actor.id,
      },
    });
    await writeAuditLog(tx, {
      organizationId: actor.organizationId,
      actorId: actor.id,
      action,
      entityType: "IntegrationCredential",
      entityId: credential.id,
      after: { connectionId: connection.id, provider: connection.provider },
    });
    await logIntegrationEvent(tx, {
      organizationId: actor.organizationId,
      connectionId: connection.id,
      actorId: actor.id,
      eventType,
    });
    return { configured: true as const, updatedAt: credential.updatedAt };
  });
}

/**
 * Yönetimsel lifecycle olayları silmeyi engellemez. Kimlik bilgisi veya
 * sağlayıcıya dönük/anlamı bilinmeyen teknik geçmiş varsa bağlantı yalnızca
 * devre dışı bırakılabilir. Kullanılmamış bağlantının teknik lifecycle logları
 * bağlantıyla aynı transaction'da temizlenir; kalıcı yönetim izi AuditLog'da
 * connection id ile korunur.
 */
export async function deleteConnection(actor: SessionUser, id: string) {
  if (!canManageIntegrations(actor.role)) throw forbidden();

  const existing = await findOwnedConnection(actor, id);

  return db.$transaction(async (tx) => {
    const [credential, hasMeaningfulHistory] = await Promise.all([
      tx.integrationCredential.findUnique({ where: { connectionId: existing.id }, select: { id: true } }),
      hasMeaningfulIntegrationHistory(tx, existing.id),
    ]);
    if (credential || hasMeaningfulHistory) {
      throw conflict(
        "Kimlik bilgisi tanımlanmış veya dış sağlayıcı geçmişi olan bir bağlantı silinemez; yalnızca devre dışı bırakılabilir",
      );
    }

    await tx.integrationEventLog.deleteMany({
      where: { connectionId: existing.id },
    });
    const result = await tx.integrationConnection.deleteMany({
      where: { id: existing.id, organizationId: actor.organizationId },
    });
    if (result.count === 0) throw notFound("Entegrasyon bağlantısı bulunamadı");

    await writeAuditLog(tx, {
      organizationId: actor.organizationId,
      actorId: actor.id,
      action: "integration.connection.delete",
      entityType: "IntegrationConnection",
      entityId: existing.id,
      before: {
        integrationType: existing.integrationType,
        provider: existing.provider,
        environment: existing.environment,
      },
    });
  });
}
/**
 * YALNIZCA dahili kullanım/testler içindir — hiçbir server action veya route
 * bu fonksiyonu çağırmaz (görev talimatı "plaintext credentials must never
 * be returned by read/list APIs/actions"). Gelecekteki sağlayıcı adaptörleri
 * (YF-605-B+) gerçek API çağrısı yapmadan önce kimlik bilgisini bu fonksiyon
 * üzerinden çözecektir. Yanlış anahtar veya kurcalanmış ciphertext/authTag
 * durumunda ham şifreleme hatası ASLA dışarı sızmaz, güvenli bir
 * `ServiceError`'a çevrilir.
 */
export async function decryptCredentialForInternalUse(actor: SessionUser, connectionId: string): Promise<string> {
  if (!canManageIntegrations(actor.role)) throw forbidden();

  const connection = await findOwnedConnection(actor, connectionId);
  const credential = await db.integrationCredential.findUnique({ where: { connectionId: connection.id } });
  if (!credential) throw notFound("Bu bağlantı için kimlik bilgisi tanımlanmamış");

  try {
    return decryptIntegrationSecret({
      ciphertext: credential.ciphertext,
      iv: credential.iv,
      authTag: credential.authTag,
      keyVersion: credential.keyVersion,
    });
  } catch {
    // Ham crypto hatası (kurcalama/yanlış anahtar/yapılandırma) hiçbir zaman
    // sızdırılmaz — yalnızca güvenli, genel bir mesaj fırlatılır.
    throw new ServiceError("Kimlik bilgisi çözülemedi", "CONFLICT");
  }
}
