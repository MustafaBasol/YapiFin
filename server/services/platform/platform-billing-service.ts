import { db } from "@/lib/db";
import type {
  BillingNotificationStatus,
  BillingNotificationType,
  StripeDisputeRiskState,
  StripeDisputeStatus,
  StripeRefundPolicyState,
  StripeRefundStatus,
  StripeWebhookEventStatus,
} from "@prisma/client";

/**
 * YF-820 — Platform Admin faturalama operasyonları: salt-okunur geçmiş/teşhis
 * toplulaştırması. `getPlatformOrganizationDetail`
 * (platform-organization-service.ts, YF-818) ZATEN abonelik anlık görüntüsü +
 * faturalama sağlığı + son 10 genel audit girdisini döner — bu dosya İKİNCİ
 * bir hesaplama YOLU İCAT ETMEZ, yalnızca o görünümü YF-820 kapsamındaki
 * (yaşam döngüsü zaman çizelgesi, webhook teşhisi, iade/uyuşmazlık/bildirim
 * listeleri) EK, sınırlı (bounded) sorgularla TAMAMLAR.
 *
 * ## Veri minimizasyonu
 *
 * Hiçbir ham Stripe webhook gövdesi/imzası/sır YOKTUR (zaten `StripeWebhookEvent`
 * şeması bunları HİÇ SAKLAMAZ, bkz. o modelin başlık yorumu). `AuditLog`
 * satırlarının `beforeJson`/`afterJson` alanları BİLİNÇLİ OLARAK buraya
 * YANSITILMAZ (YF-818 `recentAuditEntries` İLE AYNI ilke — görev talimatı
 * madde 12: proje/faturalama işlem DETAYLARI varsayılan olarak sızdırılmaz,
 * yalnızca eylem/tür/zaman/aktör GÖRÜNÜR).
 *
 * ## Sınırlı (bounded) sorgular
 *
 * Her liste sabit bir `take` ile sınırlıdır — organizasyon başına sınırsız
 * geçmiş TARANMAZ (görev talimatı "avoid unlimited event history / N+1").
 */

const LIFECYCLE_EVENT_LIMIT = 30;
const WEBHOOK_EVENT_LIMIT = 20;
const REFUND_LIMIT = 10;
const DISPUTE_LIMIT = 10;
const NOTIFICATION_LIMIT = 20;

/**
 * `AuditLog.action` üzerinde "bu bir faturalama yaşam döngüsü olayıdır" ayrımı
 * için TEK liste — mevcut `server/services/billing/*.ts` `writeAuditLog`
 * çağrılarından DERLENMİŞTİR (bkz. o dosyaların `action:` değerleri). Yeni bir
 * paralel olay taksonomisi İCAT EDİLMEZ, yalnızca ZATEN yazılan audit
 * kayıtları FİLTRELENİR/GÖSTERİLİR.
 */
const BILLING_LIFECYCLE_ACTIONS = [
  "billing.stripe_customer.create",
  "billing.checkout.create",
  "billing.subscription.entitlement_granted",
  "billing.subscription.entitlement_revoked",
  "billing.invoice.payment_succeeded",
  "billing.invoice.payment_failed",
  "billing.dunning.grace_started",
  "billing.dunning.recovered",
  "billing.refund.observed",
  "billing.refund.status_changed",
  "billing.dispute.opened",
  "billing.dispute.status_changed",
  "billing.notification.sent",
  "billing.notification.failed",
  "billing.portal.session_created",
  "billing.addon_checkout.create",
  "billing.addon.granted",
] as const;

export interface PlatformBillingLifecycleEvent {
  readonly id: string;
  readonly action: string;
  readonly entityType: string;
  readonly createdAt: Date;
  readonly actorName: string | null;
}

export interface PlatformBillingWebhookEvent {
  readonly id: string;
  readonly stripeEventId: string;
  readonly eventType: string;
  readonly status: StripeWebhookEventStatus;
  readonly attempts: number;
  readonly errorSummary: string | null;
  readonly stripeCreatedAt: Date;
  readonly receivedAt: Date;
  readonly processedAt: Date | null;
}

export interface PlatformBillingRefund {
  readonly id: string;
  readonly stripeRefundId: string;
  readonly status: StripeRefundStatus;
  readonly policyState: StripeRefundPolicyState;
  readonly amount: number;
  readonly currency: string;
  readonly reason: string | null;
  readonly createdAt: Date;
}

