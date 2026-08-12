import type { Prisma, StripeSubscriptionStatus, BillingInterval, UserRole, UserStatus, ProjectStatus } from "@prisma/client";
import { db } from "@/lib/db";
import { notFound } from "@/server/services/errors";
import { computePaymentFailureState, type PaymentFailureState } from "@/lib/billing/dunning-policy";
import { getOrganizationBillingHealthById } from "@/server/services/billing/billing-health-service";
import {
  checkCapability,
  getOrganizationLimitSummary,
  type LimitCheckResult,
} from "@/lib/entitlements/entitlement-service";
import {
  reconcileExpiredPlatformPlanOverride,
  getActivePlatformPlanOverride,
  classifyPlanBillingSource,
  type PlatformPlanOverrideSummary,
} from "@/server/services/platform/platform-plan-override-service";

/**
 * YF-818 — Platform Admin organizasyon listeleme/detay servisi.
 *
 * Görev talimatı madde 13 ("Organization listing must avoid: per-row user
 * query / per-row project query / per-row Stripe query / per-row quota
 * query") gereği `listPlatformOrganizations` SAYFA BAŞINA sabit sayıda
 * (organizasyon sayısından/sayfa boyutundan bağımsız) sorgu çalıştırır:
 * sayfalanmış organizasyon sorgusu (kullanıcı/proje sayıları `_count` ile
 * TEK sorguda), ardından o sayfadaki organizationId'lere karşı TOPLU
 * (bounded `IN (...)`) abonelik/uyuşmazlık/sahip/son-giriş sorguları — asla
 * organizasyon başına ayrı bir sorgu YOKTUR. AI/OCR kota özeti (canlı
 * hesaplama gerektirir) BİLİNÇLİ OLARAK listede GÖSTERİLMEZ, yalnızca detay
 * sayfasında (tek organizasyon) hesaplanır — bkz. dosya sonu "bilinen
 * eksik" notu.
 *
 * Faturalama durumu HER ZAMAN `lib/billing/dunning-policy.ts` +
 * `lib/billing/dispute-policy.ts` (YF-814/YF-815) TEK karar kaynağından
 * türetilir — ikinci bir hesaplama İCAT EDİLMEZ.
 */

export const PLATFORM_BILLING_HEALTH_CATEGORIES = [
  "NONE",
  "TRIALING",
  "HEALTHY",
  "GRACE_PERIOD",
  "RESTRICTED",
  "SCHEDULED_CANCELLATION",
  "CANCELED",
] as const;
export type PlatformBillingHealthCategory = (typeof PLATFORM_BILLING_HEALTH_CATEGORIES)[number];

export function isPlatformBillingHealthCategory(value: string): value is PlatformBillingHealthCategory {
  return (PLATFORM_BILLING_HEALTH_CATEGORIES as readonly string[]).includes(value);
}

interface SubscriptionSnapshot {
  status: StripeSubscriptionStatus;
  delinquentSince: Date | null;
  gracePeriodEndsAt: Date | null;
  cancelAtPeriodEnd: boolean;
}

/** `OrganizationBillingHealth`in (billing-health-service.ts) UI-dostu tek-kategori özeti — bkz. görev talimatı madde 10 durum listesi. */
export function classifyBillingHealth(
  subscription: SubscriptionSnapshot | null,
  disputeRestricted: boolean,
  now: Date,
): PlatformBillingHealthCategory {
  if (!subscription) return "NONE";
  const paymentFailureState = computePaymentFailureState(
    { delinquentSince: subscription.delinquentSince, gracePeriodEndsAt: subscription.gracePeriodEndsAt },
    now,
  );
  if (disputeRestricted || paymentFailureState === "RESTRICTED") return "RESTRICTED";
  if (paymentFailureState === "GRACE_PERIOD") return "GRACE_PERIOD";
  if (subscription.status === "CANCELED") return "CANCELED";
  if (subscription.cancelAtPeriodEnd) return "SCHEDULED_CANCELLATION";
  if (subscription.status === "TRIALING") return "TRIALING";
  return "HEALTHY";
}

