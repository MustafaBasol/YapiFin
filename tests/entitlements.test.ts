import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { cleanDatabase, createOwnerOrg, createTestPlan, setOrganizationPlan } from "./helpers";
import {
  canUseCapability,
  checkCapability,
  checkLimit,
  assertCapability,
  assertWithinLimit,
  getEffectivePlan,
} from "@/lib/entitlements/entitlement-service";
import { createProject } from "@/server/services/project-service";
import { createInvitation, acceptInvitation } from "@/server/services/invitation-service";
import { uploadAndExtractDocument } from "@/server/services/document-extraction-service";
import { importBankStatement } from "@/server/services/bank-import-service";
import { generateToken } from "@/lib/auth/tokens";

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
  return `ent-${seq}-${Date.now()}`;
}

async function seedProject(actor: Awaited<ReturnType<typeof createOwnerOrg>>["owner"]) {
  return createProject(actor, { code: key(), name: `Entitlement Proje ${key()}`, contractAmount: 0, estimatedBudget: 0 });
}

/** Bir davet oluşturup, testte doğrudan kullanılabilecek çözümlenmemiş (raw) bir kabul token'ı üretir. */
async function inviteAndGetRawToken(
  owner: Awaited<ReturnType<typeof createOwnerOrg>>["owner"],
  email: string,
) {
  const invitation = await createInvitation(owner, { email, role: "FINANCE", projectIds: [] });
  const { raw, hash } = generateToken();
  await db.invitation.update({ where: { id: invitation.id }, data: { tokenHash: hash } });
  return raw;
}

function pdfBuffer(): Buffer {
  return Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.alloc(64, 0x20)]);
}

function csvBuffer(): Buffer {
  return Buffer.from(["Tarih,Açıklama,Tutar,Referans", "01.01.2026,Test,100.00,REF1"].join("\n"), "utf8");
}

async function seedBankAccount(actor: Awaited<ReturnType<typeof createOwnerOrg>>["owner"]) {
  return db.financialAccount.create({
    data: { organizationId: actor.organizationId, name: `Banka ${key()}`, type: "BANK", currency: "TRY", isActive: true },
  });
}

