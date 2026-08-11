import type { StripeEnvironment, StripeDisputeStatus as PrismaDisputeStatus, StripeDisputeRiskState } from "@prisma/client";
import { db } from "@/lib/db";
import { writeAuditLog } from "@/lib/audit";
import { canManageOrganizationSettings } from "@/lib/permissions";
import { forbidden, notFound } from "@/server/services/errors";
import { lockOrganizationForEntitlement } from "@/lib/entitlements/entitlement-service";
import { getStripeConfig } from "@/lib/billing/stripe-config";
import { resolveStripeGateway, type StripeDisputeRef } from "@/lib/billing/stripe-gateway";
import { resolveOrganizationForCustomer } from "@/server/services/billing/customer-resolution";
import type { SessionUser } from "@/lib/auth/session";

/**
 * YF-815 — Stripe uyuşmazlık (dispute/chargeback) senkronizasyonu ve
 * entitlement risk politikası.
 *
 * ## Neden `customerId` DIŞARIDAN gelmiyor (webhook-service.ts'ten farklı)
 *
 * Stripe `Dispute` nesnesi doğrudan bir `customer` alanı TAŞIMAZ (bkz. Stripe
 * API "2026-07-29.dahlia" — yalnızca `charge`/`payment_intent`). Bu yüzden
 * `processStripeWebhookEvent`in DİĞER `kind`leri (SUBSCRIPTION/INVOICE/
 * CHECKOUT_SESSION/REFUND) için geçerli olan "customerId webhook
 * payload'ında ÜCRETSİZ mevcuttur" varsayımı DISPUTE için GEÇERSİZDİR — bu
 * modül kendi tenant çözümlemesini `gateway.retrieveDispute()` (charge
 * genişletilerek TEK istekte customerId çözer, bkz. `StripeDisputeRef`
 * dosya başı notu) SONRASI, KENDİSİ yapar (bkz. `processDisputeWebhookEvent`).
 *
 * ## Refetch-on-write (YF-810/YF-813/YF-815 refund-service.ts ile AYNI ilke)
 *
 * `applyDisputeSnapshot` HER ZAMAN Stripe'tan YENİDEN ÇEKİLEN güncel
 * `StripeDisputeRef` ile `(environment, stripeDisputeId)` üzerinde UPSERT
 * eder — hangi olay tetiklediği ÖNEMLİ DEĞİLDİR.
 *
 * ## Risk politikası (görev talimatı madde 5)
 *
 * `status -> riskState` eşlemesi TEK, merkezi bir çeviridir (bkz.
 * `toRiskState`): açık/inceleme aşamasındaki bir uyuşmazlık YALNIZCA
 * `FLAGGED` olur (tenant verisi/erişimi HENÜZ etkilenmez — "do not
 * immediately destroy tenant data"); YALNIZCA `LOST` (kaybedilmiş
 * uyuşmazlık) `RESTRICTED` olur ve `lib/billing/dispute-policy.ts`
 * `hasActiveDisputeRestriction` ÜZERİNDEN (bkz.
 * `lib/billing/billing-restriction-policy.ts` YF-814 kompozisyonu) merkezi
 * entitlement servisinin (`assertCapability`/`assertWithinLimit*`) yeni ücretli
 * oluşturma/tüketimi ENGELLEMESİNE yol açar; `WON`/`WARNING_CLOSED`/
 * `PREVENTED` risk durumunu TEMİZLER (`CLEARED`). Bu tabloya YAZILAN hiçbir
 * satır tenant verisini (organizasyon/kullanıcı/proje/finansal kayıt/AI-OCR
 * geçmişi) SİLMEZ/MUTASYONA UĞRATMAZ — yalnızca bir POLİTİKA GİRDİSİDİR.
 */