function maskStripeCustomerId(id: string): string {
  if (id.length <= 8) return "••••";
  return `${id.slice(0, 8)}…${id.slice(-4)}`;
}

/**
 * YF-818 adversarial inceleme bulgusu: bu fonksiyon önceden `classifyBillingHealth`den
 * BAĞIMSIZ, kategori başına ayrı bir `WHERE` koşulu seti tutuyordu — bu da iki
 * uygulamanın (satır bazlı rozet vs. toplu filtre) ÖRTÜŞMEYEN durumlarda (ör.
 * `status: "TRIALING"` + `cancelAtPeriodEnd: true`, ya da açık bir dunning
 * bölümüyle çakışan `TRIALING`/`SCHEDULED_CANCELLATION`) FARKLI sonuç
 * üretmesine yol açabiliyordu. Artık İKİNCİ bir kategorizasyon YOLU İCAT
 * EDİLMİYOR — her abonelik satırı, rozetin kullandığı AYNI `classifyBillingHealth`
 * ile sınıflandırılır; filtre ile rozet YAPISAL OLARAK asla ayrışamaz.
 */
async function resolveOrgIdsForBillingHealth(category: PlatformBillingHealthCategory, now: Date): Promise<Set<string>> {
  const [allOrgs, allSubs, disputeRows] = await Promise.all([
    category === "NONE" ? db.organization.findMany({ select: { id: true } }) : Promise.resolve(null),
    db.organizationStripeSubscription.findMany({
      select: { organizationId: true, status: true, delinquentSince: true, gracePeriodEndsAt: true, cancelAtPeriodEnd: true },
    }),
    db.stripeDispute.findMany({
      where: { riskState: "RESTRICTED" },
      select: { organizationId: true },
      distinct: ["organizationId"],
    }),
  ]);
  const disputeRestrictedIds = new Set(disputeRows.map((r) => r.organizationId));

  if (category === "NONE") {
    const subOrgIds = new Set(allSubs.map((s) => s.organizationId));
    return new Set((allOrgs ?? []).map((o) => o.id).filter((id) => !subOrgIds.has(id)));
  }

  const matches = allSubs.filter(
    (sub) => classifyBillingHealth(sub, disputeRestrictedIds.has(sub.organizationId), now) === category,
  );
  return new Set(matches.map((s) => s.organizationId));
}

export interface PlatformOrganizationListItem {
  id: string;
  name: string;
  tradeName: string | null;
  createdAt: Date;
  ownerName: string | null;
  ownerEmail: string | null;
  userCount: number;
  projectCount: number;
  planCode: string | null;
  planName: string | null;
  subscriptionStatus: StripeSubscriptionStatus | null;
  billingHealth: PlatformBillingHealthCategory;
  cancelAtPeriodEnd: boolean;
  currentPeriodEnd: Date | null;
  trialEnd: Date | null;
  /** Organizasyonun kullanıcılarından en son giriş zamanı — "son aktivite" için mevcut altyapıdan (User.lastLoginAt) türetilen güvenilir bir vekil (bkz. görev talimatı "if existing architecture supports it reliably"). */
  lastLoginAt: Date | null;
}

export type PlatformOrganizationSortField = "name" | "createdAt" | "userCount" | "projectCount";

export interface PlatformOrganizationListParams {
  page?: number;
  pageSize?: number;
  search?: string;
  planCode?: string;
  subscriptionStatus?: StripeSubscriptionStatus;
  billingHealth?: PlatformBillingHealthCategory;
  sortBy?: PlatformOrganizationSortField;
  sortDir?: "asc" | "desc";
}

export interface PlatformOrganizationListResult {
  items: PlatformOrganizationListItem[];
  total: number;
  page: number;
  pageSize: number;
}

function buildOrderBy(
  sortBy: PlatformOrganizationSortField | undefined,
  sortDir: "asc" | "desc" | undefined,
): Prisma.OrganizationOrderByWithRelationInput {
  const dir = sortDir ?? (sortBy === "name" ? "asc" : "desc");
  switch (sortBy) {
    case "name":
      return { name: dir };
    case "userCount":
      return { users: { _count: dir } };
    case "projectCount":
      return { projects: { _count: dir } };
    case "createdAt":
    default:
      return { createdAt: dir };
  }
}

