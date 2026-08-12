import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { cleanDatabase, createOwnerOrg, createOrgUser, createPlatformAdmin, createTestPlan, setOrganizationPlan } from "./helpers";
import { getOrganizationLimitSummary } from "@/lib/entitlements/entitlement-service";
import { getPlatformOrganizationDetail } from "@/server/services/platform/platform-organization-service";
import {
  applyPlatformPlanOverride,
  revokePlatformPlanOverride,
  previewPlatformPlanChange,
  getActivePlatformPlanOverride,
  reconcileExpiredPlatformPlanOverride,
  classifyPlanBillingSource,
  NO_PLAN_CODE,
} from "@/server/services/platform/platform-plan-override-service";
import { platformPlanOverrideSchema, platformPlanOverrideRevokeSchema } from "@/lib/validation/platform-plan";

/**
 * YF-819 — Platform Admin plan geçersiz kılma/upgrade/downgrade servisi
 * (server/services/platform/platform-plan-override-service.ts).
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

function meta() {
  return { ipAddress: "127.0.0.1", userAgent: "vitest" };
}

describe("YF-819 — platformPlanOverrideSchema / platformPlanOverrideRevokeSchema (Zod)", () => {
  it("gerekçe 10 karakterden kısaysa reddeder", () => {
    const parsed = platformPlanOverrideSchema.safeParse({
      organizationId: "org_1",
      planCode: "PROFESSIONAL",
      reason: "kısa",
      expectedCurrentPlanCode: "STARTER",
    });
    expect(parsed.success).toBe(false);
  });

  it("kanonik olmayan bir plan kodunu reddeder", () => {
    const parsed = platformPlanOverrideSchema.safeParse({
      organizationId: "org_1",
      planCode: "NOT_A_REAL_PLAN",
      reason: "Destek talebi #12345 üzerine yükseltme",
      expectedCurrentPlanCode: "STARTER",
    });
    expect(parsed.success).toBe(false);
  });

  it("geçmişte bir expiresAt tarihini reddeder", () => {
    const parsed = platformPlanOverrideSchema.safeParse({
      organizationId: "org_1",
      planCode: "PROFESSIONAL",
      reason: "Destek talebi #12345 üzerine yükseltme",
      expectedCurrentPlanCode: "STARTER",
      expiresAt: "2020-01-01T00:00:00.000Z",
    });
    expect(parsed.success).toBe(false);
  });

  it("geçerli girdiyi kabul eder", () => {
    const parsed = platformPlanOverrideSchema.safeParse({
      organizationId: "org_1",
      planCode: "PROFESSIONAL",
      reason: "Destek talebi #12345 üzerine yükseltme",
      expectedCurrentPlanCode: NO_PLAN_CODE,
    });
    expect(parsed.success).toBe(true);
  });

  it("revoke şeması gerekçe olmadan reddeder", () => {
    const parsed = platformPlanOverrideRevokeSchema.safeParse({
      organizationId: "org_1",
      expectedOverrideId: "override_1",
      reason: "",
    });
    expect(parsed.success).toBe(false);
  });
});

describe("YF-819 — applyPlatformPlanOverride: yetki sınırı", () => {
  it("platformAdminId GERÇEK bir PlatformAdmin'e ait DEĞİLSE (ör. bir tenant User id'si) FK ihlaliyle reddeder — tenant kullanıcısı asla aktör OLAMAZ", async () => {
    const { organizationId, owner } = await createOwnerOrg();
    await setOrganizationPlan(organizationId, "STARTER");

    await expect(
      applyPlatformPlanOverride({
        organizationId,
        targetPlanCode: "PROFESSIONAL",
        reason: "Tenant kullanıcısı aktör olarak denenir",
        expiresAt: null,
        expectedCurrentPlanCode: "STARTER",
        platformAdminId: owner.id, // gerçek bir PlatformAdmin DEĞİL — tenant User id'si
        ...meta(),
      }),
    ).rejects.toThrow();
  });
});

describe("YF-819 — applyPlatformPlanOverride: kanonik plan doğrulaması", () => {
  it("var olmayan bir plan kodunu NOT_FOUND ile reddeder", async () => {
    const { organizationId } = await createOwnerOrg();
    await setOrganizationPlan(organizationId, "STARTER");
    const admin = await createPlatformAdmin();

    await expect(
      applyPlatformPlanOverride({
        organizationId,
        targetPlanCode: "UYDURMA_PLAN",
        reason: "Geçersiz plan denemesi — kanonik olmayan kod",
        expiresAt: null,
        expectedCurrentPlanCode: "STARTER",
        platformAdminId: admin.id,
        ...meta(),
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("pasif (isActive=false) bir planı NOT_FOUND ile reddeder", async () => {
    const { organizationId } = await createOwnerOrg();
    await setOrganizationPlan(organizationId, "STARTER");
    const admin = await createPlatformAdmin();
    const inactivePlan = await createTestPlan({ isActive: false });

    await expect(
      applyPlatformPlanOverride({
        organizationId,
        targetPlanCode: inactivePlan.code,
        reason: "Pasif plana geçiş denemesi — reddedilmeli",
        expiresAt: null,
        expectedCurrentPlanCode: "STARTER",
        platformAdminId: admin.id,
        ...meta(),
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("YF-819 — applyPlatformPlanOverride: yükseltme (upgrade)", () => {
  it("Organization.planId'yi hedef plana yazar, ACTIVE bir override kaydı oluşturur ve audit log üretir (platformAdminId dolu, actorId null)", async () => {
    const { organizationId } = await createOwnerOrg();
    await setOrganizationPlan(organizationId, "STARTER");
    const admin = await createPlatformAdmin({ name: "Destek Operatörü" });

    const result = await applyPlatformPlanOverride({
      organizationId,
      targetPlanCode: "BUSINESS",
      reason: "Müşteri talebi üzerine geçici yükseltme — bilet #4821",
      expiresAt: null,
      expectedCurrentPlanCode: "STARTER",
      platformAdminId: admin.id,
      ...meta(),
    });
    expect(result.planCode).toBe("BUSINESS");

    const org = await db.organization.findUniqueOrThrow({ where: { id: organizationId }, include: { plan: true } });
    expect(org.plan?.code).toBe("BUSINESS");

    const override = await getActivePlatformPlanOverride(organizationId);
    expect(override?.planCode).toBe("BUSINESS");
    expect(override?.platformAdminName).toBe("Destek Operatörü");
    expect(override?.status).toBe("ACTIVE");

    const auditEntry = await db.auditLog.findFirst({
      where: { organizationId, action: "platform.plan.override_applied" },
    });
    expect(auditEntry).not.toBeNull();
    expect(auditEntry?.platformAdminId).toBe(admin.id);
    expect(auditEntry?.actorId).toBeNull();
    expect((auditEntry?.beforeJson as { planCode: string })?.planCode).toBe("STARTER");
    expect((auditEntry?.afterJson as { planCode: string })?.planCode).toBe("BUSINESS");
  });

  it("plansız (NO_PLAN_CODE) bir organizasyona da uygulanabilir", async () => {
    const { organizationId } = await createOwnerOrg();
    await db.organization.update({ where: { id: organizationId }, data: { planId: null } });
    const admin = await createPlatformAdmin();

    const result = await applyPlatformPlanOverride({
      organizationId,
      targetPlanCode: "STARTER",
      reason: "Plansız organizasyona manuel plan ataması",
      expiresAt: null,
      expectedCurrentPlanCode: NO_PLAN_CODE,
      platformAdminId: admin.id,
      ...meta(),
    });
    expect(result.planCode).toBe("STARTER");
  });
});

describe("YF-819 — applyPlatformPlanOverride: eşzamanlılık (CAS + satır kilidi)", () => {
  it("expectedCurrentPlanCode güncel durumla eşleşmiyorsa CONFLICT fırlatır", async () => {
    const { organizationId } = await createOwnerOrg();
    await setOrganizationPlan(organizationId, "STARTER");
    const admin = await createPlatformAdmin();

    await expect(
      applyPlatformPlanOverride({
        organizationId,
        targetPlanCode: "PROFESSIONAL",
        reason: "Yanlış beklenen plan ile deneme",
        expiresAt: null,
        expectedCurrentPlanCode: "BUSINESS", // yanlış — güncel plan STARTER
        platformAdminId: admin.id,
        ...meta(),
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("çift tıklama/iki eşzamanlı istek: yalnızca BİRİ başarılı olur, diğeri CONFLICT ile reddedilir (satır kilidi altında serileşir)", async () => {
    const { organizationId } = await createOwnerOrg();
    await setOrganizationPlan(organizationId, "STARTER");
    const admin = await createPlatformAdmin();

    const requestInput = (targetPlanCode: string) => ({
      organizationId,
      targetPlanCode,
      reason: "Eşzamanlı geçersiz kılma isteği",
      expiresAt: null,
      expectedCurrentPlanCode: "STARTER",
      platformAdminId: admin.id,
      ...meta(),
    });

    const results = await Promise.allSettled([
      applyPlatformPlanOverride(requestInput("PROFESSIONAL")),
      applyPlatformPlanOverride(requestInput("BUSINESS")),
    ]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({ code: "CONFLICT" });

    // Yalnızca TEK bir ACTIVE override kaydı kalmalı (ikinci istek hiç yazmadı).
    const activeOverrides = await db.platformPlanOverride.findMany({ where: { organizationId, status: "ACTIVE" } });
    expect(activeOverrides).toHaveLength(1);
  });
});

describe("YF-819 — applyPlatformPlanOverride: aynı plana tekrar uygulama", () => {
  it("organizasyon zaten hedef plandaysa CONFLICT fırlatır (anlamsız override kaydı oluşturulmaz)", async () => {
    const { organizationId } = await createOwnerOrg();
    await setOrganizationPlan(organizationId, "PROFESSIONAL");
    const admin = await createPlatformAdmin();

    await expect(
      applyPlatformPlanOverride({
        organizationId,
        targetPlanCode: "PROFESSIONAL",
        reason: "Zaten bu plandayken tekrar uygulama denemesi",
        expiresAt: null,
        expectedCurrentPlanCode: "PROFESSIONAL",
        platformAdminId: admin.id,
        ...meta(),
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });
});

describe("YF-819 — applyPlatformPlanOverride: supersede", () => {
  it("aynı organizasyon için yeni bir override uygulanınca ÖNCEKİ ACTIVE kayıt SUPERSEDED olur, silinmez", async () => {
    const { organizationId } = await createOwnerOrg();
    await setOrganizationPlan(organizationId, "STARTER");
    const admin = await createPlatformAdmin();

    const first = await applyPlatformPlanOverride({
      organizationId,
      targetPlanCode: "PROFESSIONAL",
      reason: "İlk geçersiz kılma",
      expiresAt: null,
      expectedCurrentPlanCode: "STARTER",
      platformAdminId: admin.id,
      ...meta(),
    });

    await applyPlatformPlanOverride({
      organizationId,
      targetPlanCode: "BUSINESS",
      reason: "İkinci geçersiz kılma — ilkini supersede eder",
      expiresAt: null,
      expectedCurrentPlanCode: "PROFESSIONAL",
      platformAdminId: admin.id,
      ...meta(),
    });

    const firstRow = await db.platformPlanOverride.findUniqueOrThrow({ where: { id: first.overrideId } });
    expect(firstRow.status).toBe("SUPERSEDED");

    const active = await getActivePlatformPlanOverride(organizationId);
    expect(active?.planCode).toBe("BUSINESS");

    const allRows = await db.platformPlanOverride.findMany({ where: { organizationId } });
    expect(allRows).toHaveLength(2); // hiçbiri silinmedi
  });
});

describe("YF-819 — revokePlatformPlanOverride", () => {
  it("aktif override'ı sonlandırır ve planı ÖNCEki plana geri döndürür", async () => {
    const { organizationId } = await createOwnerOrg();
    await setOrganizationPlan(organizationId, "STARTER");
    const admin = await createPlatformAdmin();

    const applied = await applyPlatformPlanOverride({
      organizationId,
      targetPlanCode: "BUSINESS",
      reason: "Geçici yükseltme",
      expiresAt: null,
      expectedCurrentPlanCode: "STARTER",
      platformAdminId: admin.id,
      ...meta(),
    });

    await revokePlatformPlanOverride({
      organizationId,
      expectedOverrideId: applied.overrideId,
      reason: "Destek süresi sona erdi, plan geri alınıyor",
      platformAdminId: admin.id,
      ...meta(),
    });

    const org = await db.organization.findUniqueOrThrow({ where: { id: organizationId }, include: { plan: true } });
    expect(org.plan?.code).toBe("STARTER");

    const row = await db.platformPlanOverride.findUniqueOrThrow({ where: { id: applied.overrideId } });
    expect(row.status).toBe("REVOKED");
    expect(row.revokedById).toBe(admin.id);

    const auditEntry = await db.auditLog.findFirst({ where: { organizationId, action: "platform.plan.override_revoked" } });
    expect(auditEntry).not.toBeNull();
    expect(auditEntry?.platformAdminId).toBe(admin.id);

    expect(await getActivePlatformPlanOverride(organizationId)).toBeNull();
  });

  it("expectedOverrideId eşleşmezse CONFLICT fırlatır", async () => {
    const { organizationId } = await createOwnerOrg();
    await setOrganizationPlan(organizationId, "STARTER");
    const admin = await createPlatformAdmin();

    await applyPlatformPlanOverride({
      organizationId,
      targetPlanCode: "BUSINESS",
      reason: "Geçici yükseltme",
      expiresAt: null,
      expectedCurrentPlanCode: "STARTER",
      platformAdminId: admin.id,
      ...meta(),
    });

    await expect(
      revokePlatformPlanOverride({
        organizationId,
        expectedOverrideId: "yanlis_id",
        reason: "Yanlış kimlikle sonlandırma denemesi",
        platformAdminId: admin.id,
        ...meta(),
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("aktif bir override yoksa NOT_FOUND fırlatır", async () => {
    const { organizationId } = await createOwnerOrg();
    await setOrganizationPlan(organizationId, "STARTER");
    const admin = await createPlatformAdmin();

    await expect(
      revokePlatformPlanOverride({
        organizationId,
        expectedOverrideId: "yok_boyle_bir_kayit",
        reason: "Aktif override yokken sonlandırma denemesi",
        platformAdminId: admin.id,
        ...meta(),
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("önceki plan artık pasifse fail-closed olarak plansıza (null) döner", async () => {
    const { organizationId } = await createOwnerOrg();
    const revertPlan = await createTestPlan({ name: "Geri Dönüş Planı" });
    await setOrganizationPlan(organizationId, revertPlan.code);
    const admin = await createPlatformAdmin();

    const applied = await applyPlatformPlanOverride({
      organizationId,
      targetPlanCode: "BUSINESS",
      reason: "Yükseltme",
      expiresAt: null,
      expectedCurrentPlanCode: revertPlan.code,
      platformAdminId: admin.id,
      ...meta(),
    });

    // Önceki plan artık pasif (silme yerine deaktive — "hard delete yok" ilkesi).
    await db.plan.update({ where: { id: revertPlan.id }, data: { isActive: false } });

    await revokePlatformPlanOverride({
      organizationId,
      expectedOverrideId: applied.overrideId,
      reason: "Sonlandırma — önceki plan artık pasif",
      platformAdminId: admin.id,
      ...meta(),
    });

    const org = await db.organization.findUniqueOrThrow({ where: { id: organizationId } });
    expect(org.planId).toBeNull();
  });
});

describe("YF-819 — süre dolumu (expiry) tembel/lazy mutabakat", () => {
  it("expiresAt geçmişte olan bir ACTIVE override, bir sonraki okuma/işlemde EXPIRED olarak mutabakata uğrar ve plan geri döner", async () => {
    const { organizationId } = await createOwnerOrg();
    await setOrganizationPlan(organizationId, "STARTER");
    const admin = await createPlatformAdmin();

    const applied = await applyPlatformPlanOverride({
      organizationId,
      targetPlanCode: "BUSINESS",
      reason: "Süreli geçici yükseltme",
      expiresAt: new Date(Date.now() + 60_000),
      expectedCurrentPlanCode: "STARTER",
      platformAdminId: admin.id,
      ...meta(),
    });
    // Süreyi geçmişe taşı (gerçek zamanlayıcı beklemek yerine doğrudan DB'de).
    await db.platformPlanOverride.update({ where: { id: applied.overrideId }, data: { expiresAt: new Date(Date.now() - 1000) } });

    await reconcileExpiredPlatformPlanOverride(organizationId);

    const row = await db.platformPlanOverride.findUniqueOrThrow({ where: { id: applied.overrideId } });
    expect(row.status).toBe("EXPIRED");
    expect(row.revokedById).toBeNull(); // sistem tarafından, bir Platform Admin tarafından DEĞİL

    const org = await db.organization.findUniqueOrThrow({ where: { id: organizationId }, include: { plan: true } });
    expect(org.plan?.code).toBe("STARTER");

    const auditEntry = await db.auditLog.findFirst({
      where: { organizationId, action: "platform.plan.override_expired_reconciled" },
    });
    expect(auditEntry).not.toBeNull();
    expect(auditEntry?.platformAdminId).toBeNull();
  });

  it("getPlatformOrganizationDetail GÖRÜNTÜLENİRKEN de süresi dolmuş override'ı tembel/lazy mutabakata uğratır", async () => {
    const { organizationId } = await createOwnerOrg();
    await setOrganizationPlan(organizationId, "STARTER");
    const admin = await createPlatformAdmin();

    const applied = await applyPlatformPlanOverride({
      organizationId,
      targetPlanCode: "BUSINESS",
      reason: "Süreli geçici yükseltme",
      expiresAt: new Date(Date.now() + 60_000),
      expectedCurrentPlanCode: "STARTER",
      platformAdminId: admin.id,
      ...meta(),
    });
    await db.platformPlanOverride.update({ where: { id: applied.overrideId }, data: { expiresAt: new Date(Date.now() - 1000) } });

    const detail = await getPlatformOrganizationDetail(organizationId);
    expect(detail.plan?.code).toBe("STARTER");
    expect(detail.activePlanOverride).toBeNull();
  });
});

describe("YF-819 — downgrade önizleme ve semantiği", () => {
  it("önizleme, kota aşımını doğru hesaplar ve isDowngradeRisk=true işaretler; UYGULAMA sonrası mevcut kayıtlar SİLİNMEZ, yalnızca YENİ kayıt engellenir", async () => {
    const { organizationId, owner } = await createOwnerOrg();
    // BUSINESS: users.active=30 — 4 kullanıcı oluştur (owner dahil), sonra STARTER'a (limit=3) düşür.
    await setOrganizationPlan(organizationId, "BUSINESS");
    await createOrgUser(organizationId, "ADMIN");
    await createOrgUser(organizationId, "ADMIN");
    await createOrgUser(organizationId, "ADMIN");
    // owner + 3 = 4 aktif kullanıcı.

    const preview = await previewPlatformPlanChange(organizationId, "STARTER");
    const usersLimit = preview.limits.find((l) => l.limitId === "users.active");
    expect(usersLimit?.used).toBe(4);
    expect(usersLimit?.targetMax).toBe(3);
    expect(usersLimit?.wouldExceed).toBe(true);
    expect(preview.isDowngradeRisk).toBe(true);

    const admin = await createPlatformAdmin();
    await applyPlatformPlanOverride({
      organizationId,
      targetPlanCode: "STARTER",
      reason: "Bilinçli downgrade — limit aşımı kabul edildi",
      expiresAt: null,
      expectedCurrentPlanCode: "BUSINESS",
      platformAdminId: admin.id,
      ...meta(),
    });

    // Mevcut kullanıcılar SİLİNMEDİ.
    const remainingUsers = await db.user.count({ where: { organizationId, status: "ACTIVE" } });
    expect(remainingUsers).toBe(4);

    // Merkezi entitlement servisi (YF-802, DEĞİŞTİRİLMEDİ) yeni planı ANINDA yansıtır —
    // ikinci bir entitlement motoru İCAT EDİLMEDİĞİNİN kanıtı.
    const summary = await getOrganizationLimitSummary(db, organizationId);
    expect(summary["users.active"].isOverLimit).toBe(true);
    expect(summary["users.active"].canAddOne).toBe(false); // yeni kullanıcı eklenemez
    void owner;
  });

  it("upgrade sonrası AI/OCR kotası merkezi entitlement servisinden ANINDA yeni planı yansıtır", async () => {
    const { organizationId } = await createOwnerOrg();
    await setOrganizationPlan(organizationId, "STARTER"); // ai.monthly_quota=0
    const admin = await createPlatformAdmin();

    await applyPlatformPlanOverride({
      organizationId,
      targetPlanCode: "BUSINESS", // ai.monthly_quota=2000, ocr.monthly_quota=200
      reason: "AI/OCR erişimi için geçici yükseltme",
      expiresAt: null,
      expectedCurrentPlanCode: "STARTER",
      platformAdminId: admin.id,
      ...meta(),
    });

    const summary = await getOrganizationLimitSummary(db, organizationId);
    expect(summary["ai.monthly_quota"].max).toBe(2000);
    expect(summary["ocr.monthly_quota"].max).toBe(200);
  });
});

describe("YF-819 — faturalama kaynağı sınıflandırması (Stripe-managed vs manuel)", () => {
  it("Stripe aboneliği YOKSA MANUAL döner", () => {
    expect(classifyPlanBillingSource(null)).toBe("MANUAL");
  });
  it("aktif/deneme/gecikmiş Stripe aboneliği STRIPE_MANAGED döner", () => {
    expect(classifyPlanBillingSource("ACTIVE")).toBe("STRIPE_MANAGED");
    expect(classifyPlanBillingSource("TRIALING")).toBe("STRIPE_MANAGED");
    expect(classifyPlanBillingSource("PAST_DUE")).toBe("STRIPE_MANAGED");
  });
  it("iptal edilmiş/tükenmiş bir abonelik MANUAL döner", () => {
    expect(classifyPlanBillingSource("CANCELED")).toBe("MANUAL");
    expect(classifyPlanBillingSource("UNPAID")).toBe("MANUAL");
  });

  it("previewPlatformPlanChange, aktif bir Stripe aboneliği olan organizasyon için STRIPE_MANAGED döner", async () => {
    const { organizationId } = await createOwnerOrg();
    await setOrganizationPlan(organizationId, "STARTER");
    await db.organizationStripeSubscription.create({
      data: {
        organizationId,
        environment: "TEST",
        stripeCustomerId: `cus_${Date.now()}`,
        stripeSubscriptionId: `sub_${Date.now()}`,
        stripePriceId: `price_${Date.now()}`,
        status: "ACTIVE",
      },
    });

    const preview = await previewPlatformPlanChange(organizationId, "PROFESSIONAL");
    expect(preview.billingSource).toBe("STRIPE_MANAGED");
  });
});

describe("YF-819 — proje finansal kayıtlarına dokunulmaz", () => {
  it("bir plan geçersiz kılması FinancialTransaction/Settlement/AccountMovement tablolarına HİÇBİR yazma yapmaz", async () => {
    const { organizationId } = await createOwnerOrg();
    await setOrganizationPlan(organizationId, "STARTER");
    const admin = await createPlatformAdmin();

    const before = await Promise.all([
      db.financialTransaction.count({ where: { organizationId } }),
      db.settlement.count({ where: { organizationId } }),
      db.accountMovement.count({ where: { organizationId } }),
    ]);

    const applied = await applyPlatformPlanOverride({
      organizationId,
      targetPlanCode: "BUSINESS",
      reason: "Finansal kayıt izolasyonu testi",
      expiresAt: null,
      expectedCurrentPlanCode: "STARTER",
      platformAdminId: admin.id,
      ...meta(),
    });
    await revokePlatformPlanOverride({
      organizationId,
      expectedOverrideId: applied.overrideId,
      reason: "Finansal kayıt izolasyonu testi — sonlandırma",
      platformAdminId: admin.id,
      ...meta(),
    });

    const after = await Promise.all([
      db.financialTransaction.count({ where: { organizationId } }),
      db.settlement.count({ where: { organizationId } }),
      db.accountMovement.count({ where: { organizationId } }),
    ]);
    expect(after).toEqual(before);
  });
});

describe("YF-819 — YF-818 org detay görünümü etkilenmez", () => {
  it("mevcut alanlar (kullanıcı/proje/faturalama sağlığı) doğru kalırken YENİ alanlar (planBillingSource/activePlanOverride) eklenmiştir", async () => {
    const { organizationId } = await createOwnerOrg();
    await setOrganizationPlan(organizationId, "STARTER");
    await createOrgUser(organizationId, "ADMIN");

    const detail = await getPlatformOrganizationDetail(organizationId);
    expect(detail.userCount).toBe(2);
    expect(detail.plan?.code).toBe("STARTER");
    expect(detail.planBillingSource).toBe("MANUAL");
    expect(detail.activePlanOverride).toBeNull();
  });
});