function toDisputeStatus(raw: string): PrismaDisputeStatus {
  switch (raw) {
    case "warning_needs_response":
      return "WARNING_NEEDS_RESPONSE";
    case "warning_under_review":
      return "WARNING_UNDER_REVIEW";
    case "warning_closed":
      return "WARNING_CLOSED";
    case "needs_response":
      return "NEEDS_RESPONSE";
    case "under_review":
      return "UNDER_REVIEW";
    case "won":
      return "WON";
    case "lost":
      return "LOST";
    case "prevented":
      return "PREVENTED";
    default:
      // Stripe'ın gelecekte ekleyebileceği, bu kod tabanının henüz
      // TANIMADIĞI bir durum dizesi — fail-closed: `FLAGGED`e düşer (bkz.
      // `toRiskState`), ASLA sessizce `CLEARED`'a düşmez.
      return "UNKNOWN";
  }
}

const RESTRICTING_STATUSES: readonly PrismaDisputeStatus[] = ["LOST"];
const CLEARING_STATUSES: readonly PrismaDisputeStatus[] = ["WON", "WARNING_CLOSED", "PREVENTED"];

/** `status -> riskState` — TEK, merkezi çeviri (bkz. dosya başı "Risk politikası" notu). */
function toRiskState(status: PrismaDisputeStatus): StripeDisputeRiskState {
  if (RESTRICTING_STATUSES.includes(status)) return "RESTRICTED";
  if (CLEARING_STATUSES.includes(status)) return "CLEARED";
  return "FLAGGED";
}

interface ApplyDisputeParams {
  readonly organizationId: string;
  readonly environment: StripeEnvironment;
  readonly dispute: StripeDisputeRef;
  readonly eventId: string;
  readonly eventCreatedAt: Date;
}

async function applyDisputeSnapshot(params: ApplyDisputeParams): Promise<void> {
  const status = toDisputeStatus(params.dispute.status);
  const riskState = toRiskState(status);

  await db.$transaction(async (tx) => {
    await lockOrganizationForEntitlement(tx, params.organizationId);

    const existing = await tx.stripeDispute.findUnique({
      where: { environment_stripeDisputeId: { environment: params.environment, stripeDisputeId: params.dispute.id } },
    });

    const data = {
      organizationId: params.organizationId,
      environment: params.environment,
      stripeDisputeId: params.dispute.id,
      stripeChargeId: params.dispute.chargeId,
      stripePaymentIntentId: params.dispute.paymentIntentId,
      status,
      riskState,
      amount: params.dispute.amount,
      currency: params.dispute.currency,
      reason: params.dispute.reason,
      lastProcessedEventId: params.eventId,
      lastProcessedEventCreatedAt: params.eventCreatedAt,
    };

    await tx.stripeDispute.upsert({
      where: { environment_stripeDisputeId: { environment: params.environment, stripeDisputeId: params.dispute.id } },
      create: data,
      update: data,
    });

    const isNewRow = !existing;
    const changed = isNewRow || existing.status !== status || existing.riskState !== riskState;
    if (changed) {
      await writeAuditLog(tx, {
        organizationId: params.organizationId,
        actorId: null,
        action: isNewRow ? "billing.dispute.opened" : "billing.dispute.status_changed",
        entityType: "StripeDispute",
        entityId: params.dispute.id,
        before: existing ? { status: existing.status, riskState: existing.riskState } : undefined,
        after: { status, riskState, amount: params.dispute.amount, currency: params.dispute.currency },
      });
    }
  });
}

export interface ProcessDisputeResult {
  readonly outcome: "PROCESSED" | "IGNORED";
  readonly reason?: string;
}

interface ProcessDisputeParams {
  readonly disputeId: string;
  readonly environment: StripeEnvironment;
  readonly eventId: string;
  readonly eventCreatedAt: Date;
}

/**
 * YF-810 webhook boru hattından (`processStripeWebhookEvent`, DISPUTE kind)
 * çağrılır. Diğer `kind`lerin aksine kendi tenant çözümlemesini YAPAR (bkz.
 * dosya başı notu).
 */
