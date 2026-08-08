import type { IntegrationConnection, IntegrationErrorCategory, IntegrationOutboundOperationStatus } from "@prisma/client";
import { db } from "@/lib/db";
import { canManageIntegrations } from "@/lib/permissions";
import { conflict, forbidden, ServiceError } from "@/server/services/errors";
import type { SessionUser } from "@/lib/auth/session";
import { decryptCredentialForInternalUse, findOwnedConnection, logIntegrationEvent } from "./integration-service";
import { ProviderError, isRetryableErrorCategory, type ProviderConnectionContext } from "./provider-adapter";
import { resolveProviderAdapter } from "./provider-registry";

/**
 * YF-605-B — provider-nötr bağlantı testi ve giden işlem yaşam döngüsü
 * (bkz. docs/architecture/YF-605_EINVOICE_ACCOUNTING_INTEGRATIONS.md §9/§10).
 * Yetki ve tenant izolasyonu `integration-service.ts`'ten YİNELENMEDEN
 * (`findOwnedConnection`/`decryptCredentialForInternalUse`) yeniden kullanılır.
 * Bu dosya gerçek bir sağlayıcıya asla doğrudan bağlı değildir — hangi
 * sağlayıcının çağrılacağı `provider-registry.ts` üzerinden çözülür.
 */

/** Sınırlı sayıda deneme (mimari doküman §10 önerisi) — bu sayıya ulaşan yeniden-denenebilir hatalar DEAD_LETTER'a geçer, sonsuz sessiz retry döngüsü yoktur. */
const MAX_OUTBOUND_ATTEMPTS = 5;
const MAX_ERROR_SUMMARY_LENGTH = 500;

function buildContext(connection: IntegrationConnection, actor: SessionUser): ProviderConnectionContext {
  return {
    connectionId: connection.id,
    organizationId: actor.organizationId,
    provider: connection.provider,
    environment: connection.environment,
    externalTenantId: connection.externalTenantId,
  };
}

/** Bilinen sır değerini hata mesajından temizler — adaptör sözleşmesi zaten sır sızdırmamayı zorunlu kılar (bkz. ProviderError), bu yalnızca ikinci bir savunma katmanıdır. */
function redactSecret(message: string, secret: string): string {
  if (!secret) return message;
  return message.split(secret).join("[REDACTED]");
}

interface ClassifiedProviderError {
  category: IntegrationErrorCategory;
  providerCode?: string;
  safeMessage: string;
}

/** Provider-nötr hata sınıflandırması (görev talimatı "Provider-neutral error classification"). `ProviderError` DIŞINDA hiçbir hata ayrıntısı dışarı sızmaz — yalnızca genel, güvenli bir mesaj kullanılır. */
function classifyProviderError(err: unknown, secret: string): ClassifiedProviderError {
  if (err instanceof ProviderError) {
    return {
      category: err.category,
      providerCode: err.providerCode,
      safeMessage: redactSecret(err.message, secret).slice(0, MAX_ERROR_SUMMARY_LENGTH),
    };
  }
  return {
    category: "UNKNOWN",
    safeMessage: "Sağlayıcı işlemi sınıflandırılmamış bir nedenle başarısız oldu",
  };
}

/**
 * Sağlayıcı bağlantı testi/health-check (görev talimatı "Connection test /
 * health-check lifecycle"). Hiçbir zaman fırlatmaz (yetki/bulunamadı/kimlik
 * bilgisi eksik durumları HARİÇ) — sağlayıcı tarafı başarısızlıkları
 * `{ ok: false }` olarak döner, çağıran UI bunu doğrudan gösterebilir.
 */
export async function testProviderConnection(actor: SessionUser, connectionId: string) {
  if (!canManageIntegrations(actor.role)) throw forbidden();

  const connection = await findOwnedConnection(actor, connectionId);
  const secretValue = await decryptCredentialForInternalUse(actor, connectionId);
  const ctx = buildContext(connection, actor);

  try {
    const adapter = resolveProviderAdapter(connection.provider);
    if (!adapter.capabilities.includes("CONNECTION_TEST")) {
      throw new ProviderError("Sağlayıcı bağlantı testini desteklemiyor", "VALIDATION");
    }
    const result = await adapter.testConnection({ secretValue }, ctx);

    await db.$transaction((tx) =>
      logIntegrationEvent(tx, {
        organizationId: actor.organizationId,
        connectionId: connection.id,
        actorId: actor.id,
        eventType: "connection.test",
        direction: "OUTBOUND",
        status: "SUCCESS",
      }),
    );
    return { ok: true as const, summary: result.summary };
  } catch (err) {
    const classified = classifyProviderError(err, secretValue);
    await db.$transaction((tx) =>
      logIntegrationEvent(tx, {
        organizationId: actor.organizationId,
        connectionId: connection.id,
        actorId: actor.id,
        eventType: "connection.test",
        direction: "OUTBOUND",
        status: "FAILURE",
        errorCode: classified.category,
        errorSummary: classified.safeMessage,
      }),
    );
    return { ok: false as const, category: classified.category, summary: classified.safeMessage };
  }
}

export interface ExecuteOutboundOperationInput {
  connectionId: string;
  operationType: string;
  idempotencyKey: string;
  payloadSummary?: Record<string, unknown>;
}

