import { db } from "@/lib/db";
import { computePaymentFailureState, type PaymentFailureState } from "@/lib/billing/dunning-policy";
import { hasActiveDisputeRestriction } from "@/lib/billing/dispute-policy";
import type { SessionUser } from "@/lib/auth/session";
import type { StripeSubscriptionStatus } from "@prisma/client";

/**
 * YF-814 — görev talimatı madde 8: OWNER/yetkili faturalama kullanıcıları
 * için tenant-scoped, salt-okunur bir faturalama sağlığı özeti. Yalnızca
 * ZATEN var olan kaynaklardan (bkz. `OrganizationStripeSubscription` +
 * `lib/billing/dunning-policy.ts` + `lib/billing/dispute-policy.ts`) OKUR —
 * hiçbir yeni erişim KARARI üretmez (bkz.
 * `lib/billing/billing-restriction-policy.ts` TEK karar kaynağıdır, bu
 * fonksiyon yalnızca UI için AYNI kararı GÖZLEMLENEBİLİR biçimde yansıtır).
 * `organizationId` HER ZAMAN `actor`dan türetilir — istemciden ASLA alınmaz
 * (görev talimatı madde 11).
 */
export interface OrganizationBillingHealth {
  readonly subscriptionStatus: StripeSubscriptionStatus | null;
  readonly paymentFailureState: PaymentFailureState;
  readonly delinquentSince: Date | null;
  readonly gracePeriodEndsAt: Date | null;
  readonly recoveredAt: Date | null;
  readonly cancelAtPeriodEnd: boolean;
  readonly currentPeriodEnd: Date | null;
  readonly disputeRestricted: boolean;
}

export async function getOrganizationBillingHealth(actor: SessionUser): Promise<OrganizationBillingHealth> {
  const [subscription, disputeRestricted] = await Promise.all([
    db.organizationStripeSubscription.findUnique({ where: { organizationId: actor.organizationId } }),
    hasActiveDisputeRestriction(db, actor.organizationId),
  ]);

  const paymentFailureState = computePaymentFailureState(
    {
      delinquentSince: subscription?.delinquentSince ?? null,
      gracePeriodEndsAt: subscription?.gracePeriodEndsAt ?? null,
    },
    new Date(),
  );

  return {
    subscriptionStatus: subscription?.status ?? null,
    paymentFailureState,
    delinquentSince: subscription?.delinquentSince ?? null,
    gracePeriodEndsAt: subscription?.gracePeriodEndsAt ?? null,
    recoveredAt: subscription?.recoveredAt ?? null,
    cancelAtPeriodEnd: subscription?.cancelAtPeriodEnd ?? false,
    currentPeriodEnd: subscription?.currentPeriodEnd ?? null,
    disputeRestricted,
  };
}
