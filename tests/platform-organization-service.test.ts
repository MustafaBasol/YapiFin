import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { cleanDatabase, createOrgUser, createOwnerOrg, createTestPlan, setOrganizationPlan } from "./helpers";
import { ServiceError } from "@/server/services/errors";
import {
  PLATFORM_BILLING_HEALTH_CATEGORIES,
  getPlatformOrganizationDetail,
  listPlatformOrganizations,
  type PlatformBillingHealthCategory,
} from "@/server/services/platform/platform-organization-service";

/**
 * YF-818 — `listPlatformOrganizations`/`getPlatformOrganizationDetail`
 * (server/services/platform/platform-organization-service.ts). Bu servis
 * KASITLI OLARAK çapraz-tenant (cross-tenant) çalışır — normal tenant-scope'lu
 * servislerin (SessionUser/requireRole kullanan, cross-tenant erişimi
 * NOT_FOUND'a çeviren) AKSİNE, burada BİRDEN FAZLA organizasyonun verisini
 * TEK çağrıda görmek beklenen/istenen davranıştır (Platform Admin panelinin
 * VAR OLMA nedeni). Bu dosya bu ayrımı BOZMAZ; yalnızca platform-yüzeyinin
 * kendisini test eder.
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

async function seedDispute(organizationId: string, riskState: "FLAGGED" | "RESTRICTED" | "CLEARED" = "RESTRICTED") {
  return db.stripeDispute.create({
    data: {
      organizationId,
      environment: "TEST",
      stripeDisputeId: uniqueId("dp"),
      stripeChargeId: uniqueId("ch"),
      status: riskState === "RESTRICTED" ? "LOST" : "NEEDS_RESPONSE",
      riskState,
      amount: 5000,
      currency: "try",
    },
  });
}

describe("YF-818 — listPlatformOrganizations: çapraz-tenant kapsam", () => {
  it("parametresiz çağrı BİRDEN FAZLA farklı tenant'ın organizasyonunu TEK çağrıda döner", async () => {
    const orgA = await createOwnerOrg();
    const orgB = await createOwnerOrg();

    const result = await listPlatformOrganizations();
    const ids = result.items.map((i) => i.id);
    expect(ids).toContain(orgA.organizationId);
    expect(ids).toContain(orgB.organizationId);
  });
});

describe("YF-818 — listPlatformOrganizations: sayfalama (pagination)", () => {
  it("total doğru hesaplanır ve page/pageSize dilimlemesi mükerrer/boşluk OLMADAN doğru alt kümeyi döner", async () => {
    const total = 25;
    for (let i = 0; i < total; i += 1) {
      await createOwnerOrg({ organizationName: `Sayfalama Org ${String(i).padStart(3, "0")}` });
    }

    const page1 = await listPlatformOrganizations({ page: 1, pageSize: 10, sortBy: "name", sortDir: "asc" });
    const page2 = await listPlatformOrganizations({ page: 2, pageSize: 10, sortBy: "name", sortDir: "asc" });
    const page3 = await listPlatformOrganizations({ page: 3, pageSize: 10, sortBy: "name", sortDir: "asc" });

    expect(page1.total).toBe(total);
    expect(page2.total).toBe(total);
    expect(page3.total).toBe(total);
    expect(page1.items).toHaveLength(10);
    expect(page2.items).toHaveLength(10);
    expect(page3.items).toHaveLength(5); // 25 - 10 - 10.

    const allIds = [...page1.items, ...page2.items, ...page3.items].map((i) => i.id);
    expect(new Set(allIds).size).toBe(total); // Mükerrer YOK.

    const allNames = [...page1.items, ...page2.items, ...page3.items].map((i) => i.name);
    const sortedNames = [...allNames].sort((a, b) => a.localeCompare(b));
    expect(allNames).toEqual(sortedNames); // Sayfalar arası sıra TUTARLI (boşluk/çakışma YOK).
  });
});

describe("YF-818 — listPlatformOrganizations: arama (search)", () => {
  it("name VE tradeName'e göre, BÜYÜK/küçük harf DUYARSIZ eşleşir; eşleşmeyenler HARİÇ tutulur", async () => {
    const nameMatch = await createOwnerOrg({ organizationName: "Zeta Yapı Sanayi A.Ş." });
    const tradeNameMatch = await createOwnerOrg({ organizationName: "Orijinal Unvan Ltd." });
    await db.organization.update({
      where: { id: tradeNameMatch.organizationId },
      data: { tradeName: "Nova Ticari Marka" },
    });
    const noMatch = await createOwnerOrg({ organizationName: "Beta İnşaat Ltd." });

    const byName = await listPlatformOrganizations({ search: "zeta" });
    expect(byName.items.map((i) => i.id)).toEqual([nameMatch.organizationId]);

    const byNameUpper = await listPlatformOrganizations({ search: "ZETA" });
    expect(byNameUpper.items.map((i) => i.id)).toEqual([nameMatch.organizationId]);

    const byTradeName = await listPlatformOrganizations({ search: "nova" });
    expect(byTradeName.items.map((i) => i.id)).toEqual([tradeNameMatch.organizationId]);

    const excluded = await listPlatformOrganizations({ search: "zeta" });
    expect(excluded.items.map((i) => i.id)).not.toContain(noMatch.organizationId);
  });
});

describe("YF-818 — listPlatformOrganizations: planCode filtresi", () => {
  it("yalnızca belirtilen plandaki organizasyonları döner", async () => {
    const starterOrg = await createOwnerOrg();
    await setOrganizationPlan(starterOrg.organizationId, "STARTER");

    const professionalOrg = await createOwnerOrg();
    await setOrganizationPlan(professionalOrg.organizationId, "PROFESSIONAL");

    const result = await listPlatformOrganizations({ planCode: "STARTER" });
    const ids = result.items.map((i) => i.id);
    expect(ids).toContain(starterOrg.organizationId);
    expect(ids).not.toContain(professionalOrg.organizationId);
    expect(result.items.every((i) => i.planCode === "STARTER")).toBe(true);
  });
});

describe("YF-818 — listPlatformOrganizations: subscriptionStatus filtresi", () => {
  it("yalnızca belirtilen ham Stripe durumundaki organizasyonları döner", async () => {
    const activeOrg = await createOwnerOrg();
    await seedSubscription(activeOrg.organizationId, { status: "ACTIVE" });

    const trialingOrg = await createOwnerOrg();
    await seedSubscription(trialingOrg.organizationId, { status: "TRIALING" });

    const result = await listPlatformOrganizations({ subscriptionStatus: "ACTIVE" });
    const ids = result.items.map((i) => i.id);
    expect(ids).toContain(activeOrg.organizationId);
    expect(ids).not.toContain(trialingOrg.organizationId);
    expect(result.items.every((i) => i.subscriptionStatus === "ACTIVE")).toBe(true);
  });
});

describe("YF-818 — listPlatformOrganizations: billingHealth filtresi (TÜM kategoriler)", () => {
  it("her kategori TAM OLARAK beklenen organizasyon(lar)ı döner; dispute-kısıtlı organizasyon DİĞER TÜM kategorilerden HARİÇ tutulur", async () => {
    const now = new Date();
    const future = new Date(now.getTime() + 5 * 24 * 60 * 60 * 1000);
    const past = new Date(now.getTime() - 5 * 24 * 60 * 60 * 1000);
    const morePast = new Date(now.getTime() - 10 * 24 * 60 * 60 * 1000);

    const orgNone = await createOwnerOrg(); // Hiç abonelik satırı YOK.

    const orgHealthy = await createOwnerOrg();
    await seedSubscription(orgHealthy.organizationId, { status: "ACTIVE" });

    const orgTrialing = await createOwnerOrg();
    await seedSubscription(orgTrialing.organizationId, { status: "TRIALING" });

    const orgGrace = await createOwnerOrg();
    await seedSubscription(orgGrace.organizationId, {
      status: "PAST_DUE",
      delinquentSince: now,
      gracePeriodEndsAt: future,
    });

    const orgRestrictedDunning = await createOwnerOrg();
    await seedSubscription(orgRestrictedDunning.organizationId, {
      status: "PAST_DUE",
      delinquentSince: morePast,
      gracePeriodEndsAt: past,
    });

    const orgScheduled = await createOwnerOrg();
    await seedSubscription(orgScheduled.organizationId, { status: "ACTIVE", cancelAtPeriodEnd: true });

    const orgCanceled = await createOwnerOrg();
    await seedSubscription(orgCanceled.organizationId, { status: "CANCELED" });

    // Abonelik alanları TEK BAŞINA HEALTHY üretecek şekilde kurulur (orgHealthy İLE AYNI),
    // ama bir RESTRICTED dispute EZER — diğer TÜM kategorilerden HARİÇ tutulmalıdır.
    const orgDispute = await createOwnerOrg();
    await seedSubscription(orgDispute.organizationId, { status: "ACTIVE" });
    await seedDispute(orgDispute.organizationId, "RESTRICTED");

    const expectedByCategory: Record<PlatformBillingHealthCategory, string[]> = {
      NONE: [orgNone.organizationId],
      HEALTHY: [orgHealthy.organizationId],
      TRIALING: [orgTrialing.organizationId],
      GRACE_PERIOD: [orgGrace.organizationId],
      RESTRICTED: [orgRestrictedDunning.organizationId, orgDispute.organizationId],
      SCHEDULED_CANCELLATION: [orgScheduled.organizationId],
      CANCELED: [orgCanceled.organizationId],
    };

    for (const category of PLATFORM_BILLING_HEALTH_CATEGORIES) {
      const result = await listPlatformOrganizations({ billingHealth: category });
      const ids = result.items.map((i) => i.id).sort();
      expect(ids).toEqual([...expectedByCategory[category]].sort());
      // classifyBillingHealth'ın kendi hesapladığı kategori de eşleşmeli.
      expect(result.items.every((i) => i.billingHealth === category)).toBe(true);

      if (category !== "RESTRICTED") {
        expect(ids).not.toContain(orgDispute.organizationId); // Dispute HER ZAMAN diğer kategorileri EZER/HARİÇ tutar.
      }
    }
  });
});

describe("YF-818 — listPlatformOrganizations: billingHealth filtresi çakışan durumlarda AYRIŞMAZ", () => {
  it("TRIALING + cancelAtPeriodEnd BİRLİKTE ayarlıysa yalnızca SCHEDULED_CANCELLATION filtresinde görünür, TRIALING filtresinde GÖRÜNMEZ", async () => {
    // Adversarial inceleme bulgusu: classifyBillingHealth cancelAtPeriodEnd'i
    // TRIALING'DEN ÖNCE kontrol eder — filtre ile rozet AYRIŞIRSA (ör. filtre
    // TRIALING'i status'a bakarak, cancelAtPeriodEnd'i GÖZ ARDI ederek seçerse)
    // bu org iki filtrede BİRDEN görünür, operatör hangi durumda olduğunu
    // YANLIŞ anlar.
    const now = new Date();
    const future = new Date(now.getTime() + 5 * 24 * 60 * 60 * 1000);

    const orgTrialingScheduled = await createOwnerOrg();
    await seedSubscription(orgTrialingScheduled.organizationId, { status: "TRIALING", cancelAtPeriodEnd: true });

    const orgGraceScheduled = await createOwnerOrg();
    await seedSubscription(orgGraceScheduled.organizationId, {
      status: "PAST_DUE",
      cancelAtPeriodEnd: true,
      delinquentSince: now,
      gracePeriodEndsAt: future,
    });

    const [trialing, scheduled, grace] = await Promise.all([
      listPlatformOrganizations({ billingHealth: "TRIALING" }),
      listPlatformOrganizations({ billingHealth: "SCHEDULED_CANCELLATION" }),
      listPlatformOrganizations({ billingHealth: "GRACE_PERIOD" }),
    ]);

    // classifyBillingHealth önceliği: cancelAtPeriodEnd, TRIALING'den önce kontrol
    // edilir — bu yüzden orgTrialingScheduled SCHEDULED_CANCELLATION'a düşer.
    expect(trialing.items.map((i) => i.id)).not.toContain(orgTrialingScheduled.organizationId);
    expect(scheduled.items.map((i) => i.id)).toContain(orgTrialingScheduled.organizationId);

    // classifyBillingHealth önceliği: GRACE_PERIOD, cancelAtPeriodEnd'den önce
    // kontrol edilir — bu yüzden orgGraceScheduled GRACE_PERIOD'da kalır,
    // SCHEDULED_CANCELLATION'a DÜŞMEZ.
    expect(grace.items.map((i) => i.id)).toContain(orgGraceScheduled.organizationId);
    expect(scheduled.items.map((i) => i.id)).not.toContain(orgGraceScheduled.organizationId);

    // Rozet (billingHealth alanı) filtreyle HER ZAMAN aynı fikirde olmalı.
    const trialingScheduledItem = scheduled.items.find((i) => i.id === orgTrialingScheduled.organizationId);
    expect(trialingScheduledItem?.billingHealth).toBe("SCHEDULED_CANCELLATION");
    const graceScheduledItem = grace.items.find((i) => i.id === orgGraceScheduled.organizationId);
    expect(graceScheduledItem?.billingHealth).toBe("GRACE_PERIOD");
  });
});

describe("YF-818 — listPlatformOrganizations: sıralama (sortBy)", () => {
  it("sortBy: name ARTAN/AZALAN doğru sıralar", async () => {
    const orgA = await createOwnerOrg({ organizationName: "AAA Sıralama Test" });
    const orgM = await createOwnerOrg({ organizationName: "MMM Sıralama Test" });
    const orgZ = await createOwnerOrg({ organizationName: "ZZZ Sıralama Test" });

    const asc = await listPlatformOrganizations({ sortBy: "name", sortDir: "asc" });
    expect(asc.items.map((i) => i.id)).toEqual([orgA.organizationId, orgM.organizationId, orgZ.organizationId]);

    const desc = await listPlatformOrganizations({ sortBy: "name", sortDir: "desc" });
    expect(desc.items.map((i) => i.id)).toEqual([orgZ.organizationId, orgM.organizationId, orgA.organizationId]);
  });

  it("sortBy: userCount farklı kullanıcı sayılarına göre doğru sıralar", async () => {
    const orgFew = await createOwnerOrg(); // 1 kullanıcı (yalnızca owner).
    const orgMid = await createOwnerOrg();
    await createOrgUser(orgMid.organizationId, "ADMIN");
    await createOrgUser(orgMid.organizationId, "FINANCE"); // 3 kullanıcı.
    const orgMany = await createOwnerOrg();
    await createOrgUser(orgMany.organizationId, "ADMIN");
    await createOrgUser(orgMany.organizationId, "FINANCE");
    await createOrgUser(orgMany.organizationId, "PROJECT_MANAGER");
    await createOrgUser(orgMany.organizationId, "PROJECT_MANAGER"); // 5 kullanıcı.

    const asc = await listPlatformOrganizations({ sortBy: "userCount", sortDir: "asc" });
    expect(asc.items.map((i) => i.id)).toEqual([orgFew.organizationId, orgMid.organizationId, orgMany.organizationId]);
    expect(asc.items.map((i) => i.userCount)).toEqual([1, 3, 5]);

    const desc = await listPlatformOrganizations({ sortBy: "userCount", sortDir: "desc" });
    expect(desc.items.map((i) => i.id)).toEqual([orgMany.organizationId, orgMid.organizationId, orgFew.organizationId]);
  });
});

describe("YF-818 — listPlatformOrganizations: N+1 sağlaması (hafif)", () => {
  it("tek sayfada 5+ organizasyon için ownerName/billingHealth/userCount doğru döner (satır-başı sorgu YOK)", async () => {
    const orgs: Awaited<ReturnType<typeof createOwnerOrg>>[] = [];
    for (let i = 0; i < 5; i += 1) {
      const org = await createOwnerOrg({ organizationName: `N+1 Org ${i}` });
      if (i % 2 === 0) await seedSubscription(org.organizationId, { status: "ACTIVE" });
      for (let u = 0; u < i; u += 1) await createOrgUser(org.organizationId, "ADMIN");
      orgs.push(org);
    }

    const result = await listPlatformOrganizations({ search: "N+1 Org" });
    expect(result.items).toHaveLength(5);
    for (let i = 0; i < 5; i += 1) {
      const item = result.items.find((it) => it.id === orgs[i]!.organizationId)!;
      expect(item).toBeDefined();
      expect(item.userCount).toBe(1 + i); // owner + i ek kullanıcı.
      expect(item.ownerName).toBe(`${orgs[i]!.owner.firstName} ${orgs[i]!.owner.lastName}`);
      expect(item.billingHealth).toBe(i % 2 === 0 ? "HEALTHY" : "NONE");
    }
  });
});

describe("YF-818 — getPlatformOrganizationDetail", () => {
  it("owner/users/projects/usage/billingHealthCategory doğru döner ve BAŞKA organizasyonun verisi SIZMAZ", async () => {
    const org1 = await createOwnerOrg({ organizationName: "Detay Test Org" });
    const admin1 = await createOrgUser(org1.organizationId, "ADMIN");
    await db.project.create({ data: { organizationId: org1.organizationId, code: "PRJ-DET-1", name: "Proje A" } });
    await db.project.create({ data: { organizationId: org1.organizationId, code: "PRJ-DET-2", name: "Proje B" } });
    await seedSubscription(org1.organizationId, { status: "ACTIVE" });

    const plan = await createTestPlan({
      limits: { "users.active": 5, "projects.active": 10, "ai.monthly_quota": 100, "ocr.monthly_quota": 20 },
    });
    await db.organization.update({ where: { id: org1.organizationId }, data: { planId: plan.id } });

    // İkinci, TAMAMEN AYRI bir organizasyon — hiçbir verisi org1'in detayına SIZMAMALI.
    const org2 = await createOwnerOrg({ organizationName: "Sızıntı Kontrolü Org" });
    await createOrgUser(org2.organizationId, "ADMIN");
    await db.project.create({ data: { organizationId: org2.organizationId, code: "PRJ-LEAK-1", name: "Sızmamalı Proje" } });

    const detail = await getPlatformOrganizationDetail(org1.organizationId);

    expect(detail.id).toBe(org1.organizationId);
    expect(detail.owner).not.toBeNull();
    expect(detail.owner!.id).toBe(org1.owner.id);
    expect(detail.owner!.email).toBe(org1.owner.email);

    expect(detail.userCount).toBe(2); // owner + admin1.
    expect(detail.users.map((u) => u.id).sort()).toEqual([org1.owner.id, admin1.id].sort());
    expect(detail.users.some((u) => u.email === org2.owner.email)).toBe(false); // org2 SIZMADI.

    expect(detail.projectCount).toBe(2);
    expect(detail.projects.map((p) => p.code).sort()).toEqual(["PRJ-DET-1", "PRJ-DET-2"]);
    expect(detail.projects.some((p) => p.code === "PRJ-LEAK-1")).toBe(false); // org2 SIZMADI.

    expect(detail.usage.users.max).toBe(5);
    expect(detail.usage.projects.max).toBe(10);
    expect(detail.usage.ai.max).toBe(100);
    expect(detail.usage.ocr.max).toBe(20);

    expect(detail.billingHealthCategory).toBe("HEALTHY");
    expect(detail.subscriptionStatus).toBe("ACTIVE");
  });

  it("bilinmeyen/rastgele bir id için ServiceError (NOT_FOUND) fırlatır", async () => {
    await expect(getPlatformOrganizationDetail("nonexistent-organization-id-xyz")).rejects.toBeInstanceOf(ServiceError);
    try {
      await getPlatformOrganizationDetail("nonexistent-organization-id-xyz");
      throw new Error("beklenen hata fırlatılmadı");
    } catch (err) {
      expect(err).toBeInstanceOf(ServiceError);
      expect((err as ServiceError).code).toBe("NOT_FOUND");
    }
  });

  describe("hassas veri sızıntısı KORUMASI", () => {
    it("JSON-serileştirilmiş detay: ham passwordHash, ham (maskelenmemiş) Stripe müşteri kimliği veya beforeJson/afterJson içeriği İÇERMEZ", async () => {
      const org = await createOwnerOrg({ organizationName: "Hassas Veri Test Org" });

      const secretPasswordMarker = "SECRET_PASSWORD_HASH_MARKER_9911";
      await db.user.create({
        data: {
          organizationId: org.organizationId,
          firstName: "Gizli",
          lastName: "Kullanıcı",
          email: `secret-${Date.now()}@example.com`,
          passwordHash: secretPasswordMarker,
          role: "FINANCE",
          status: "ACTIVE",
        },
      });

      const rawStripeCustomerId = "cus_RAWSECRETID1234567890";
      await db.organizationStripeCustomer.create({
        data: {
          organizationId: org.organizationId,
          environment: "TEST",
          stripeCustomerId: rawStripeCustomerId,
          idempotencyKey: uniqueId("idem"),
        },
      });

      const secretAuditMarker = "13371337";
      await db.auditLog.create({
        data: {
          organizationId: org.organizationId,
          actorId: org.owner.id,
          action: "billing.test.sensitive",
          entityType: "TestEntity",
          entityId: "test-entity-1",
          beforeJson: { amount: secretAuditMarker },
          afterJson: { amount: "0" },
        },
      });

      const detail = await getPlatformOrganizationDetail(org.organizationId);
      const serialized = JSON.stringify(detail);

      expect(serialized).not.toContain(secretPasswordMarker);
      expect(serialized).not.toContain(rawStripeCustomerId);
      expect(serialized).not.toContain(secretAuditMarker);

      expect(detail.stripeCustomerIdMasked).not.toBeNull();
      expect(detail.stripeCustomerIdMasked).not.toBe(rawStripeCustomerId);

      expect(detail.recentAuditEntries.length).toBeGreaterThan(0);
      for (const entry of detail.recentAuditEntries) {
        expect(entry).not.toHaveProperty("beforeJson");
        expect(entry).not.toHaveProperty("afterJson");
      }
    });
  });
});
