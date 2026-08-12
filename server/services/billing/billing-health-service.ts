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

async function computeOrganizationBillingHealth(organizationId: string): Promise<OrganizationBillingHealth> {
  const [subscription, disputeRestricted] = await Promise.all([
    db.organizationStripeSubscription.findUnique({ where: { organizationId } }),
    hasActiveDisputeRestriction(db, organizationId),
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

export async function getOrganizationBillingHealth(actor: SessionUser): Promise<OrganizationBillingHealth> {
  return computeOrganizationBillingHealth(actor.organizationId);
}

/**
 * YF-818 — Platform Admin karşılığı: `actor`dan DEĞİL, doğrudan bir
 * `organizationId`den okur. Platform admin tek bir organizasyona ait
 * OLMADIĞI için `actor.organizationId` türetimi burada yapısal olarak
 * MEVCUT DEĞİLDİR — çağıran taraf (`requirePlatformAdmin()` ile
 * yetkilendirilmiş bir route/servis) `organizationId`yi kendi listeleme/
 * detay parametresinden geçirir. Aynı `computeOrganizationBillingHealth`i
 * kullanır — ikinci bir hesaplama YOLU İCAT EDİLMEZ.
 */
export async function getOrganizationBillingHealthById(organizationId: string): Promise<OrganizationBillingHealth> {
  return computeOrganizationBillingHealth(organizationId);
}