describe("entitlement servisi — temel davranış", () => {
  it("geçerli bir yetenek (capability) planda tanımlıysa izin verir", async () => {
    const { organizationId } = await createOwnerOrg();
    await setOrganizationPlan(organizationId, "PROFESSIONAL");

    const result = await checkCapability(db, organizationId, "ocr");
    expect(result).toMatchObject({ allowed: true, capability: "ocr", planCode: "PROFESSIONAL" });
    expect(await canUseCapability(db, organizationId, "ocr")).toBe(true);
  });

  it("planda tanımlı olmayan (false) bir yetenek reddedilir", async () => {
    const { organizationId } = await createOwnerOrg();
    await setOrganizationPlan(organizationId, "STARTER");

    const result = await checkCapability(db, organizationId, "ocr");
    expect(result).toMatchObject({ allowed: false, capability: "ocr", planCode: "STARTER" });
  });

  it("bilinmeyen bir yetenek kimliği fail-closed olarak her zaman reddedilir", async () => {
    const { organizationId } = await createOwnerOrg();
    await setOrganizationPlan(organizationId, "ENTERPRISE");

    // ENTERPRISE her şeye izin verse bile, tanımsız bir kimlik ASLA geçmez.
    const result = await checkCapability(db, organizationId, "made.up.capability.does.not.exist");
    expect(result.allowed).toBe(false);
    expect(await canUseCapability(db, organizationId, "made.up.capability.does.not.exist")).toBe(false);

    await expect(
      assertCapability(db, organizationId, "made.up.capability.does.not.exist" as never),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("planı olmayan (planId null) bir organizasyon her şeyi fail-closed reddeder", async () => {
    const { organizationId } = await createOwnerOrg();
    await db.organization.update({ where: { id: organizationId }, data: { planId: null } });

    expect(await canUseCapability(db, organizationId, "ocr")).toBe(false);
    const limit = await checkLimit(db, organizationId, "projects.active");
    expect(limit).toMatchObject({ max: 0, canAddOne: false });
  });

  it("pasif (isActive=false) bir plan da fail-closed muamele görür", async () => {
    const { organizationId } = await createOwnerOrg();
    const plan = await createTestPlan({
      capabilities: { ocr: true },
      limits: { "projects.active": 100 },
      isActive: false,
    });
    await db.organization.update({ where: { id: organizationId }, data: { planId: plan.id } });

    expect(await canUseCapability(db, organizationId, "ocr")).toBe(false);
    expect((await checkLimit(db, organizationId, "projects.active")).max).toBe(0);
  });
});

describe("entitlement servisi — tenant izolasyonu", () => {
  it("bir organizasyonun plan/kullanım durumu başka bir organizasyonu etkilemez", async () => {
    const orgA = await createOwnerOrg();
    const orgB = await createOwnerOrg();
    await setOrganizationPlan(orgA.organizationId, "STARTER");
    await setOrganizationPlan(orgB.organizationId, "ENTERPRISE");

    expect(await canUseCapability(db, orgA.organizationId, "ocr")).toBe(false);
    expect(await canUseCapability(db, orgB.organizationId, "ocr")).toBe(true);

    // orgB'de 2 proje daha oluşturulsa bile orgA'nın kullanım sayacı değişmez.
    await seedProject(orgB.owner);
    await seedProject(orgB.owner);

    const limitA = await checkLimit(db, orgA.organizationId, "projects.active");
    // orgA henüz hiç proje oluşturmadı.
    expect(limitA.used).toBe(0);
  });
});

describe("entitlement servisi — nicel limit uygulaması (proje)", () => {
  it("plan limitine kadar proje oluşturmaya izin verir, sonraki reddedilir", async () => {
    const { owner, organizationId } = await createOwnerOrg();
    const plan = await createTestPlan({ limits: { "projects.active": 2 }, capabilities: {} });
    await db.organization.update({ where: { id: organizationId }, data: { planId: plan.id } });

    await seedProject(owner);
    await seedProject(owner);

    await expect(seedProject(owner)).rejects.toMatchObject({ code: "CONFLICT" });

    const count = await db.project.count({ where: { organizationId } });
    expect(count).toBe(2);
  });

  it("CANCELLED olmayan projeler kotaya dahildir, DRAFT dahi olsa sayılır", async () => {
    const { owner, organizationId } = await createOwnerOrg();
    const plan = await createTestPlan({ limits: { "projects.active": 1 }, capabilities: {} });
    await db.organization.update({ where: { id: organizationId }, data: { planId: plan.id } });

    await seedProject(owner); // DRAFT durumunda oluşturulur (varsayılan)
    const result = await checkLimit(db, organizationId, "projects.active");
    expect(result).toMatchObject({ used: 1, max: 1, canAddOne: false });
  });
});

describe("entitlement servisi — nicel limit uygulaması (kullanıcı)", () => {
  it("davet gönderme aşamasında kota doluysa erken reddedilir", async () => {
    const { owner, organizationId } = await createOwnerOrg();
    // owner zaten 1 aktif kullanıcı sayılır; limiti 1 yaparak kotayı dolu başlat.
    const plan = await createTestPlan({ limits: { "users.active": 1 }, capabilities: {} });
    await db.organization.update({ where: { id: organizationId }, data: { planId: plan.id } });

    await expect(
      createInvitation(owner, { email: `${key()}@example.com`, role: "FINANCE", projectIds: [] }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("davet kabul aşamasında otoritatif kontrol uygulanır — davet oluşturma anında geçerliydi ama kabul anında kota dolmuş olabilir", async () => {
    const { owner, organizationId } = await createOwnerOrg();
    const plan = await createTestPlan({ limits: { "users.active": 2 }, capabilities: {} });
    await db.organization.update({ where: { id: organizationId }, data: { planId: plan.id } });

    // Her iki davet de owner (1 aktif kullanıcı) hâlâ limitin (2) altındayken
    // oluşturulur — davet oluşturma erken kontrolü (`createInvitation`)
    // yalnızca AKTİF kullanıcıları sayar, bekleyen davetleri değil, bu yüzden
    // ikisi de geçerlidir.
    const raw1 = await inviteAndGetRawToken(owner, `${key()}@example.com`);
    const raw2 = await inviteAndGetRawToken(owner, `${key()}@example.com`);

    // İlk davet kabul edilir: owner + bu kullanıcı = 2 = limit.
    await acceptInvitation({ token: raw1, firstName: "A", lastName: "B", password: "Sifre1234" });
    const usersCount = await db.user.count({ where: { organizationId, status: "ACTIVE" } });
    expect(usersCount).toBe(2);

    // İkinci davetin kendisi geçerliydi ama artık kota dolu — yalnızca
    // `acceptInvitation` içindeki otoritatif kontrol bunu yakalayabilir
    // (davet oluşturma anındaki erken kontrol bunu göremezdi).
    await expect(
      acceptInvitation({ token: raw2, firstName: "C", lastName: "D", password: "Sifre1234" }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });
});

describe("entitlement servisi — düşürme (downgrade) semantiği", () => {
  it("plan düşürüldüğünde mevcut fazla kayıtlar silinmez, yalnızca yeni oluşturma engellenir ve limit-üstü durumu açıkça bildirilir", async () => {
    const { owner, organizationId } = await createOwnerOrg();
    const generousPlan = await createTestPlan({ limits: { "projects.active": 10 }, capabilities: {} });
    await db.organization.update({ where: { id: organizationId }, data: { planId: generousPlan.id } });

    const p1 = await seedProject(owner);
    const p2 = await seedProject(owner);
    const p3 = await seedProject(owner);

    // Şimdi 3 aktif proje varken 2 kotalı bir plana düşür.
    const strictPlan = await createTestPlan({ limits: { "projects.active": 2 }, capabilities: {} });
    await db.organization.update({ where: { id: organizationId }, data: { planId: strictPlan.id } });

    const status = await checkLimit(db, organizationId, "projects.active");
    expect(status).toMatchObject({ used: 3, max: 2, isOverLimit: true, canAddOne: false });

    // Mevcut 3 proje hâlâ veritabanında ve erişilebilir durumda.
    const stillThere = await db.project.findMany({ where: { organizationId }, select: { id: true } });
    expect(stillThere.map((p) => p.id).sort()).toEqual([p1.id, p2.id, p3.id].sort());

    // Yeni proje oluşturmak reddedilir.
    await expect(seedProject(owner)).rejects.toMatchObject({ code: "CONFLICT" });
  });
});

describe("entitlement servisi — yükseltme (upgrade) semantiği", () => {
  it("plan yükseltildiğinde yeni oluşturma özel bir kod olmadan hemen serbest kalır", async () => {
    const { owner, organizationId } = await createOwnerOrg();
    const strictPlan = await createTestPlan({ limits: { "projects.active": 1 }, capabilities: {} });
    await db.organization.update({ where: { id: organizationId }, data: { planId: strictPlan.id } });

    await seedProject(owner);
    await expect(seedProject(owner)).rejects.toMatchObject({ code: "CONFLICT" });

    const generousPlan = await createTestPlan({ limits: { "projects.active": 5 }, capabilities: {} });
    await db.organization.update({ where: { id: organizationId }, data: { planId: generousPlan.id } });

    // Aynı createProject çağrısı, hiçbir özel "yükseltme" kod yolu olmadan başarılı olur.
    const project = await seedProject(owner);
    expect(project.id).toBeTruthy();
  });
});

describe("entitlement servisi — merkezi kapasite kontrolünün gerçek modüllere bağlanması", () => {
  it("OCR yüklemesi, plan 'ocr' yeteneğini içermiyorsa servis katmanında reddedilir", async () => {
    const { owner, organizationId } = await createOwnerOrg();
    await setOrganizationPlan(organizationId, "STARTER");

    await expect(
      uploadAndExtractDocument(owner, { fileName: "fatura.pdf", buffer: pdfBuffer() }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("OCR yüklemesi, plan 'ocr' yeteneğini içeriyorsa servis katmanında başarılı olur", async () => {
    const { owner, organizationId } = await createOwnerOrg();
    await setOrganizationPlan(organizationId, "PROFESSIONAL");

    const record = await uploadAndExtractDocument(owner, { fileName: "fatura.pdf", buffer: pdfBuffer() });
    expect(record.id).toBeTruthy();
  });

  it("banka içe aktarımı, plan 'bank_import' yeteneğini içermiyorsa servis katmanında reddedilir", async () => {
    const { owner, organizationId } = await createOwnerOrg();
    await setOrganizationPlan(organizationId, "STARTER");
    const account = await seedBankAccount(owner);

    await expect(
      importBankStatement(owner, { financialAccountId: account.id, fileName: "ekstre.csv", buffer: csvBuffer() }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("bu kontroller servis katmanında çalışır — frontend atlanarak (doğrudan servis çağrısıyla) da bypass edilemez", async () => {
    const { owner, organizationId } = await createOwnerOrg();
    await setOrganizationPlan(organizationId, "STARTER");

    // Herhangi bir UI/route katmanı olmadan doğrudan servis fonksiyonu çağrılıyor —
    // yine de reddediliyor, çünkü kontrol server/services içinde, action/route dışında.
    await expect(
      uploadAndExtractDocument(owner, { fileName: "fatura.pdf", buffer: pdfBuffer() }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});

describe("entitlement servisi — eşzamanlılık sınırı", () => {
  it("son boş proje koltuğu için yarışan iki eşzamanlı oluşturma isteğinden yalnızca biri başarılı olur", async () => {
    const { owner, organizationId } = await createOwnerOrg();
    const plan = await createTestPlan({ limits: { "projects.active": 1 }, capabilities: {} });
    await db.organization.update({ where: { id: organizationId }, data: { planId: plan.id } });

    const [r1, r2] = await Promise.allSettled([seedProject(owner), seedProject(owner)]);
    const outcomes = [r1, r2];
    const fulfilled = outcomes.filter((r) => r.status === "fulfilled");
    const rejected = outcomes.filter((r) => r.status === "rejected");

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({ code: "CONFLICT" });

    const finalCount = await db.project.count({ where: { organizationId } });
    expect(finalCount).toBe(1);
  });

  it("son boş kullanıcı koltuğu için yarışan iki eşzamanlı davet kabulünden yalnızca biri başarılı olur", async () => {
    const { owner, organizationId } = await createOwnerOrg();
    const plan = await createTestPlan({ limits: { "users.active": 2 }, capabilities: {} });
    await db.organization.update({ where: { id: organizationId }, data: { planId: plan.id } });

    // owner (1) zaten kotanın yarısını kullanıyor; kalan tek koltuk için iki davet yarışır.
    const raw1 = await inviteAndGetRawToken(owner, `${key()}@example.com`);
    const raw2 = await inviteAndGetRawToken(owner, `${key()}@example.com`);

    const [r1, r2] = await Promise.allSettled([
      acceptInvitation({ token: raw1, firstName: "A", lastName: "B", password: "Sifre1234" }),
      acceptInvitation({ token: raw2, firstName: "C", lastName: "D", password: "Sifre1234" }),
    ]);
    const outcomes = [r1, r2];
    expect(outcomes.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((r) => r.status === "rejected")).toHaveLength(1);

    const finalCount = await db.user.count({ where: { organizationId, status: "ACTIVE" } });
    expect(finalCount).toBe(2);
  });
});

describe("entitlement servisi — getEffectivePlan / assertWithinLimit yardımcıları", () => {
  it("getEffectivePlan güncel plan kodunu ve limit/capability haritasını döner", async () => {
    const { organizationId } = await createOwnerOrg();
    await setOrganizationPlan(organizationId, "ENTERPRISE");

    const plan = await getEffectivePlan(db, organizationId);
    expect(plan.code).toBe("ENTERPRISE");
    expect(plan.limits["projects.active"]).toBeNull();
    expect(plan.capabilities["ocr"]).toBe(true);
  });

  it("assertWithinLimit dolu olmayan bir kotada LimitCheckResult döner (fırlatmaz)", async () => {
    const { organizationId } = await createOwnerOrg();
    await setOrganizationPlan(organizationId, "ENTERPRISE");

    const result = await assertWithinLimit(db, organizationId, "projects.active");
    expect(result.canAddOne).toBe(true);
    expect(result.max).toBeNull();
  });
});
