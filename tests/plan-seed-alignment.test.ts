import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { cleanDatabase, createOwnerOrg, setOrganizationPlan } from "./helpers";
import { DEFAULT_PLANS, DEFAULT_ORGANIZATION_PLAN_CODE } from "@/lib/entitlements/plan-defaults";
import { checkCapability, checkLimit, getEffectivePlan } from "@/lib/entitlements/entitlement-service";
import { requestAiCompletion } from "@/server/services/ai-usage-reporting-service";
import { createFakeAiProvider } from "@/lib/ai/providers/fake-provider";

/**
 * YF-801-A — bu dosya, çalışma zamanı Plan tohum verisinin
 * docs/PLAN_FEATURE_MATRIX.md kanonik karar matrisiyle hizalandığını
 * doğrular (prisma/migrations/20260809130000_yf801a_plan_seed_alignment).
 * Var olan davranış (fail-closed, tenant izolasyonu, eşzamanlılık,
 * downgrade/upgrade semantiği) zaten tests/entitlements.test.ts ve
 * tests/ai-usage-quota.test.ts içinde kapsanıyor — bu dosya yalnızca
 * SEED DEĞERLERİNİN kendisini ve BUSINESS'ın gerçek bir runtime plan
 * olarak çözümlenebilirliğini hedefler.
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

const EXPECTED_CODES = ["STARTER", "PROFESSIONAL", "BUSINESS", "ENTERPRISE"] as const;

// Migration'daki INSERT'lerle birebir aynı sabit id'ler — Organization.planId
// foreign key ilişkisinin (Organization_planId_fkey) migration sonrasında da
// AYNI Plan satırını göstermeye devam ettiğini, yani mevcut organizasyon->plan
// bağlarının migration ile "kaymadığını" doğrulamak için kullanılır.
const STABLE_PLAN_IDS: Record<(typeof EXPECTED_CODES)[number], string> = {
  STARTER: "plan_starter_default",
  PROFESSIONAL: "plan_professional_default",
  BUSINESS: "plan_business_default",
  ENTERPRISE: "plan_enterprise_default",
};

describe("YF-801-A — plan tohum verisi kanonik matrisle hizalı", () => {
  it("DEFAULT_PLANS dizisi tam olarak dört kanonik kodu içerir", () => {
    expect(DEFAULT_PLANS.map((p) => p.code).sort()).toEqual([...EXPECTED_CODES].sort());
  });

  it("DEFAULT_ORGANIZATION_PLAN_CODE bu görevle DEĞİŞMEDEN PROFESSIONAL kalır", () => {
    expect(DEFAULT_ORGANIZATION_PLAN_CODE).toBe("PROFESSIONAL");
  });

  it("dört plan da DB'de aktif olarak mevcuttur ve id'leri migration öncesiyle AYNIDIR (FK kaymaz)", async () => {
    const rows = await db.plan.findMany({ where: { code: { in: [...EXPECTED_CODES] } } });
    expect(rows).toHaveLength(4);
    for (const row of rows) {
      expect(row.isActive).toBe(true);
      expect(row.id).toBe(STABLE_PLAN_IDS[row.code as (typeof EXPECTED_CODES)[number]]);
    }
  });

  it("STARTER limitleri matrisle hizalı: users.active=3, projects.active=5, ai.monthly_quota=0, ocr.monthly_quota=0", async () => {
    const { organizationId } = await createOwnerOrg();
    await setOrganizationPlan(organizationId, "STARTER");

    expect(await checkLimit(db, organizationId, "users.active")).toMatchObject({ max: 3 });
    expect(await checkLimit(db, organizationId, "projects.active")).toMatchObject({ max: 5 });
    expect(await checkLimit(db, organizationId, "ai.monthly_quota")).toMatchObject({ max: 0 });
    expect(await checkCapability(db, organizationId, "ai.features")).toMatchObject({ allowed: false });
    // YF-817 — Starter'da OCR capability zaten kapalı; kota da savunma amaçlı 0.
    expect(await checkLimit(db, organizationId, "ocr.monthly_quota")).toMatchObject({ max: 0 });
    expect(await checkCapability(db, organizationId, "ocr")).toMatchObject({ allowed: false });
  });

  it("PROFESSIONAL limit/yetenekleri matrisle hizalı: users.active=10, ai.features dahil, ai.monthly_quota>0, ocr.monthly_quota>0, e_document dahil değil", async () => {
    const { organizationId } = await createOwnerOrg();
    await setOrganizationPlan(organizationId, "PROFESSIONAL");

    expect(await checkLimit(db, organizationId, "users.active")).toMatchObject({ max: 10 });
    expect(await checkLimit(db, organizationId, "projects.active")).toMatchObject({ max: 25 });
    const aiQuota = await checkLimit(db, organizationId, "ai.monthly_quota");
    expect(aiQuota.max).not.toBeNull();
    expect(aiQuota.max as number).toBeGreaterThan(0);

    // YF-817 — ocr capability zaten açıktı; artık ayrıca miktar bazlı bir kotaya da sahip (> 0).
    const ocrQuota = await checkLimit(db, organizationId, "ocr.monthly_quota");
    expect(ocrQuota.max).not.toBeNull();
    expect(ocrQuota.max as number).toBeGreaterThan(0);

    expect(await checkCapability(db, organizationId, "ai.features")).toMatchObject({ allowed: true });
    expect(await checkCapability(db, organizationId, "ocr")).toMatchObject({ allowed: true });
    expect(await checkCapability(db, organizationId, "bank_import")).toMatchObject({ allowed: true });
    // PLAN_FEATURE_MATRIX.md §5 #6 — e_document erişimi Business katmanına ait, Professional'da dahil DEĞİL.
    expect(await checkCapability(db, organizationId, "e_document")).toMatchObject({ allowed: false });
  });

  it("BUSINESS gerçek bir çalışma zamanı planı olarak entitlement servisi üzerinden çözümlenir", async () => {
    const { organizationId } = await createOwnerOrg();
    const plan = await setOrganizationPlan(organizationId, "BUSINESS");
    expect(plan.code).toBe("BUSINESS");

    const effective = await getEffectivePlan(db, organizationId);
    expect(effective.code).toBe("BUSINESS");

    expect(await checkLimit(db, organizationId, "users.active")).toMatchObject({ max: 30 });
    expect(await checkLimit(db, organizationId, "projects.active")).toMatchObject({ max: 100 });
    // Matris kararı: Business kotası Professional'dan yüksek olmalı.
    const businessQuota = await checkLimit(db, organizationId, "ai.monthly_quota");
    const professionalOrg = await createOwnerOrg();
    await setOrganizationPlan(professionalOrg.organizationId, "PROFESSIONAL");
    const professionalQuota = await checkLimit(db, professionalOrg.organizationId, "ai.monthly_quota");
    expect(businessQuota.max as number).toBeGreaterThan(professionalQuota.max as number);

    // YF-817 — aynı kanonik kısıt ocr.monthly_quota için de geçerli.
    const businessOcrQuota = await checkLimit(db, organizationId, "ocr.monthly_quota");
    const professionalOcrQuota = await checkLimit(db, professionalOrg.organizationId, "ocr.monthly_quota");
    expect(businessOcrQuota.max as number).toBeGreaterThan(professionalOcrQuota.max as number);

    // Business'ta Professional'a göre EK olarak dahil olması gereken (§3.3 dışındaki mevcut kimlikler için §3.2'nin devamı) e_document.
    expect(await checkCapability(db, organizationId, "e_document")).toMatchObject({ allowed: true });
    expect(await checkCapability(db, organizationId, "ai.features")).toMatchObject({ allowed: true });
  });

  it("ENTERPRISE sınırsız/configurable semantiği bu görevle DEĞİŞMEDEN korunur (limit=null, tüm mevcut yetenekler dahil)", async () => {
    const { organizationId } = await createOwnerOrg();
    await setOrganizationPlan(organizationId, "ENTERPRISE");

    const limit = await checkLimit(db, organizationId, "users.active");
    expect(limit.max).toBeNull();
    expect(limit.canAddOne).toBe(true);
    expect((await checkLimit(db, organizationId, "ai.monthly_quota")).max).toBeNull();
    expect((await checkLimit(db, organizationId, "ocr.monthly_quota")).max).toBeNull();

    for (const capability of ["reports.advanced", "export.xlsx", "export.pdf", "bank_import", "ocr", "e_document", "ai.features"] as const) {
      expect(await checkCapability(db, organizationId, capability)).toMatchObject({ allowed: true });
    }
  });

  it("bilinmeyen bir plan kodu (hiçbir organizasyon bağlanmamış) yine fail-closed davranır", async () => {
    const { organizationId } = await createOwnerOrg();
    await db.organization.update({ where: { id: organizationId }, data: { planId: null } });

    expect(await checkCapability(db, organizationId, "ai.features")).toMatchObject({ allowed: false });
    expect(await checkLimit(db, organizationId, "ai.monthly_quota")).toMatchObject({ max: 0, canAddOne: false });
    expect(await checkLimit(db, organizationId, "ocr.monthly_quota")).toMatchObject({ max: 0, canAddOne: false });
  });

  it("yeni kayıt olan bir organizasyon varsayılan olarak (hizalanmış) PROFESSIONAL plana bağlanır", async () => {
    const { organizationId } = await createOwnerOrg();
    const effective = await getEffectivePlan(db, organizationId);
    expect(effective.code).toBe(DEFAULT_ORGANIZATION_PLAN_CODE);
    expect(effective.id).toBe(STABLE_PLAN_IDS.PROFESSIONAL);
  });

  it("hizalanmış PROFESSIONAL plan verisiyle AI kota motoru uçtan uca çalışır (gerçek seed, createTestPlan DEĞİL)", async () => {
    const { owner } = await createOwnerOrg();
    // Not: aiEnabledOrg (tests/ai-usage-quota.test.ts) createTestPlan ile özel bir plan kurar;
    // burada bilinçli olarak GERÇEK, migration'la tohumlanan PROFESSIONAL satırı kullanılıyor.
    await setOrganizationPlan(owner.organizationId, "PROFESSIONAL");

    const outcome = await requestAiCompletion(owner, {
      provider: createFakeAiProvider(),
      idempotencyKey: `plan-seed-${Date.now()}`,
      messages: [{ role: "user", content: "merhaba" }],
      promptVersion: "v1",
      maxOutputTokens: 10,
    });

    expect(outcome.status).toBe("completed");
    if (outcome.status !== "completed") throw new Error("unreachable");
    const row = await db.aiUsageLedger.findUniqueOrThrow({ where: { id: outcome.ledgerId } });
    expect(row.status).toBe("COMMITTED");
  });
});