export async function listPlatformOrganizations(
  params: PlatformOrganizationListParams = {},
): Promise<PlatformOrganizationListResult> {
  const page = Math.max(1, Math.floor(params.page ?? 1));
  const pageSize = Math.min(100, Math.max(1, Math.floor(params.pageSize ?? 20)));
  const now = new Date();

  const where: Prisma.OrganizationWhereInput = {};
  const search = params.search?.trim();
  if (search) {
    where.OR = [
      { name: { contains: search, mode: "insensitive" } },
      { tradeName: { contains: search, mode: "insensitive" } },
    ];
  }
  if (params.planCode) {
    where.plan = { code: params.planCode };
  }

  const idFilters: Set<string>[] = [];
  if (params.subscriptionStatus) {
    const rows = await db.organizationStripeSubscription.findMany({
      where: { status: params.subscriptionStatus },
      select: { organizationId: true },
    });
    idFilters.push(new Set(rows.map((r) => r.organizationId)));
  }
  if (params.billingHealth) {
    idFilters.push(await resolveOrgIdsForBillingHealth(params.billingHealth, now));
  }
  if (idFilters.length > 0) {
    const intersection = idFilters.reduce((acc, set) => new Set([...acc].filter((id) => set.has(id))));
    where.id = { in: [...intersection] };
  }

  const orderBy = buildOrderBy(params.sortBy, params.sortDir);

  const [total, organizations] = await Promise.all([
    db.organization.count({ where }),
    db.organization.findMany({
      where,
      orderBy,
      skip: (page - 1) * pageSize,
      take: pageSize,
      select: {
        id: true,
        name: true,
        tradeName: true,
        createdAt: true,
        plan: { select: { code: true, name: true } },
        _count: { select: { users: true, projects: true } },
      },
    }),
  ]);

  const orgIds = organizations.map((o) => o.id);

  const [subs, disputeRows, owners, lastLoginGroups] = await Promise.all([
    db.organizationStripeSubscription.findMany({ where: { organizationId: { in: orgIds } } }),
    db.stripeDispute.findMany({
      where: { organizationId: { in: orgIds }, riskState: "RESTRICTED" },
      select: { organizationId: true },
      distinct: ["organizationId"],
    }),
    db.user.findMany({
      where: { organizationId: { in: orgIds }, role: "OWNER" },
      select: { organizationId: true, firstName: true, lastName: true, email: true },
    }),
    db.user.groupBy({ by: ["organizationId"], where: { organizationId: { in: orgIds } }, _max: { lastLoginAt: true } }),
  ]);

  const subByOrg = new Map(subs.map((s) => [s.organizationId, s]));
  const disputeRestrictedSet = new Set(disputeRows.map((d) => d.organizationId));
  const ownerByOrg = new Map(owners.map((o) => [o.organizationId, o]));
  const lastLoginByOrg = new Map(lastLoginGroups.map((g) => [g.organizationId, g._max.lastLoginAt]));

  const items: PlatformOrganizationListItem[] = organizations.map((org) => {
    const sub = subByOrg.get(org.id) ?? null;
    const owner = ownerByOrg.get(org.id);
    return {
      id: org.id,
      name: org.name,
      tradeName: org.tradeName,
      createdAt: org.createdAt,
      ownerName: owner ? `${owner.firstName} ${owner.lastName}` : null,
      ownerEmail: owner?.email ?? null,
      userCount: org._count.users,
      projectCount: org._count.projects,
      planCode: org.plan?.code ?? null,
      planName: org.plan?.name ?? null,
      subscriptionStatus: sub?.status ?? null,
      billingHealth: classifyBillingHealth(sub, disputeRestrictedSet.has(org.id), now),
      cancelAtPeriodEnd: sub?.cancelAtPeriodEnd ?? false,
      currentPeriodEnd: sub?.currentPeriodEnd ?? null,
      trialEnd: sub?.trialEnd ?? null,
      lastLoginAt: lastLoginByOrg.get(org.id) ?? null,
    };
  });

  return { items, total, page, pageSize };
}