export interface PlatformBillingDispute {
  readonly id: string;
  readonly stripeDisputeId: string;
  readonly status: StripeDisputeStatus;
  readonly riskState: StripeDisputeRiskState;
  readonly amount: number;
  readonly currency: string;
  readonly reason: string | null;
  readonly createdAt: Date;
}

export interface PlatformBillingNotification {
  readonly id: string;
  readonly type: BillingNotificationType;
  readonly status: BillingNotificationStatus;
  readonly gracePeriodEndsAt: Date | null;
  readonly recipientCount: number | null;
  readonly attemptCount: number;
  readonly lastError: string | null;
  readonly sentAt: Date | null;
  readonly createdAt: Date;
}

export interface PlatformOrganizationBillingOperations {
  readonly lifecycleEvents: readonly PlatformBillingLifecycleEvent[];
  readonly webhookEvents: readonly PlatformBillingWebhookEvent[];
  readonly refunds: readonly PlatformBillingRefund[];
  readonly disputes: readonly PlatformBillingDispute[];
  readonly notifications: readonly PlatformBillingNotification[];
}

/**
 * Bir organizasyonun faturalama operasyonları görünümünü döner — `organizationId`
 * HER ZAMAN çağıran taraftan (yalnızca `requirePlatformAdmin()` ile
 * yetkilendirilmiş bir sayfa/route) gelir, istemciden ASLA alınmaz (görev
 * talimatı madde 11). Beş bağımsız, sınırlı sorgu `Promise.all` ile paralel
 * çalıştırılır — organizasyon başına N+1 YOKTUR (her sorgu TEK organizasyon
 * için TEK, sınırlı `findMany`dir).
 */
export async function getPlatformOrganizationBillingOperations(
  organizationId: string,
): Promise<PlatformOrganizationBillingOperations> {
  const [auditEntries, webhookEvents, refunds, disputes, notifications] = await Promise.all([
    db.auditLog.findMany({
      where: { organizationId, action: { in: [...BILLING_LIFECYCLE_ACTIONS] } },
      orderBy: { createdAt: "desc" },
      take: LIFECYCLE_EVENT_LIMIT,
      select: {
        id: true,
        action: true,
        entityType: true,
        createdAt: true,
        actor: { select: { firstName: true, lastName: true } },
      },
    }),
    db.stripeWebhookEvent.findMany({
      where: { organizationId },
      orderBy: { stripeCreatedAt: "desc" },
      take: WEBHOOK_EVENT_LIMIT,
      select: {
        id: true,
        stripeEventId: true,
        eventType: true,
        status: true,
        attempts: true,
        errorSummary: true,
        stripeCreatedAt: true,
        receivedAt: true,
        processedAt: true,
      },
    }),
    db.stripeRefund.findMany({
      where: { organizationId },
      orderBy: { createdAt: "desc" },
      take: REFUND_LIMIT,
      select: {
        id: true,
        stripeRefundId: true,
        status: true,
        policyState: true,
        amount: true,
        currency: true,
        reason: true,
        createdAt: true,
      },
    }),
    db.stripeDispute.findMany({
      where: { organizationId },
      orderBy: { createdAt: "desc" },
      take: DISPUTE_LIMIT,
      select: {
        id: true,
        stripeDisputeId: true,
        status: true,
        riskState: true,
        amount: true,
        currency: true,
        reason: true,
        createdAt: true,
      },
    }),
    db.billingNotification.findMany({
      where: { organizationId },
      orderBy: { createdAt: "desc" },
      take: NOTIFICATION_LIMIT,
      select: {
        id: true,
        type: true,
        status: true,
        gracePeriodEndsAt: true,
        recipientCount: true,
        attemptCount: true,
        lastError: true,
        sentAt: true,
        createdAt: true,
      },
    }),
  ]);

  return {
    lifecycleEvents: auditEntries.map((e) => ({
      id: e.id,
      action: e.action,
      entityType: e.entityType,
      createdAt: e.createdAt,
      actorName: e.actor ? `${e.actor.firstName} ${e.actor.lastName}` : null,
    })),
    webhookEvents,
    refunds,
    disputes,
    notifications,
  };
}
