import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { cleanDatabase, createOwnerOrg, createOrgUser } from "./helpers";
import { createProject, assignProjectMember, getProjectForUser } from "@/server/services/project-service";
import { createExpense, cancelExpense } from "@/server/services/transaction-service";
import { createAccount } from "@/server/services/account-service";
import { createSettlement, cancelSettlement } from "@/server/services/settlement-service";
import { createTransfer } from "@/server/services/transfer-service";
import { getBudgetReport } from "@/server/services/budget-report-service";
import {
  getProjectBudgetPlanning,
  getProjectBudgetPlanningForResolvedProject,
  createProjectBudgetItem,
  updateProjectBudgetItem,
  deleteProjectBudgetItem,
} from "@/server/services/project-budget-service";
import { createProjectBudgetItemSchema, plannedAmountSchema } from "@/lib/validation/project-budget";
import type { SessionUser } from "@/lib/auth/session";

beforeAll(async () => {
  await cleanDatabase();
});
afterEach(async () => {
  vi.restoreAllMocks();
  await cleanDatabase();
});
afterAll(async () => {
  await db.$disconnect();
});

let seq = 0;
function key() {
  seq += 1;
  return `pb-test-${seq}-${Math.floor(Math.random() * 1e9)}`;
}

async function seedExpenseCategory(owner: SessionUser, isActive = true) {
  seq += 1;
  return db.transactionCategory.create({
    data: { organizationId: owner.organizationId, type: "EXPENSE", name: `Gider Kategorisi ${seq}`, isActive },
  });
}

async function seedProject(owner: SessionUser) {
  seq += 1;
  return createProject(owner, { code: `PB-${seq}`, name: `Bütçe Projesi ${seq}`, contractAmount: 0, estimatedBudget: 0 });
}

async function seedExpense(owner: SessionUser, projectId: string, categoryId: string, subtotal: number) {
  return createExpense(owner, { categoryId, projectId, description: "Proje gideri", issueDate: new Date(), subtotal, taxRate: 0 });
}

