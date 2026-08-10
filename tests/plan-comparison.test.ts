import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { cleanDatabase, createOrgUser, createOwnerOrg, createTestPlan, setOrganizationPlan } from "./helpers";
import { getPlanComparison } from "@/server/services/plan-comparison-service";
import { createProject } from "@/server/services/project-service";
import { ServiceError } from "@/server/services/errors";
import { CAPABILITY_IDS, LIMIT_IDS } from "@/lib/entitlements/capabilities";

/**
 * YF-805 — Plan karşılaştırma servisinin (getPlanComparison) davranış
 * testleri. Bu, tüm önceki entitlement testleriyle (bkz. tests/entitlements.test.ts)
 * aynı DB-backed vitest kalıbını kullanır — repo'da React/RTL altyapısı
 * OLMADIĞI için (vitest.config.ts: environment "node") bileşen render testi
 * yerine, arayüzü besleyen bu servis fonksiyonunun doğru/güvenli veri
 * ürettiği doğrulanır (bkz. tests/plan-presentation.test.ts — saf sunum
 * yardımcıları için ayrı testler).
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
function key() {
  seq += 1;
  return `plan-cmp-${seq}-${Date.now()}`;
}

async function seedProject(actor: Awaited<ReturnType<typeof createOwnerOrg>>["owner"]) {
  return createProject(actor, { code: key(), name: `Karşılaştırma Proje ${key()}`, contractAmount: 0, estimatedBudget: 0 });
}

describe("plan karşılaştırma servisi — kanonik plan listesi", () => {
  it("dört kanonik planı da (Starter/Professional/Business/Enterprise) doğru sırada ve doğru Türkçe isimlerle döner", async () => {
    const { owner, organizationId } = await createOwnerOrg();
    await setOrganizationPlan(organizationId, "PROFESSIONAL");

    const result = await getPlanComparison(owner);

    expect(result.plans.map((p) => p.code)).toEqual(["STARTER", "PROFESSIONAL", "BUSINESS", "ENTERPRISE"]);
    expect(result.plans.map((p) => p.name)).toEqual(["Başlangıç", "Profesyonel", "İşletme", "Kurumsal"]);
  });

  it("mevcut plan bayrağı (isCurrent) yalnızca organizasyonun GERÇEK planında true'dur", async () => {
    const { owner, organizationId } = await createOwnerOrg();
    await setOrganizationPlan(organizationId, "BUSINESS");

    const result = await getPlanComparison(owner);

    expect(result.currentPlanCode).toBe("BUSINESS");
    const currentFlags = result.plans.map((p) => ({ code: p.code, isCurrent: p.isCurrent }));
    expect(currentFlags).toEqual([
      { code: "STARTER", isCurrent: false },
      { code: "PROFESSIONAL", isCurrent: false },
      { code: "BUSINESS", isCurrent: true },
      { code: "ENTERPRISE", isCurrent: false },
    ]);
  });

  it("limit/yetenek değerleri DOĞRUDAN DB'deki Plan satırından gelir — ikinci bir matris İCAT EDİLMEZ", async () => {
    const { owner, organizationId } = await createOwnerOrg();
    await setOrganizationPlan(organizationId, "PROFESSIONAL");

    const result = await getPlanComparison(owner);
    const professional = result.plans.find((p) => p.code === "PROFESSIONAL")!;

    const dbRow = await db.plan.findUniqueOrThrow({ where: { code: "PROFESSIONAL" } });
    const dbLimits = dbRow.limits as Record<string, number | null>;
    const dbCapabilities = dbRow.capabilities as Record<string, boolean>;

    for (const limitId of LIMIT_IDS) {
      expect(professional.limits[limitId].max).toBe(dbLimits[limitId] ?? 0);
    }
    for (const capabilityId of CAPABILITY_IDS) {
      expect(professional.capabilities[capabilityId]).toBe(dbCapabilities[capabilityId] === true);
    }
  });

  it("Enterprise sınırları DB'de null (sınırsız) ise max=null olarak döner, uydurulmuş bir sayı DEĞİL", async () => {
    const { owner, organizationId } = await createOwnerOrg();
    await setOrganizationPlan(organizationId, "PROFESSIONAL");

    const result = await getPlanComparison(owner);
    const enterprise = result.plans.find((p) => p.code === "ENTERPRISE")!;

    expect(enterprise.limits["users.active"].max).toBeNull();
    expect(enterprise.limits["projects.active"].max).toBeNull();
    expect(enterprise.limits["ai.monthly_quota"].max).toBeNull();
    expect(enterprise.limits["ocr.monthly_quota"].max).toBeNull();
  });

  it("YF-817 — ocr.monthly_quota LIMIT_IDS'e eklendikten sonra ikinci bir matris İCAT EDİLMEDEN otomatik olarak surface olur (Starter=0, Professional/Business kota, Business>Professional)", async () => {
    const { owner, organizationId } = await createOwnerOrg();
    await setOrganizationPlan(organizationId, "PROFESSIONAL");

    const result = await getPlanComparison(owner);
    const starter = result.plans.find((p) => p.code === "STARTER")!;
    const professional = result.plans.find((p) => p.code === "PROFESSIONAL")!;
    const business = result.plans.find((p) => p.code === "BUSINESS")!;

    expect(starter.limits["ocr.monthly_quota"].max).toBe(0);
    expect(professional.limits["ocr.monthly_quota"].max).toBeGreaterThan(0);
    expect(business.limits["ocr.monthly_quota"].max as number).toBeGreaterThan(
      professional.limits["ocr.monthly_quota"].max as number,
    );
    // currentUsage da (getOrganizationLimitSummary üzerinden) generic LIMIT_IDS döngüsüyle otomatik gelir.
    expect(result.currentUsage["ocr.monthly_quota"]).toBeDefined();
    expect(result.currentUsage["ocr.monthly_quota"].used).toBe(0);
  });

  it("hiçbir planda fiyat alanı yoktur — priceMonthlyTl her zaman null'dur, ASLA bir sayı uydurulmaz", async () => {
    const { owner, organizationId } = await createOwnerOrg();
    await setOrganizationPlan(organizationId, "STARTER");

    const result = await getPlanComparison(owner);

    for (const plan of result.plans) {
      expect(plan.priceMonthlyTl).toBeNull();
    }
  });

  it("Starter'da OCR ve AI özellikleri kapalı, Professional'da açık olarak DB'den gelir", async () => {
    const { owner, organizationId } = await createOwnerOrg();
    await setOrganizationPlan(organizationId, "STARTER");

    const result = await getPlanComparison(owner);
    const starter = result.plans.find((p) => p.code === "STARTER")!;
    const professional = result.plans.find((p) => p.code === "PROFESSIONAL")!;

    expect(starter.capabilities.ocr).toBe(false);
    expect(starter.capabilities["ai.features"]).toBe(false);
    expect(professional.capabilities.ocr).toBe(true);
    expect(professional.capabilities["ai.features"]).toBe(true);
  });
});

describe("plan karşılaştırma servisi — güncel kullanım (currentUsage)", () => {
  it("kullanım sayıları GERÇEK DB kayıt sayılarını yansıtır (fabrikasyon yok)", async () => {
    const { owner, organizationId } = await createOwnerOrg();
    await setOrganizationPlan(organizationId, "PROFESSIONAL");

    await seedProject(owner);
    await seedProject(owner);

    const result = await getPlanComparison(owner);
    const realProjectCount = await db.project.count({ where: { organizationId, status: { not: "CANCELLED" } } });
    const realUserCount = await db.user.count({ where: { organizationId, status: "ACTIVE" } });

    expect(result.currentUsage["projects.active"].used).toBe(realProjectCount);
    expect(result.currentUsage["users.active"].used).toBe(realUserCount);
  });

  it("kullanım limitin altındaysa (< %80) uyarı durumu NORMAL'dir", async () => {
    const { owner, organizationId } = await createOwnerOrg();
    const plan = await createTestPlan({ limits: { "projects.active": 5 }, capabilities: {} });
    await db.organization.update({ where: { id: organizationId }, data: { planId: plan.id } });

    await seedProject(owner); // 1/5 = %20

    const result = await getPlanComparison(owner);
    expect(result.currentUsage["projects.active"]).toMatchObject({ used: 1, max: 5, warningState: "NORMAL" });
  });

  it("kullanım >= %80 ise uyarı durumu WARNING'dir (ai-usage-service.ts ile aynı eşik)", async () => {
    const { owner, organizationId } = await createOwnerOrg();
    const plan = await createTestPlan({ limits: { "projects.active": 5 }, capabilities: {} });
    await db.organization.update({ where: { id: organizationId }, data: { planId: plan.id } });

    await seedProject(owner);
    await seedProject(owner);
    await seedProject(owner);
    await seedProject(owner); // 4/5 = %80

    const result = await getPlanComparison(owner);
    expect(result.currentUsage["projects.active"]).toMatchObject({ used: 4, max: 5, warningState: "WARNING" });
  });

  it("kullanım limite ulaştıysa/aştıysa uyarı durumu EXHAUSTED'dir", async () => {
    const { owner, organizationId } = await createOwnerOrg();
    const plan = await createTestPlan({ limits: { "projects.active": 2 }, capabilities: {} });
    await db.organization.update({ where: { id: organizationId }, data: { planId: plan.id } });

    await seedProject(owner);
    await seedProject(owner); // 2/2 = %100

    const result = await getPlanComparison(owner);
    expect(result.currentUsage["projects.active"]).toMatchObject({ used: 2, max: 2, isOverLimit: false, warningState: "EXHAUSTED" });
  });

  it("sınırsız (max=null) limitlerde uyarı durumu her zaman NORMAL'dir", async () => {
    const { owner, organizationId } = await createOwnerOrg();
    await setOrganizationPlan(organizationId, "ENTERPRISE");

    const result = await getPlanComparison(owner);
    expect(result.currentUsage["projects.active"].max).toBeNull();
    expect(result.currentUsage["projects.active"].warningState).toBe("NORMAL");
  });
});

describe("plan karşılaştırma servisi — tenant izolasyonu ve yetki", () => {
  it("org A'nın kullanım/plan verisi org B'nin sonucuna ASLA sızmaz", async () => {
    const orgA = await createOwnerOrg();
    const orgB = await createOwnerOrg();
    await setOrganizationPlan(orgA.organizationId, "BUSINESS");
    await setOrganizationPlan(orgB.organizationId, "STARTER");

    await seedProject(orgA.owner);
    await seedProject(orgA.owner);
    await seedProject(orgA.owner);

    const resultA = await getPlanComparison(orgA.owner);
    const resultB = await getPlanComparison(orgB.owner);

    expect(resultA.currentPlanCode).toBe("BUSINESS");
    expect(resultB.currentPlanCode).toBe("STARTER");
    expect(resultA.currentUsage["projects.active"].used).toBe(3);
    // Org B kendi projesi olmadığı için org A'nın 3 projesini GÖRMEZ.
    expect(resultB.currentUsage["projects.active"].used).toBe(0);
  });

  it("fonksiyon yalnızca çağıranın KENDİ organizationId'sini kullanır — dışarıdan org kimliği KABUL EDİLMEZ", async () => {
    // getPlanComparison(actor: SessionUser) imzası tek argüman alır; çağıran
    // hiçbir şekilde başka bir organizationId sağlayamaz (bkz.
    // server/services/plan-comparison-service.ts) — bu, cross-tenant erişimi
    // API/servis SEVİYESİNDE yapısal olarak imkânsız kılar.
    expect(getPlanComparison.length).toBe(1);
  });

  it("OWNER/ADMIN dışındaki roller (ör. FINANCE) FORBIDDEN ile reddedilir", async () => {
    const { organizationId } = await createOwnerOrg();
    await setOrganizationPlan(organizationId, "PROFESSIONAL");
    const financeUser = await createOrgUser(organizationId, "FINANCE");

    await expect(getPlanComparison(financeUser)).rejects.toBeInstanceOf(ServiceError);
    await expect(getPlanComparison(financeUser)).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("ADMIN rolü plan karşılaştırmasını görebilir", async () => {
    const { organizationId } = await createOwnerOrg();
    await setOrganizationPlan(organizationId, "PROFESSIONAL");
    const adminUser = await createOrgUser(organizationId, "ADMIN");

    const result = await getPlanComparison(adminUser);
    expect(result.currentPlanCode).toBe("PROFESSIONAL");
  });
});
