import { db } from "@/lib/db";
import { writeAuditLog } from "@/lib/audit";
import { notFound, ServiceError } from "@/server/services/errors";
import {
  reconcileOrganizationStripeSubscriptionById,
  type ReconcileResult,
} from "@/server/services/billing/webhook-service";
import {
  getOrganizationBillingHealthById,
  type OrganizationBillingHealth,
} from "@/server/services/billing/billing-health-service";
import type { PlatformAdminSessionUser } from "@/lib/auth/platform-session";
import type { StripeSubscriptionStatus } from "@prisma/client";

/**
 * YF-820 — Platform Admin-only, hedef organizasyonu SUNUCU tarafında çözen
 * mutabakat (reconciliation) sarmalayıcısı. Görev talimatı gereği ("do not
 * merely expose the OWNER-facing route cross-tenant; create a correctly
 * authorized platform wrapper around the canonical service") YF-810'un
 * OWNER-facing `reconcileOrganizationStripeSubscription`'ı (actor.role/
 * actor.organizationId'ye bağlı) DEĞİL, onun `organizationId`-parametreli
 * çekirdeği `reconcileOrganizationStripeSubscriptionById` (bkz.
 * server/services/billing/webhook-service.ts) ÇAĞRILIR — İKİNCİ bir
 * mutabakat/faturalama motoru İCAT EDİLMEZ, yalnızca yetki sınırı FARKLIDIR.
 *
 * Stripe müşteri/abonelik referansları HER ZAMAN `OrganizationStripeCustomer`/
 * `OrganizationStripeSubscription` eşlemesi üzerinden, SUNUCU tarafında
 * çözülür (bkz. `reconcileOrganizationStripeSubscriptionById` içindeki
 * `db.organizationStripeCustomer.findUnique`) — istemciden HİÇBİR Stripe
 * kimliği ASLA alınmaz/güvenilmez (görev talimatı madde "no client-supplied
 * Stripe IDs trusted").
 *
 * Bu çekirdek zaten `syncSubscriptionFromStripe`'ı kullandığı için DOĞASI
 * GEREĞİ idempotent/yakınsayan (convergent) ve ENTITLEMENT dışında hiçbir
 * proje finans kaydı (`FinancialTransaction`/`Settlement`/…) ÜRETMEZ — bu
 * sarmalayıcı da o davranışa YENİ bir mutasyon YOLU EKLEMEZ, yalnızca
 * öncesi/sonrası anlık görüntüyü + ayrıcalıklı bir audit izini SARAR.
 */

export interface PlatformReconciliationSnapshot {
  readonly found: boolean;
  readonly status: StripeSubscriptionStatus | null;
  readonly planCode: string | null;
  readonly cancelAtPeriodEnd: boolean;
  readonly billingHealth: OrganizationBillingHealth;
}

export interface PlatformReconciliationResult {
  readonly organizationId: string;
  readonly before: PlatformReconciliationSnapshot;
  readonly after: PlatformReconciliationSnapshot;
  readonly changed: boolean;
  readonly lastSyncAt: Date;
  readonly warnings: readonly string[];
}

async function takeSnapshot(organizationId: string): Promise<PlatformReconciliationSnapshot> {
  const [subscription, billingHealth] = await Promise.all([
    db.organizationStripeSubscription.findUnique({
      where: { organizationId },
      select: { status: true, planCode: true, cancelAtPeriodEnd: true },
    }),
    getOrganizationBillingHealthById(organizationId),
  ]);
  return {
    found: subscription !== null,
    status: subscription?.status ?? null,
    planCode: subscription?.planCode ?? null,
    cancelAtPeriodEnd: subscription?.cancelAtPeriodEnd ?? false,
    billingHealth,
  };
}

function snapshotsDiffer(a: PlatformReconciliationSnapshot, b: PlatformReconciliationSnapshot): boolean {
  return (
    a.found !== b.found ||
    a.status !== b.status ||
    a.planCode !== b.planCode ||
    a.cancelAtPeriodEnd !== b.cancelAtPeriodEnd ||
    a.billingHealth.paymentFailureState !== b.billingHealth.paymentFailureState ||
    a.billingHealth.disputeRestricted !== b.billingHealth.disputeRestricted
  );
}