describe("project-budget-service — yetkilendirme", () => {
  it("OWNER bütçe kalemini listeleyebilir, oluşturabilir, güncelleyebilir ve silebilir", async () => {
    const { owner } = await createOwnerOrg();
    const project = await seedProject(owner);
    const category = await seedExpenseCategory(owner);

    const item = await createProjectBudgetItem(owner, { projectId: project.id, categoryId: category.id, plannedAmount: "10000" });
    const planning = await getProjectBudgetPlanning(owner, project.id);
    expect(planning.items).toHaveLength(1);

    const updated = await updateProjectBudgetItem(owner, { id: item.id, categoryId: category.id, plannedAmount: "12000" });
    expect(updated.plannedAmount.toString()).toBe("12000");

    await deleteProjectBudgetItem(owner, item.id);
    const afterDelete = await getProjectBudgetPlanning(owner, project.id);
    expect(afterDelete.items).toHaveLength(0);
  });

  it("ADMIN bütçe kalemini listeleyebilir, oluşturabilir, güncelleyebilir ve silebilir", async () => {
    const { owner } = await createOwnerOrg();
    const admin = await createOrgUser(owner.organizationId, "ADMIN");
    const project = await seedProject(owner);
    const category = await seedExpenseCategory(owner);

    const item = await createProjectBudgetItem(admin, { projectId: project.id, categoryId: category.id, plannedAmount: "5000" });
    await updateProjectBudgetItem(admin, { id: item.id, categoryId: category.id, plannedAmount: "6000" });
    await deleteProjectBudgetItem(admin, item.id);
    const planning = await getProjectBudgetPlanning(admin, project.id);
    expect(planning.items).toHaveLength(0);
  });

  it("FINANCE seçilen izin kuralına göre listeleyebilir, oluşturabilir, güncelleyebilir VE silebilir (canManageExpenses/canCancelFinancialRecord ile aynı ilke)", async () => {
    const { owner } = await createOwnerOrg();
    const finance = await createOrgUser(owner.organizationId, "FINANCE");
    const project = await seedProject(owner);
    const category = await seedExpenseCategory(owner);

    const item = await createProjectBudgetItem(finance, { projectId: project.id, categoryId: category.id, plannedAmount: "3000" });
    await updateProjectBudgetItem(finance, { id: item.id, categoryId: category.id, plannedAmount: "3500" });
    await deleteProjectBudgetItem(finance, item.id);
    const planning = await getProjectBudgetPlanning(finance, project.id);
    expect(planning.items).toHaveLength(0);
  });

  it("atanmış PROJECT_MANAGER bütçe bilgisini görüntüleyebilir ama oluşturamaz/güncelleyemez/silemez (salt-okunur karar)", async () => {
    const { owner } = await createOwnerOrg();
    const pm = await createOrgUser(owner.organizationId, "PROJECT_MANAGER");
    const project = await seedProject(owner);
    const category = await seedExpenseCategory(owner);
    await assignProjectMember(owner, project.id, pm.id);
    const item = await createProjectBudgetItem(owner, { projectId: project.id, categoryId: category.id, plannedAmount: "8000" });

    const planning = await getProjectBudgetPlanning(pm, project.id);
    expect(planning.items).toHaveLength(1);
    expect(planning.canManage).toBe(false);

    await expect(
      createProjectBudgetItem(pm, { projectId: project.id, categoryId: category.id, plannedAmount: "1000" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      updateProjectBudgetItem(pm, { id: item.id, categoryId: category.id, plannedAmount: "1000" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(deleteProjectBudgetItem(pm, item.id)).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("atanmamış PROJECT_MANAGER projeye hiç erişemez (NOT_FOUND, sızıntı yok)", async () => {
    const { owner } = await createOwnerOrg();
    const pm = await createOrgUser(owner.organizationId, "PROJECT_MANAGER");
    const project = await seedProject(owner);
    const category = await seedExpenseCategory(owner);

    await expect(getProjectBudgetPlanning(pm, project.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      createProjectBudgetItem(pm, { projectId: project.id, categoryId: category.id, plannedAmount: "1000" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("cross-tenant proje ID'sine erişim NOT_FOUND ile reddedilir", async () => {
    const { owner: ownerA } = await createOwnerOrg();
    const { owner: ownerB } = await createOwnerOrg();
    const projectB = await seedProject(ownerB);
    const categoryB = await seedExpenseCategory(ownerB);

    await expect(getProjectBudgetPlanning(ownerA, projectB.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      createProjectBudgetItem(ownerA, { projectId: projectB.id, categoryId: categoryB.id, plannedAmount: "1000" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("cross-tenant bütçe kalemi ID'si güncelleme/silmede NOT_FOUND ile reddedilir", async () => {
    const { owner: ownerA } = await createOwnerOrg();
    const { owner: ownerB } = await createOwnerOrg();
    const projectB = await seedProject(ownerB);
    const categoryB = await seedExpenseCategory(ownerB);
    const itemB = await createProjectBudgetItem(ownerB, { projectId: projectB.id, categoryId: categoryB.id, plannedAmount: "1000" });

    await expect(
      updateProjectBudgetItem(ownerA, { id: itemB.id, categoryId: categoryB.id, plannedAmount: "2000" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(deleteProjectBudgetItem(ownerA, itemB.id)).rejects.toMatchObject({ code: "NOT_FOUND" });

    const stillThere = await db.projectBudgetItem.findUnique({ where: { id: itemB.id } });
    expect(stillThere).not.toBeNull();
  });

  it("cross-tenant kategori ID'si bütçe kalemi oluşturmada NOT_FOUND ile reddedilir", async () => {
    const { owner: ownerA } = await createOwnerOrg();
    const { owner: ownerB } = await createOwnerOrg();
    const projectA = await seedProject(ownerA);
    const categoryB = await seedExpenseCategory(ownerB);

    await expect(
      createProjectBudgetItem(ownerA, { projectId: projectA.id, categoryId: categoryB.id, plannedAmount: "1000" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("project-budget-service — çözümlenmiş proje tenant koruması (YF-407-R1)", () => {
  it("eşleşen organizasyonla çağrıldığında normal şekilde çalışır", async () => {
    const { owner } = await createOwnerOrg();
    const project = await seedProject(owner);
    const category = await seedExpenseCategory(owner);
    await createProjectBudgetItem(owner, { projectId: project.id, categoryId: category.id, plannedAmount: "1000" });

    const resolved = await getProjectForUser(owner, project.id);
    const planning = await getProjectBudgetPlanningForResolvedProject(owner, resolved);
    expect(planning.items).toHaveLength(1);
    expect(planning.totalPlannedBudget).toBe("1000");
  });

  it("başka bir organizasyona ait sahte çözümlenmiş proje objesiyle çağrılırsa NOT_FOUND döner ve ek proje sorgusu yapılmaz", async () => {
    const { owner: ownerA } = await createOwnerOrg();
    const { owner: ownerB } = await createOwnerOrg();
    const projectB = await seedProject(ownerB);
    const resolvedProjectB = await getProjectForUser(ownerB, projectB.id);

    // `vi.spyOn(db.project, "findFirst").mockRestore()` bu ortamda Prisma
    // delegate metodunu kalıcı olarak bozuyor (restore sonrası
    // "db.project.findFirst is not a function") — dosyadaki sonraki tüm
    // testler etkileniyor. Bu yüzden doğrudan özellik atamasıyla manuel
    // mock/restore kullanılıyor (vi.spyOn'un descriptor tabanlı restore
    // mekanizmasına güvenilmiyor).
    const originalFindFirst = db.project.findFirst;
    const findFirstMock = vi.fn((...args: Parameters<typeof originalFindFirst>) => originalFindFirst.apply(db.project, args));
    db.project.findFirst = findFirstMock as unknown as typeof originalFindFirst;
    try {
      await expect(getProjectBudgetPlanningForResolvedProject(ownerA, resolvedProjectB)).rejects.toMatchObject({
        code: "NOT_FOUND",
      });
      expect(findFirstMock).not.toHaveBeenCalled();
    } finally {
      db.project.findFirst = originalFindFirst;
    }
  });
});

describe("project-budget-service — doğrulama", () => {
  it("geçerli ondalık tutar kabul edilir", () => {
    expect(plannedAmountSchema.safeParse("1234.56").success).toBe(true);
    expect(plannedAmountSchema.safeParse("1234").success).toBe(true);
  });

  it("negatif tutar reddedilir", () => {
    const result = plannedAmountSchema.safeParse("-50");
    expect(result.success).toBe(false);
  });

  it("sıfır tutar reddedilir (bütçe kaldırma silme/deaktif etme ile yapılmalıdır)", () => {
    expect(plannedAmountSchema.safeParse("0").success).toBe(false);
    expect(plannedAmountSchema.safeParse("0.00").success).toBe(false);
  });

  it("2'den fazla ondalık basamak reddedilir", () => {
    expect(plannedAmountSchema.safeParse("100.123").success).toBe(false);
  });

  it("üstel gösterim reddedilir", () => {
    expect(plannedAmountSchema.safeParse("1e5").success).toBe(false);
    expect(plannedAmountSchema.safeParse("1E5").success).toBe(false);
  });

  it("yerelleştirilmiş/virgüllü girdi ve NaN/Infinity reddedilir", () => {
    expect(plannedAmountSchema.safeParse("1.234,56").success).toBe(false);
    expect(plannedAmountSchema.safeParse("NaN").success).toBe(false);
    expect(plannedAmountSchema.safeParse("Infinity").success).toBe(false);
  });

  it("Decimal(18,2) kolon sınırını aşan tutar reddedilir", () => {
    // 17 haneli tam sayı kısmı — kolon en fazla 16 hane tam kısım destekler.
    expect(plannedAmountSchema.safeParse("12345678901234567").success).toBe(false);
    expect(plannedAmountSchema.safeParse("1234567890123456").success).toBe(true); // 16 hane sınırda kabul
  });

  it("Türkçe doğrulama mesajları döner", () => {
    const result = createProjectBudgetItemSchema.safeParse({ projectId: "p1", categoryId: "", plannedAmount: "100" });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toBe("Kategori zorunludur");
    }
  });

  it("pasif kategori için yeni bütçe kalemi eklenemez", async () => {
    const { owner } = await createOwnerOrg();
    const project = await seedProject(owner);
    const inactiveCategory = await seedExpenseCategory(owner, false);

    await expect(
      createProjectBudgetItem(owner, { projectId: project.id, categoryId: inactiveCategory.id, plannedAmount: "1000" }),
    ).rejects.toMatchObject({ code: "VALIDATION" });
  });

  it("mevcut bir kalemin kategorisi sonradan pasifleşirse kalem hâlâ görüntülenebilir", async () => {
    const { owner } = await createOwnerOrg();
    const project = await seedProject(owner);
    const category = await seedExpenseCategory(owner, true);
    await createProjectBudgetItem(owner, { projectId: project.id, categoryId: category.id, plannedAmount: "1000" });

    await db.transactionCategory.update({ where: { id: category.id }, data: { isActive: false } });

    const planning = await getProjectBudgetPlanning(owner, project.id);
    expect(planning.items).toHaveLength(1);
    expect(planning.items[0].categoryIsActive).toBe(false);
  });

  it("eksik/geçersiz proje veya kategori ID'si güvenli şekilde reddedilir", async () => {
    const { owner } = await createOwnerOrg();
    const project = await seedProject(owner);

    await expect(
      createProjectBudgetItem(owner, { projectId: "olmayan-proje", categoryId: "olmayan-kategori", plannedAmount: "1000" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      createProjectBudgetItem(owner, { projectId: project.id, categoryId: "olmayan-kategori", plannedAmount: "1000" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("project-budget-service — veri davranışı", () => {
  it("bütçe kalemi oluşturma, tutar güncelleme, kategori güncelleme ve silme sonrası proje toplamları doğru güncellenir", async () => {
    const { owner } = await createOwnerOrg();
    const project = await seedProject(owner);
    const categoryA = await seedExpenseCategory(owner);
    const categoryB = await seedExpenseCategory(owner);
    await seedExpense(owner, project.id, categoryA.id, 4000);

    const item = await createProjectBudgetItem(owner, { projectId: project.id, categoryId: categoryA.id, plannedAmount: "10000" });
    let planning = await getProjectBudgetPlanning(owner, project.id);
    expect(planning.totalPlannedBudget).toBe("10000");
    expect(planning.totalRealizedExpense).toBe("4000");
    expect(planning.totalRemainingBudget).toBe("6000");
    expect(planning.status).toBe("NORMAL");

    await updateProjectBudgetItem(owner, { id: item.id, categoryId: categoryA.id, plannedAmount: "4500" });
    planning = await getProjectBudgetPlanning(owner, project.id);
    expect(planning.totalPlannedBudget).toBe("4500");
    expect(planning.status).toBe("CRITICAL"); // 4000/4500 ≈ %88.9

    await updateProjectBudgetItem(owner, { id: item.id, categoryId: categoryB.id, plannedAmount: "4500" });
    planning = await getProjectBudgetPlanning(owner, project.id);
    expect(planning.items[0].categoryId).toBe(categoryB.id);
    expect(planning.items[0].realizedExpense).toBe("0"); // artık categoryB'ye bağlı, o kategoride gider yok

    await deleteProjectBudgetItem(owner, item.id);
    planning = await getProjectBudgetPlanning(owner, project.id);
    expect(planning.items).toHaveLength(0);
    expect(planning.totalPlannedBudget).toBe("0");
    expect(planning.status).toBe("NO_BUDGET");
  });

  it("gerçekleşen gider mevcut finans servisinden (categoryDistribution) yeniden kullanılır, tekrar hesaplanmaz", async () => {
    const { owner } = await createOwnerOrg();
    const project = await seedProject(owner);
    const category = await seedExpenseCategory(owner);
    await seedExpense(owner, project.id, category.id, 1234.56);
    await createProjectBudgetItem(owner, { projectId: project.id, categoryId: category.id, plannedAmount: "5000" });

    const planning = await getProjectBudgetPlanning(owner, project.id);
    expect(planning.items[0].realizedExpense).toBe("1234.56");
  });

  it("iptal edilmiş gider kaydı gerçekleşen gideri şişirmez", async () => {
    const { owner } = await createOwnerOrg();
    const project = await seedProject(owner);
    const category = await seedExpenseCategory(owner);
    const expense = await seedExpense(owner, project.id, category.id, 7000);
    await createProjectBudgetItem(owner, { projectId: project.id, categoryId: category.id, plannedAmount: "10000" });
    await cancelExpense(owner, { id: expense.id, reason: "Hatalı kayıt" });

    const planning = await getProjectBudgetPlanning(owner, project.id);
    expect(planning.items[0].realizedExpense).toBe("0");
  });

  it("hesaplar arası transfer gerçekleşen gidere dahil edilmez", async () => {
    const { owner } = await createOwnerOrg();
    const project = await seedProject(owner);
    const category = await seedExpenseCategory(owner);
    await createProjectBudgetItem(owner, { projectId: project.id, categoryId: category.id, plannedAmount: "5000" });

    const accountA = await createAccount(owner, { name: `Hesap A ${key()}`, type: "BANK", openingBalance: 100000, currency: "TRY" });
    const accountB = await createAccount(owner, { name: `Hesap B ${key()}`, type: "BANK", openingBalance: 0, currency: "TRY" });
    await createTransfer(owner, {
      fromAccountId: accountA.id,
      toAccountId: accountB.id,
      amount: 20000,
      transferDate: new Date(),
      idempotencyKey: key(),
    });

    const planning = await getProjectBudgetPlanning(owner, project.id);
    expect(planning.totalRealizedExpense).toBe("0");
  });

  it("tahsilat/ödeme ters kaydı (reversal) kaydedilen gideri değiştirmez — gerçekleşen gider tahsil durumundan bağımsızdır", async () => {
    const { owner } = await createOwnerOrg();
    const project = await seedProject(owner);
    const category = await seedExpenseCategory(owner);
    const expense = await seedExpense(owner, project.id, category.id, 9000);
    await createProjectBudgetItem(owner, { projectId: project.id, categoryId: category.id, plannedAmount: "10000" });

    const account = await createAccount(owner, { name: `Hesap ${key()}`, type: "BANK", openingBalance: 100000, currency: "TRY" });
    const settlement = await createSettlement(owner, {
      transactionId: expense.id,
      financialAccountId: account.id,
      amount: 9000,
      settlementDate: new Date(),
      paymentMethod: "HAVALE_EFT",
      idempotencyKey: key(),
    });

    let planning = await getProjectBudgetPlanning(owner, project.id);
    expect(planning.items[0].realizedExpense).toBe("9000");

    await cancelSettlement(owner, { id: settlement.id, reason: "Yanlış hesaptan ödendi" });

    planning = await getProjectBudgetPlanning(owner, project.id);
    expect(planning.items[0].realizedExpense).toBe("9000"); // kayıtlı gider tahsilat/ters kayıttan etkilenmez
  });

  it("aynı proje/kategori için mükerrer oluşturma çakışma (conflict) döner", async () => {
    const { owner } = await createOwnerOrg();
    const project = await seedProject(owner);
    const category = await seedExpenseCategory(owner);
    await createProjectBudgetItem(owner, { projectId: project.id, categoryId: category.id, plannedAmount: "1000" });

    await expect(
      createProjectBudgetItem(owner, { projectId: project.id, categoryId: category.id, plannedAmount: "2000" }),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    const rows = await db.projectBudgetItem.findMany({ where: { projectId: project.id, categoryId: category.id } });
    expect(rows).toHaveLength(1);
  });

  it("eşzamanlı mükerrer oluşturma denemesinde yalnızca bir kayıt kalıcı olur", async () => {
    const { owner } = await createOwnerOrg();
    const project = await seedProject(owner);
    const category = await seedExpenseCategory(owner);

    const results = await Promise.allSettled([
      createProjectBudgetItem(owner, { projectId: project.id, categoryId: category.id, plannedAmount: "1000" }),
      createProjectBudgetItem(owner, { projectId: project.id, categoryId: category.id, plannedAmount: "1500" }),
    ]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);

    const rows = await db.projectBudgetItem.findMany({ where: { projectId: project.id, categoryId: category.id } });
    expect(rows).toHaveLength(1);
  });

  it("başka bir kalemin zaten kullandığı kategoriye güncelleme çakışma döner", async () => {
    const { owner } = await createOwnerOrg();
    const project = await seedProject(owner);
    const categoryA = await seedExpenseCategory(owner);
    const categoryB = await seedExpenseCategory(owner);
    await createProjectBudgetItem(owner, { projectId: project.id, categoryId: categoryA.id, plannedAmount: "1000" });
    const itemB = await createProjectBudgetItem(owner, { projectId: project.id, categoryId: categoryB.id, plannedAmount: "2000" });

    await expect(
      updateProjectBudgetItem(owner, { id: itemB.id, categoryId: categoryA.id, plannedAmount: "2000" }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("bütçe kalemi silme işlemi işlem kayıtlarını ve tahsilatları etkilemez", async () => {
    const { owner } = await createOwnerOrg();
    const project = await seedProject(owner);
    const category = await seedExpenseCategory(owner);
    const expense = await seedExpense(owner, project.id, category.id, 3000);
    const account = await createAccount(owner, { name: `Hesap ${key()}`, type: "BANK", openingBalance: 100000, currency: "TRY" });
    await createSettlement(owner, {
      transactionId: expense.id,
      financialAccountId: account.id,
      amount: 3000,
      settlementDate: new Date(),
      paymentMethod: "HAVALE_EFT",
      idempotencyKey: key(),
    });
    const item = await createProjectBudgetItem(owner, { projectId: project.id, categoryId: category.id, plannedAmount: "5000" });

    await deleteProjectBudgetItem(owner, item.id);

    const transactionStillExists = await db.financialTransaction.findUnique({ where: { id: expense.id } });
    const settlementsStillExist = await db.settlement.findMany({ where: { transactionId: expense.id } });
    expect(transactionStillExists).not.toBeNull();
    expect(settlementsStillExist).toHaveLength(1);
  });

  it("bütçe kalemi silindiğinde YF-404 proje×kategori bütçe agregasyonundan da kalkar", async () => {
    const { owner } = await createOwnerOrg();
    const project = await seedProject(owner);
    const category = await seedExpenseCategory(owner);
    await seedExpense(owner, project.id, category.id, 2000);
    const item = await createProjectBudgetItem(owner, { projectId: project.id, categoryId: category.id, plannedAmount: "5000" });

    const beforeReport = await getBudgetReport(owner, {});
    const beforeRow = beforeReport.projectCategoryMatrix.find((r) => r.projectId === project.id && r.categoryId === category.id);
    expect(beforeRow?.plannedAmount).toBe("5000");

    await deleteProjectBudgetItem(owner, item.id);

    const afterReport = await getBudgetReport(owner, {});
    const afterRow = afterReport.projectCategoryMatrix.find((r) => r.projectId === project.id && r.categoryId === category.id);
    expect(afterRow?.plannedAmount).toBeNull();
  });

  it("bütçe durumu eşikleri Normal/Kritik/Bütçe Aşıldı olarak doğru kalır", async () => {
    const { owner } = await createOwnerOrg();
    const project = await seedProject(owner);
    const normalCat = await seedExpenseCategory(owner);
    const criticalCat = await seedExpenseCategory(owner);
    const overCat = await seedExpenseCategory(owner);

    await seedExpense(owner, project.id, normalCat.id, 5000); // %50
    await seedExpense(owner, project.id, criticalCat.id, 8500); // %85
    await seedExpense(owner, project.id, overCat.id, 12000); // %120

    await createProjectBudgetItem(owner, { projectId: project.id, categoryId: normalCat.id, plannedAmount: "10000" });
    await createProjectBudgetItem(owner, { projectId: project.id, categoryId: criticalCat.id, plannedAmount: "10000" });
    await createProjectBudgetItem(owner, { projectId: project.id, categoryId: overCat.id, plannedAmount: "10000" });

    const planning = await getProjectBudgetPlanning(owner, project.id);
    const byCategory = new Map(planning.items.map((i) => [i.categoryId, i.status]));
    expect(byCategory.get(normalCat.id)).toBe("NORMAL");
    expect(byCategory.get(criticalCat.id)).toBe("CRITICAL");
    expect(byCategory.get(overCat.id)).toBe("OVER_BUDGET");
  });

  it("çoklu kalemli projede tek sınırlı sorgu kümesiyle doğru sonuç döner (N+1 yok — kod yapısı gereği)", async () => {
    const { owner } = await createOwnerOrg();
    const project = await seedProject(owner);
    const categories = await Promise.all(Array.from({ length: 6 }, () => seedExpenseCategory(owner)));
    await Promise.all(categories.map((c, i) => seedExpense(owner, project.id, c.id, (i + 1) * 100)));
    await Promise.all(categories.map((c, i) => createProjectBudgetItem(owner, { projectId: project.id, categoryId: c.id, plannedAmount: String((i + 1) * 200) })));

    const planning = await getProjectBudgetPlanning(owner, project.id);
    expect(planning.items).toHaveLength(6);
    for (const [i, c] of categories.entries()) {
      const row = planning.items.find((it) => it.categoryId === c.id);
      expect(row?.realizedExpense).toBe(String((i + 1) * 100));
      expect(row?.plannedAmount).toBe(String((i + 1) * 200));
    }
  });
});

describe("project-budget-service — audit log", () => {
  it("yetkisiz mutasyon denemesi audit log kaydı oluşturmaz", async () => {
    const { owner } = await createOwnerOrg();
    const pm = await createOrgUser(owner.organizationId, "PROJECT_MANAGER");
    const project = await seedProject(owner);
    const category = await seedExpenseCategory(owner);
    await assignProjectMember(owner, project.id, pm.id);

    const before = await db.auditLog.count();
    await expect(
      createProjectBudgetItem(pm, { projectId: project.id, categoryId: category.id, plannedAmount: "1000" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    const after = await db.auditLog.count();
    expect(after).toBe(before);
  });

  it("başarılı oluşturma/güncelleme/silme beklenen audit kaydını yazar", async () => {
    const { owner } = await createOwnerOrg();
    const project = await seedProject(owner);
    const category = await seedExpenseCategory(owner);

    const item = await createProjectBudgetItem(owner, { projectId: project.id, categoryId: category.id, plannedAmount: "1000" });
    const createLog = await db.auditLog.findFirst({ where: { action: "project_budget_item.create", entityId: item.id } });
    expect(createLog?.organizationId).toBe(owner.organizationId);

    await updateProjectBudgetItem(owner, { id: item.id, categoryId: category.id, plannedAmount: "2000" });
    const updateLog = await db.auditLog.findFirst({ where: { action: "project_budget_item.update", entityId: item.id } });
    expect(updateLog).not.toBeNull();

    await deleteProjectBudgetItem(owner, item.id);
    const deleteLog = await db.auditLog.findFirst({ where: { action: "project_budget_item.delete", entityId: item.id } });
    expect(deleteLog).not.toBeNull();
  });
});

describe("project-budget-service — Prisma hataları dışa sızmaz", () => {
  it("benzersizlik ihlali ham Prisma hatası değil, temiz bir ServiceError olarak döner", async () => {
    const { owner } = await createOwnerOrg();
    const project = await seedProject(owner);
    const category = await seedExpenseCategory(owner);
    await createProjectBudgetItem(owner, { projectId: project.id, categoryId: category.id, plannedAmount: "1000" });

    try {
      await createProjectBudgetItem(owner, { projectId: project.id, categoryId: category.id, plannedAmount: "2000" });
      throw new Error("beklenen hata fırlatılmadı");
    } catch (err) {
      expect(err).toMatchObject({ code: "CONFLICT" });
      expect((err as Error).message).toBe("Bu proje için bu kategoride zaten bir bütçe kalemi var");
      expect((err as Error).message).not.toMatch(/P2002|prisma/i);
    }
  });
});
