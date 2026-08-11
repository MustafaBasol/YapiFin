import type { StripeDispute, StripeRefund } from "@prisma/client";
import { db } from "@/lib/db";
import { canManageOrganizationSettings } from "@/lib/permissions";
import { forbidden } from "@/server/services/errors";
import { getStripeConfig } from "@/lib/billing/stripe-config";
import { reconcilePendingOrganizationRefunds } from "@/server/services/billing/refund-service";
import { reconcileOpenOrganizationDisputes } from "@/server/services/billing/dispute-service";
import type { SessionUser } from "@/lib/auth/session";

/**
 * YF-815 — destek/operatör görünürlüğü (görev talimatı madde 9). Salt-okunur
 * — `requireRole(["OWNER","ADMIN"])` çağıran sayfa tarafında zaten
 * uygulanır (bkz. app/(app)/settings/plan/billing-operations/page.tsx,
 * `app/(app)/settings/plan/page.tsx` ile AYNI desen). `organizationId`
 * HER ZAMAN `actor`dan türetilir — istemciden ASLA alınmaz (bkz. görev
 * talimatı madde 11 "Never trust a client-supplied organizationId").
 */
export async function listOrganizationBillingOperations(
  actor: SessionUser,
): Promise<{ readonly refunds: readonly StripeRefund[]; readonly disputes: readonly StripeDispute[] }> {
  const [refunds, disputes] = await Promise.all([
    db.stripeRefund.findMany({
      where: { organizationId: actor.organizationId },
      orderBy: { createdAt: "desc" },
      take: 50,
    }),
    db.stripeDispute.findMany({
      where: { organizationId: actor.organizationId },
      orderBy: { createdAt: "desc" },
      take: 50,
    }),
  ]);
  return { refunds, disputes };
}

export interface ReconcileBillingOperationsResult {
  readonly reconciledRefunds: number;
  readonly reconciledDisputes: number;
}

/**
 * YF-815 — YF-810 `reconcileBillingAction`/YF-813 `reconcileAddonPurchaseAction`
 * ile AYNI OWNER-only mutabakat deseni. Yalnızca ZATEN yerel olarak bilinen
 * (en az bir webhook/mutabakat ile daha önce görülmüş), henüz terminal
 * olmayan satırları kapsar — bkz. refund-service.ts
 * `reconcilePendingOrganizationRefunds` dosya başı notu (yeni bir cron/tam-
 * tarama İCAT EDİLMEZ).
 */
export async function reconcileOrganizationBillingOperations(actor: SessionUser): Promise<ReconcileBillingOperationsResult> {
  if (!canManageOrganizationSettings(actor.role)) {
    throw forbidden("Yalnızca firma sahibi faturalama işlemlerini yeniden senkronize edebilir");
  }
  const { environment } = getStripeConfig();
  const [reconciledRefunds, reconciledDisputes] = await Promise.all([
    reconcilePendingOrganizationRefunds(actor.organizationId, environment),
    reconcileOpenOrganizationDisputes(actor.organizationId, environment),
  ]);
  return { reconciledRefunds, reconciledDisputes };
}