export interface PlatformOrganizationDetail {
  id: string;
  name: string;
  tradeName: string | null;
  createdAt: Date;
  owner: { id: string; name: string; email: string } | null;
  userCount: number;
  projectCount: number;
  users: Array<{ id: string; name: string; email: string; role: UserRole; status: UserStatus; createdAt: Date }>;
  projects: Array<{ id: string; code: string; name: string; status: ProjectStatus; createdAt: Date }>;
  plan: { code: string; name: string } | null;
  /** Ham Stripe müşteri kimliği ASLA döndürülmez — yalnızca maskelenmiş biçim (görev talimatı madde 9/12). */
  stripeCustomerIdMasked: string | null;
  billingInterval: BillingInterval | null;
  subscriptionStatus: StripeSubscriptionStatus | null;
  billingHealthCategory: PlatformBillingHealthCategory;
  paymentFailureState: PaymentFailureState;
  delinquentSince: Date | null;
  gracePeriodEndsAt: Date | null;
  recoveredAt: Date | null;
  cancelAtPeriodEnd: boolean;
  currentPeriodStart: Date | null;
  currentPeriodEnd: Date | null;
  trialStart: Date | null;
  trialEnd: Date | null;
  disputeRestricted: boolean;
  /** YF-819 — bu organizasyonun Stripe tarafından (aktif/deneme/gecikmiş abonelik) mi yoksa yalnızca dahili/manuel mi yönetildiği. Salt bilgilendirme amaçlıdır, hiçbir entitlement kararını ETKİLEMEZ. */
  planBillingSource: "STRIPE_MANAGED" | "MANUAL";
  /** YF-819 — bu organizasyon için Platform Admin tarafından uygulanmış GÜNCEL aktif geçersiz kılma (varsa). */
  activePlanOverride: PlatformPlanOverrideSummary | null;
  usage: {
    users: LimitCheckResult;
    projects: LimitCheckResult;
    ai: LimitCheckResult;
    ocr: LimitCheckResult;
  };
  aiFeatureEnabled: boolean;
  ocrFeatureEnabled: boolean;
  /** Yalnızca eylem/tür/zaman/aktör — `beforeJson`/`afterJson` KASITLI OLARAK dahil edilmez (görev talimatı madde 12: proje finansal işlem detayları varsayılan olarak sızdırılmaz). */
  recentAuditEntries: Array<{ id: string; action: string; entityType: string; createdAt: Date; actorName: string | null }>;
}

