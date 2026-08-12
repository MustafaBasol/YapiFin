import { db } from "@/lib/db";

/**
 * YF-818 — Platform Admin gösterge paneli için sınırlı (bounded) toplama
 * sorguları. Görev talimatı madde 13 — "Platform listing must avoid... no
 * live Stripe API call per table row" ilkesiyle AYNI gerekçeyle, buradaki
 * TÜM sorgular organizasyon SAYISINDAN bağımsız sabit sayıda sorgudur
 * (count/groupBy/bounded findMany) — hiçbir organizasyon başına ayrı sorgu
 * YOKTUR. Dunning/kısıtlama durumu `lib/billing/dunning-policy.ts` +
 * `lib/billing/dispute-policy.ts` (YF-814/YF-815) ile AYNI TEK karar
 * kaynağından türetilir — ikinci bir hesaplama İCAT EDİLMEZ.
 */
export interface PlatformDashboardMetrics {
  totalOrganizations: number;
  totalUsers: number;
  totalProjects: number;
  activeSubscriptions: number;
  trialSubscriptions: number;
  gracePeriodOrganizations: number;
  restrictedOrganizations: number;
  scheduledCancellations: number;
  recentOrganizations: Array<{
    id: string;
    name: string;
    tradeName: string | null;
    createdAt: Date;
    planCode: string | null;
  }>;
}

export async function getPlatformDashboardMetrics(): Promise<PlatformDashboardMetrics> {
  const now = new Date();

  const [
    totalOrganizations,
    totalUsers,
    totalProjects,
    subscriptionStatusGroups,
    graceOrgs,
    restrictedDunningOrgs,
    scheduledCancellations,
    disputeRestrictedOrgs,
    recentOrganizations,
  ] = await Promise.all([
    db.organization.count(),
    db.user.count(),
    db.project.count(),
    db.organizationStripeSubscription.groupBy({ by: ["status"], _count: { _all: true } }),
    db.organizationStripeSubscription.findMany({
      where: { delinquentSince: { not: null }, gracePeriodEndsAt: { gt: now } },
      select: { organizationId: true },
    }),
    db.organizationStripeSubscription.findMany({
      where: { delinquentSince: { not: null }, gracePeriodEndsAt: { lte: now } },
      select: { organizationId: true },
    }),
    db.organizationStripeSubscription.count({ where: { cancelAtPeriodEnd: true } }),
    db.stripeDispute.findMany({
      where: { riskState: "RESTRICTED" },
      select: { organizationId: true },
      distinct: ["organizationId"],
    }),
    db.organization.findMany({
      orderBy: { createdAt: "desc" },
      take: 8,
      select: { id: true, name: true, tradeName: true, createdAt: true, plan: { select: { code: true } } },
    }),
  ]);

  const activeSubscriptions = subscriptionStatusGroups.find((g) => g.status === "ACTIVE")?._count._all ?? 0;
  const trialSubscriptions = subscriptionStatusGroups.find((g) => g.status === "TRIALING")?._count._all ?? 0;

  const restrictedOrgIds = new Set<string>([
    ...restrictedDunningOrgs.map((r) => r.organizationId),
    ...disputeRestrictedOrgs.map((r) => r.organizationId),
  ]);

  return {
    totalOrganizations,
    totalUsers,
    totalProjects,
    activeSubscriptions,
    trialSubscriptions,
    gracePeriodOrganizations: graceOrgs.length,
    restrictedOrganizations: restrictedOrgIds.size,
    scheduledCancellations,
    recentOrganizations: recentOrganizations.map((org) => ({
      id: org.id,
      name: org.name,
      tradeName: org.tradeName,
      createdAt: org.createdAt,
      planCode: org.plan?.code ?? null,
    })),
  };
}
