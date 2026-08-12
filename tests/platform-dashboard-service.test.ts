import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { cleanDatabase, createOrgUser, createOwnerOrg } from "./helpers";
import { getPlatformDashboardMetrics } from "@/server/services/platform/platform-dashboard-service";

/**
 * YF-818 — `getPlatformDashboardMetrics` (server/services/platform/platform-dashboard-service.ts).
 * Yetkilendirme BU fonksiyonun içinde YAPILMAZ (route/guard katmanında uygulanır, bkz.
 * görev talimatı) — bu yüzden burada yalnızca sayıların SEED edilen veriye göre doğru
 * hesaplandığı doğrulanır, erişim kontrolü DEĞİL.
 */

beforeAll(async () => {
  await cleanDatabase();
});

afterEach(async () => {
  await cleanDatabase();
});

afterAll(async () => {
  await db.$disconnect();
});

let seq = 0;
function uniqueId(prefix: string): string {
  seq += 1;
  return `${prefix}_${Date.now()}_${seq}`;
}

async function seedSubscription(
  organizationId: string,
  overrides: {
    status: "ACTIVE" | "TRIALING" | "PAST_DUE" | "CANCELED";
    cancelAtPeriodEnd?: boolean;
    delinquentSince?: Date | null;
    gracePeriodEndsAt?: Date | null;
  },
) {
  return db.organizationStripeSubscription.create({
    data: {
      organizationId,
      environment: "TEST",
      stripeCustomerId: uniqueId("cus"),
      stripeSubscriptionId: uniqueId("sub"),
      stripePriceId: uniqueId("price"),
      status: overrides.status,
      cancelAtPeriodEnd: overrides.cancelAtPeriodEnd ?? false,
      delinquentSince: overrides.delinquentSince ?? null,
      gracePeriodEndsAt: overrides.gracePeriodEndsAt ?? null,
    },
  });
}

describe("YF-818 — getPlatformDashboardMetrics", () => {
  it("bilinen küçük bir organizasyon/abonelik/uyuşmazlık kümesi için TÜM alanları doğru hesaplar", async () => {
    const now = new Date();
    const future = new Date(now.getTime() + 5 * 24 * 60 * 60 * 1000);
    const past = new Date(now.getTime() - 5 * 24 * 60 * 60 * 1000);

    // 2 organizasyon ACTIVE (sağlıklı).
    const org1 = await createOwnerOrg();
    await seedSubscription(org1.organizationId, { status: "ACTIVE" });

    const org2 = await createOwnerOrg();
    await seedSubscription(org2.organizationId, { status: "ACTIVE" });
    // org2'ye ek kullanıcılar (totalUsers'ın owner sayımıyla SINIRLI olmadığını kanıtlamak için).
    await createOrgUser(org2.organizationId, "ADMIN");
    await createOrgUser(org2.organizationId, "FINANCE");
    await createOrgUser(org2.organizationId, "PROJECT_MANAGER");
    await db.project.create({ data: { organizationId: org2.organizationId, code: "PRJ-D-1", name: "Proje 1" } });

    // 1 organizasyon TRIALING.
    const org3 = await createOwnerOrg();
    await seedSubscription(org3.organizationId, { status: "TRIALING" });

    // 1 organizasyon grace period İÇİNDE (dunning başlamış ama süre DOLMAMIŞ).
    const org4 = await createOwnerOrg();
    await seedSubscription(org4.organizationId, {
      status: "PAST_DUE",
      delinquentSince: now,
      gracePeriodEndsAt: future,
    });

    // 1 organizasyon dunning YOLUYLA kısıtlı (grace süresi DOLMUŞ).
    const org5 = await createOwnerOrg();
    await seedSubscription(org5.organizationId, {
      status: "PAST_DUE",
      delinquentSince: past,
      gracePeriodEndsAt: past,
    });

    // 1 organizasyon dispute YOLUYLA kısıtlı (abonelik durumu ACTIVE olsa BİLE).
    const org6 = await createOwnerOrg();
    await seedSubscription(org6.organizationId, { status: "ACTIVE" });
    await db.stripeDispute.create({
      data: {
        organizationId: org6.organizationId,
        environment: "TEST",
        stripeDisputeId: uniqueId("dp"),
        stripeChargeId: uniqueId("ch"),
        status: "LOST",
        riskState: "RESTRICTED",
        amount: 5000,
        currency: "try",
      },
    });

    // 1 organizasyon cancelAtPeriodEnd=true (zamanlanmış iptal).
    const org7 = await createOwnerOrg();
    await seedSubscription(org7.organizationId, { status: "ACTIVE", cancelAtPeriodEnd: true });
    await db.project.create({ data: { organizationId: org7.organizationId, code: "PRJ-D-2", name: "Proje 2" } });
    await db.project.create({ data: { organizationId: org7.organizationId, code: "PRJ-D-3", name: "Proje 3" } });

    // 2 organizasyon HİÇ abonelik satırı OLMADAN (NONE — recentOrganizations kapasitesini/sıralamasını test etmek için).
    const org8 = await createOwnerOrg();
    const org9 = await createOwnerOrg();

    const metrics = await getPlatformDashboardMetrics();

    expect(metrics.totalOrganizations).toBe(9);
    expect(metrics.totalUsers).toBe(9 + 3); // 9 owner + org2'nin 3 ek kullanıcısı.
    expect(metrics.totalProjects).toBe(3); // org2: 1, org7: 2.

    expect(metrics.activeSubscriptions).toBe(4); // org1, org2, org6, org7 (hepsi status=ACTIVE).
    expect(metrics.trialSubscriptions).toBe(1); // org3.
    expect(metrics.gracePeriodOrganizations).toBe(1); // org4.
    expect(metrics.restrictedOrganizations).toBe(2); // org5 (dunning) + org6 (dispute) — birleşim (union), mükerrer YOK.
    expect(metrics.scheduledCancellations).toBe(1); // org7.

    // recentOrganizations: en yeni-önce sıralı, 8 ile SINIRLI (9 organizasyondan en ESKİSİ — org1 — dışarıda kalır).
    expect(metrics.recentOrganizations).toHaveLength(8);
    const recentIds = metrics.recentOrganizations.map((o) => o.id);
    expect(recentIds).toEqual([
      org9.organizationId,
      org8.organizationId,
      org7.organizationId,
      org6.organizationId,
      org5.organizationId,
      org4.organizationId,
      org3.organizationId,
      org2.organizationId,
    ]);
    expect(recentIds).not.toContain(org1.organizationId);

    // Her giriş kendi organizasyonuna ait doğru alanları taşır.
    const org9Entry = metrics.recentOrganizations.find((o) => o.id === org9.organizationId);
    expect(org9Entry).toMatchObject({ name: expect.any(String), tradeName: expect.any(String) });
  });

  it("hiç organizasyon yokken TÜM sayaçlar sıfırdır ve recentOrganizations boş dizidir", async () => {
    const metrics = await getPlatformDashboardMetrics();
    expect(metrics).toMatchObject({
      totalOrganizations: 0,
      totalUsers: 0,
      totalProjects: 0,
      activeSubscriptions: 0,
      trialSubscriptions: 0,
      gracePeriodOrganizations: 0,
      restrictedOrganizations: 0,
      scheduledCancellations: 0,
      recentOrganizations: [],
    });
  });
});