/**
 * Mantıksal işlem kimliği (`connectionId`+`operationType`+`idempotencyKey`)
 * için PENDING satırı idempotent şekilde oluşturur/döndürür. `Settlement`/
 * `AccountTransfer` idempotencyKey deseniyle BİREBİR aynı yaklaşım: unique
 * kısıt + P2002 yakalama — check-then-create YARIŞI yoktur (görev talimatı
 * "Do not use unsafe check-then-create logic where concurrency can produce
 * duplicates").
 */
async function getOrCreateOutboundOperation(actor: SessionUser, connection: IntegrationConnection, input: ExecuteOutboundOperationInput) {
  try {
    return await db.$transaction(async (tx) => {
      const operation = await tx.integrationOutboundOperation.create({
        data: {
          organizationId: actor.organizationId,
          connectionId: connection.id,
          operationType: input.operationType,
          idempotencyKey: input.idempotencyKey,
          status: "PENDING",
          createdById: actor.id,
        },
      });
      await logIntegrationEvent(tx, {
        organizationId: actor.organizationId,
        connectionId: connection.id,
        actorId: actor.id,
        eventType: `outbound.${input.operationType}.create`,
        direction: "OUTBOUND",
      });
      return operation;
    });
  } catch (err) {
    if ((err as { code?: string })?.code === "P2002") {
      const existing = await db.integrationOutboundOperation.findUnique({
        where: {
          connectionId_operationType_idempotencyKey: {
            connectionId: connection.id,
            operationType: input.operationType,
            idempotencyKey: input.idempotencyKey,
          },
        },
      });
      if (existing) return existing;
      throw conflict("Bu işlem daha önce gönderilmiş");
    }
    throw err;
  }
}

/**
 * Giden e-belge işlem yaşam döngüsü (domain düzeyi, görev talimatı "Outbound
 * e-document operation lifecycle at domain level"). Aynı mantıksal işlem
 * (aynı idempotencyKey) tekrar çağrıldığında:
 * - Zaten SUCCESS ise sağlayıcı BİR DAHA ÇAĞRILMAZ, kayıtlı sonuç döner
 *   (gerçek idempotency — yalnızca DB satırı tekilliği değil).
 * - DEAD_LETTER/FAILED (kalıcı) ise CONFLICT ile reddedilir.
 * - PENDING/RETRYING ise (yarım kalmış/yeniden denenebilir) yeniden denenir.
 */
export async function executeOutboundOperation(actor: SessionUser, input: ExecuteOutboundOperationInput) {
  if (!canManageIntegrations(actor.role)) throw forbidden();
  if (!input.operationType.trim() || !input.idempotencyKey.trim()) {
    throw new ServiceError("İşlem türü ve idempotency anahtarı zorunludur", "VALIDATION");
  }

  const connection = await findOwnedConnection(actor, input.connectionId);
  const operation = await getOrCreateOutboundOperation(actor, connection, input);

  if (operation.status === "SUCCESS") {
    return { operation, alreadyCompleted: true as const };
  }
  if (operation.status === "DEAD_LETTER" || operation.status === "FAILED") {
    throw conflict("Bu işlem kalıcı olarak başarısız oldu — yeniden denenemez");
  }

  const secretValue = await decryptCredentialForInternalUse(actor, connection.id);
  const ctx = buildContext(connection, actor);

  try {
    const adapter = resolveProviderAdapter(connection.provider);
    if (!adapter.capabilities.includes("OUTBOUND_OPERATION")) {
      throw new ProviderError("Sağlayıcı giden işlem gönderimini desteklemiyor", "VALIDATION");
    }
    const result = await adapter.executeOutboundOperation(
      { operationType: input.operationType, idempotencyKey: input.idempotencyKey, payloadSummary: input.payloadSummary },
      { secretValue },
      ctx,
    );

    const updated = await db.$transaction(async (tx) => {
      const saved = await tx.integrationOutboundOperation.update({
        where: { id: operation.id },
        data: {
          status: "SUCCESS",
          attempts: { increment: 1 },
          errorCategory: null,
          errorCode: null,
          errorSummary: null,
          resultSummary: result.resultSummary ? JSON.stringify(result.resultSummary).slice(0, 2000) : null,
        },
      });
      await logIntegrationEvent(tx, {
        organizationId: actor.organizationId,
        connectionId: connection.id,
        actorId: actor.id,
        eventType: `outbound.${input.operationType}.success`,
        direction: "OUTBOUND",
        status: "SUCCESS",
      });
      return saved;
    });
    return { operation: updated, alreadyCompleted: false as const };
  } catch (err) {
    const classified = classifyProviderError(err, secretValue);
    const nextAttempts = operation.attempts + 1;
    const nextStatus: IntegrationOutboundOperationStatus = isRetryableErrorCategory(classified.category)
      ? nextAttempts >= MAX_OUTBOUND_ATTEMPTS
        ? "DEAD_LETTER"
        : "RETRYING"
      : "FAILED";

    const updated = await db.$transaction(async (tx) => {
      const saved = await tx.integrationOutboundOperation.update({
        where: { id: operation.id },
        data: {
          status: nextStatus,
          attempts: nextAttempts,
          errorCategory: classified.category,
          errorCode: classified.providerCode ?? null,
          errorSummary: classified.safeMessage,
        },
      });
      await logIntegrationEvent(tx, {
        organizationId: actor.organizationId,
        connectionId: connection.id,
        actorId: actor.id,
        eventType: `outbound.${input.operationType}.failure`,
        direction: "OUTBOUND",
        status: "FAILURE",
        errorCode: classified.category,
        errorSummary: classified.safeMessage,
      });
      return saved;
    });
    return { operation: updated, alreadyCompleted: false as const };
  }
}