/** Sabit, sır İÇERMEYEN kısa bir özete kırpar — ham istisna mesajı ASLA audit'e yazılmaz (bkz. webhook-service.ts `safeErrorSummary` İLE AYNI disiplin). */
function safeErrorSummary(err: unknown): string {
  if (err instanceof ServiceError) return `${err.code}: ${err.message}`.slice(0, 300);
  if (err instanceof Error) return err.name.slice(0, 300);
  return "UNKNOWN_ERROR";
}

/**
 * `AuditLog.actorId` `User` tablosuna FK'lidir (bkz. lib/audit.ts) —
 * `PlatformAdmin` TAMAMEN AYRI bir kimlik tablosudur (bkz.
 * lib/auth/platform-session.ts dosya başı notu), bu yüzden platform admin
 * kimliği `actorId`'YE ASLA YAZILMAZ (FK ihlali olurdu). YF-819'un eklediği
 * dedike `AuditLog.platformAdminId` FK'si (bkz. prisma/schema.prisma) artık
 * mevcut olduğundan kimlik ORAYA yazılır — `platform-plan-override-service.ts`
 * İLE AYNI kural (bkz. o dosyadaki `writeAuditLog` çağrıları). `afterJson`
 * yalnızca mutabakata özgü alanları taşır, admin kimliğini TEKRARLAMAZ.
 */
async function writePlatformReconciliationAudit(params: {
  organizationId: string;
  admin: PlatformAdminSessionUser;
  reason: string | null;
  outcome: "SUCCEEDED" | "FAILED";
  before?: PlatformReconciliationSnapshot;
  after?: PlatformReconciliationSnapshot;
  changed?: boolean;
  found?: boolean;
  errorSummary?: string;
}): Promise<void> {
  await db.$transaction((tx) =>
    writeAuditLog(tx, {
      organizationId: params.organizationId,
      actorId: null,
      platformAdminId: params.admin.id,
      action:
        params.outcome === "SUCCEEDED"
          ? "platform.billing.reconciliation.succeeded"
          : "platform.billing.reconciliation.failed",
      entityType: "OrganizationStripeSubscription",
      entityId: params.organizationId,
      before: params.before ? { status: params.before.status, planCode: params.before.planCode } : undefined,
      after: {
        reason: params.reason,
        ...(params.after ? { status: params.after.status, planCode: params.after.planCode } : {}),
        ...(params.changed !== undefined ? { changed: params.changed } : {}),
        ...(params.found !== undefined ? { found: params.found } : {}),
        ...(params.errorSummary ? { errorSummary: params.errorSummary } : {}),
      },
    }),
  );
}

/**
 * Platform Admin-only manuel mutabakat. Yetki kontrolü (`requirePlatformAdmin()`)
 * BU fonksiyonun DIŞINDA, çağıran server action'da yapılır (bkz.
 * app/actions/platform-billing.ts) — `admin` parametresi ZATEN doğrulanmış
 * bir oturumu temsil eder, burada YENİDEN doğrulanmaz (YF-818
 * `getPlatformOrganizationDetail` İLE AYNI kabul — sayfa/action katmanı
 * yetkiyi uygular, servis katmanı organizationId'yi işler).
 */
export async function reconcilePlatformOrganizationSubscription(
  admin: PlatformAdminSessionUser,
  organizationId: string,
  reason: string | null = null,
): Promise<PlatformReconciliationResult> {
  const organization = await db.organization.findUnique({ where: { id: organizationId }, select: { id: true } });
  if (!organization) throw notFound("Organizasyon bulunamadı");

  const before = await takeSnapshot(organizationId);

  let outcome: ReconcileResult;
  try {
    outcome = await reconcileOrganizationStripeSubscriptionById(organizationId);
  } catch (err) {
    await writePlatformReconciliationAudit({
      organizationId,
      admin,
      reason,
      outcome: "FAILED",
      before,
      errorSummary: safeErrorSummary(err),
    });
    throw err;
  }

  const after = await takeSnapshot(organizationId);
  const changed = snapshotsDiffer(before, after);
  const warnings: string[] = [];
  if (!outcome.found) {
    warnings.push("Stripe'ta bu organizasyona ait bir abonelik bulunamadı.");
  }

  await writePlatformReconciliationAudit({
    organizationId,
    admin,
    reason,
    outcome: "SUCCEEDED",
    before,
    after,
    changed,
    found: outcome.found,
  });

  return { organizationId, before, after, changed, lastSyncAt: new Date(), warnings };
}