export async function processDisputeWebhookEvent(params: ProcessDisputeParams): Promise<ProcessDisputeResult> {
  const gateway = resolveStripeGateway();
  const dispute = await gateway.retrieveDispute(params.disputeId);
  if (!dispute) return { outcome: "IGNORED", reason: "DISPUTE_NOT_FOUND" };
  if (!dispute.customerId) return { outcome: "IGNORED", reason: "CUSTOMER_UNRESOLVABLE" };

  const organizationId = await resolveOrganizationForCustomer(dispute.customerId, params.environment);
  if (!organizationId) return { outcome: "IGNORED", reason: "UNKNOWN_CUSTOMER" };

  await applyDisputeSnapshot({
    organizationId,
    environment: params.environment,
    dispute,
    eventId: params.eventId,
    eventCreatedAt: params.eventCreatedAt,
  });
  return { outcome: "PROCESSED" };
}

export interface ReconcileDisputeResult {
  readonly found: boolean;
  readonly status: PrismaDisputeStatus | null;
  readonly riskState: StripeDisputeRiskState | null;
}

/**
 * YF-815 — dahili/manuel mutabakat girişi (`reconcileRefund` ile AYNI
 * desen). `applyDisputeSnapshot`'ı kullandığı için DOĞASI GEREĞİ
 * idempotenttir.
 */
export async function reconcileDispute(actor: SessionUser, stripeDisputeId: string): Promise<ReconcileDisputeResult> {
  if (!canManageOrganizationSettings(actor.role)) {
    throw forbidden("Yalnızca firma sahibi faturalama işlemlerini yeniden senkronize edebilir");
  }
  if (!stripeDisputeId) throw notFound("Uyuşmazlık bulunamadı");

  const { environment } = getStripeConfig();
  const organizationId = actor.organizationId;

  const mapping = await db.organizationStripeCustomer.findUnique({
    where: { organizationId_environment: { organizationId, environment } },
    select: { stripeCustomerId: true },
  });
  if (!mapping) throw notFound("Bu organizasyon için henüz bir Stripe müşteri kaydı yok");

  const gateway = resolveStripeGateway();
  const dispute = await gateway.retrieveDispute(stripeDisputeId);
  if (!dispute) return { found: false, status: null, riskState: null };

  if (dispute.customerId !== mapping.stripeCustomerId) {
    // Tenant sızıntısı önlenir — bkz. refund-service.ts `reconcileRefund` ile AYNI ilke.
    return { found: false, status: null, riskState: null };
  }

  await applyDisputeSnapshot({
    organizationId,
    environment,
    dispute,
    eventId: `reconcile:${organizationId}:${stripeDisputeId}`,
    eventCreatedAt: new Date(),
  });

  const updated = await db.stripeDispute.findUnique({
    where: { environment_stripeDisputeId: { environment, stripeDisputeId } },
  });
  return { found: true, status: updated?.status ?? null, riskState: updated?.riskState ?? null };
}

/**
 * YF-815 — bir organizasyonun YEREL olarak bilinen ama HENÜZ terminal
 * olmayan (`WON`/`LOST`/`WARNING_CLOSED`/`PREVENTED` DIŞINDAKİ) uyuşmazlık
 * kayıtlarını Stripe'ın GÜNCEL gerçeğiyle yeniden hizalar — bkz.
 * refund-service.ts `reconcilePendingOrganizationRefunds` ile AYNI kapsam
 * sınırı (yeni bir cron/tam-tarama İCAT EDİLMEZ).
 */
export async function reconcileOpenOrganizationDisputes(organizationId: string, environment: StripeEnvironment): Promise<number> {
  const open = await db.stripeDispute.findMany({
    where: {
      organizationId,
      environment,
      status: { notIn: ["WON", "LOST", "WARNING_CLOSED", "PREVENTED"] },
    },
    select: { stripeDisputeId: true },
  });

  const gateway = resolveStripeGateway();
  let reconciledCount = 0;
  for (const row of open) {
    const dispute = await gateway.retrieveDispute(row.stripeDisputeId);
    if (!dispute) continue;
    await applyDisputeSnapshot({
      organizationId,
      environment,
      dispute,
      eventId: `reconcile-sweep:${organizationId}:${row.stripeDisputeId}`,
      eventCreatedAt: new Date(),
    });
    reconciledCount += 1;
  }
  return reconciledCount;
}