export async function getPlatformOrganizationDetail(organizationId: string): Promise<PlatformOrganizationDetail> {
  // YF-819 — süresi dolmuş bir Platform Admin geçersiz kılması varsa, bu
  // GÖRÜNTÜLEMEDEN ÖNCE tembel/lazy olarak mutabakat sağlanır (bkz.
  // platform-plan-override-service.ts modül başı notu — yeni bir arka
  // plan/cron işi İCAT EDİLMEZ). Aşağıdaki `organization` okuması bu
  // yüzden BUNDAN SONRA yapılır — reconciliation planı değiştirmiş olabilir.
  await reconcileExpiredPlatformPlanOverride(organizationId);

  const organization = await db.organization.findUnique({
    where: { id: organizationId },
    include: { plan: { select: { code: true, name: true } } },
  });
  if (!organization) throw notFound("Organizasyon bulunamadı");

  const now = new Date();

  // Faturalama durumu (dunning + dispute kompozisyonu) `getOrganizationBillingHealthById`
  // (billing-health-service.ts, YF-814/YF-815 TEK karar kaynağı) üzerinden
  // okunur — ikinci bir hesaplama yolu İCAT EDİLMEZ. `subscription` satırı
  // AYRICA çekilir çünkü `OrganizationBillingHealth`in kapsamadığı ek alanlar
  // (billingInterval/currentPeriodStart/trialStart/trialEnd/status/cancelAtPeriodEnd)
  // burada gösterilir.
  const [
    users,
    projects,
    subscription,
    billingHealth,
    stripeCustomer,
    limitSummary,
    aiCapability,
    ocrCapability,
    auditEntries,
    activePlanOverride,
  ] = await Promise.all([
      db.user.findMany({
        where: { organizationId },
        orderBy: { createdAt: "asc" },
        select: { id: true, firstName: true, lastName: true, email: true, role: true, status: true, createdAt: true },
      }),
      db.project.findMany({
        where: { organizationId },
        orderBy: { createdAt: "desc" },
        select: { id: true, code: true, name: true, status: true, createdAt: true },
      }),
      db.organizationStripeSubscription.findUnique({ where: { organizationId } }),
      getOrganizationBillingHealthById(organizationId),
      db.organizationStripeCustomer.findFirst({
        where: { organizationId },
        orderBy: { createdAt: "desc" },
        select: { stripeCustomerId: true },
      }),
      getOrganizationLimitSummary(db, organizationId),
      checkCapability(db, organizationId, "ai.features"),
      checkCapability(db, organizationId, "ocr"),
      db.auditLog.findMany({
        where: { organizationId },
        orderBy: { createdAt: "desc" },
        take: 10,
        select: {
          id: true,
          action: true,
          entityType: true,
          createdAt: true,
          actor: { select: { firstName: true, lastName: true } },
        },
      }),
      getActivePlatformPlanOverride(organizationId),
    ]);

  const owner = users.find((u) => u.role === "OWNER") ?? null;
  const { paymentFailureState, disputeRestricted } = billingHealth;
  const billingHealthCategory = classifyBillingHealth(subscription, disputeRestricted, now);

  return {
    id: organization.id,
    name: organization.name,
    tradeName: organization.tradeName,
    createdAt: organization.createdAt,
    owner: owner ? { id: owner.id, name: `${owner.firstName} ${owner.lastName}`, email: owner.email } : null,
    userCount: users.length,
    projectCount: projects.length,
    users: users.map((u) => ({
      id: u.id,
      name: `${u.firstName} ${u.lastName}`,
      email: u.email,
      role: u.role,
      status: u.status,
      createdAt: u.createdAt,
    })),
    projects: projects.map((p) => ({ id: p.id, code: p.code, name: p.name, status: p.status, createdAt: p.createdAt })),
    plan: organization.plan ? { code: organization.plan.code, name: organization.plan.name } : null,
    stripeCustomerIdMasked: stripeCustomer ? maskStripeCustomerId(stripeCustomer.stripeCustomerId) : null,
    billingInterval: subscription?.billingInterval ?? null,
    subscriptionStatus: subscription?.status ?? null,
    billingHealthCategory,
    paymentFailureState,
    delinquentSince: subscription?.delinquentSince ?? null,
    gracePeriodEndsAt: subscription?.gracePeriodEndsAt ?? null,
    recoveredAt: subscription?.recoveredAt ?? null,
    cancelAtPeriodEnd: subscription?.cancelAtPeriodEnd ?? false,
    currentPeriodStart: subscription?.currentPeriodStart ?? null,
    currentPeriodEnd: subscription?.currentPeriodEnd ?? null,
    trialStart: subscription?.trialStart ?? null,
    trialEnd: subscription?.trialEnd ?? null,
    disputeRestricted,
    planBillingSource: classifyPlanBillingSource(subscription?.status ?? null),
    activePlanOverride,
    usage: {
      users: limitSummary["users.active"],
      projects: limitSummary["projects.active"],
      ai: limitSummary["ai.monthly_quota"],
      ocr: limitSummary["ocr.monthly_quota"],
    },
    aiFeatureEnabled: aiCapability.allowed,
    ocrFeatureEnabled: ocrCapability.allowed,
    recentAuditEntries: auditEntries.map((e) => ({
      id: e.id,
      action: e.action,
      entityType: e.entityType,
      createdAt: e.createdAt,
      actorName: e.actor ? `${e.actor.firstName} ${e.actor.lastName}` : null,
    })),
  };
}
