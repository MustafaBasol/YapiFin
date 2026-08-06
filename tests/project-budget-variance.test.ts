import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { cleanDatabase, createOwnerOrg, createOrgUser } from "./helpers";
import { createProject, assignProjectMember } from "@/server/services/project-service";
import { createExpense, cancelExpense } from "@/server/services/transaction-service";
import { createAccount } from "@/server/services/account-service";
import { createSettlement } from "@/server/services/settlement-service";
import { createTransfer } from "@/server/services/transfer-service";
import { createProjectBudgetItem } from "@/server/services/project-budget-service";
import { getProjectBudgetVarianceReport } from "@/server/services/project-budget-variance-service";
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

const DAY_MS = 24 * 60 * 60 * 1000;
function daysAgo(n: number) {
  return new Date(Date.now() - n * DAY_MS);
}
function daysFromNow(n: number) {
  return new Date(Date.now() + n * DAY_MS);
}

let seq = 0;
function key() {
  seq += 1;
  return `pbv-test-${seq}-${Math.floor(Math.random() * 1e9)}`;
}

async function seedExpenseCategory(owner: SessionUser) {
  seq += 1;
  return db.transactionCategory.create({
    data: { organizationId: owner.organizationId, type: "EXPENSE", name: `Sapma Kategorisi ${seq}`, isActive: true },
  });
}

async function seedProject(owner: SessionUser, overrides: { startDate?: Date; plannedEndDate?: Date } = {}) {
  seq += 1;
  return createProject(owner, {
    code: `PBV-${seq}`,
    name: `Sapma Projesi ${seq}`,
    contractAmount: 0,
    estimatedBudget: 0,
    ...overrides,
  });
}

async function seedExpense(owner: SessionUser, projectId: string, categoryId: string, subtotal: number, issueDate?: Date) {
  return createExpense(owner, {
    categoryId,
    projectId,
    description: "Proje gideri",
    issueDate: issueDate ?? new Date(),
    subtotal,
    taxRate: 0,
  });
}

describe("project-budget-variance-service — sapma metrikleri", () => {
  it("normal sapma: gerçekleşen planlananın altında", async () => {
    const { owner } = await createOwnerOrg();
    const project = await seedProject(owner);
    const category = await seedExpenseCategory(owner);
    await seedExpense(owner, project.id, category.id, 4000);
    await createProjectBudgetItem(owner, { projectId: project.id, categoryId: category.id, plannedAmount: "10000" });

    const report = await getProjectBudgetVarianceReport(owner, project.id);
    expect(report.totalPlannedBudget).toBe("10000");
    expect(report.totalRealizedExpense).toBe("4000");
    expect(report.varianceAmount).toBe("-6000");
    expect(report.variancePercentage).toBe("-60");
    expect(report.status).toBe("NORMAL");
  });

  it("kritik eşik: gerçekleşen planlanan bütçenin %80'ini aşar ama bütçeyi aşmaz", async () => {
    const { owner } = await createOwnerOrg();
    const project = await seedProject(owner);
    const category = await seedExpenseCategory(owner);
    await seedExpense(owner, project.id, category.id, 4000);
    await createProjectBudgetItem(owner, { projectId: project.id, categoryId: category.id, plannedAmount: "4500" });

    const report = await getProjectBudgetVarianceReport(owner, project.id);
    expect(report.status).toBe("CRITICAL");
    expect(report.varianceAmount).toBe("-500");
  });

  it("bütçe aşımı: gerçekleşen planlanan bütçeyi aşar", async () => {
    const { owner } = await createOwnerOrg();
    const project = await seedProject(owner);
    const category = await seedExpenseCategory(owner);
    await seedExpense(owner, project.id, category.id, 6000);
    await createProjectBudgetItem(owner, { projectId: project.id, categoryId: category.id, plannedAmount: "5000" });

    const report = await getProjectBudgetVarianceReport(owner, project.id);
    expect(report.status).toBe("OVER_BUDGET");
    expect(report.varianceAmount).toBe("1000");
    expect(report.variancePercentage).toBe("20");
  });

  it("kategori bazlı sapma: her kategori kendi planlanan/gerçekleşen/sapma değerini taşır", async () => {
    const { owner } = await createOwnerOrg();
    const project = await seedProject(owner);
    const categoryA = await seedExpenseCategory(owner);
    const categoryB = await seedExpenseCategory(owner);
    await seedExpense(owner, project.id, categoryA.id, 3000);
    await seedExpense(owner, project.id, categoryB.id, 1000);
    await createProjectBudgetItem(owner, { projectId: project.id, categoryId: categoryA.id, plannedAmount: "2000" });
    await createProjectBudgetItem(owner, { projectId: project.id, categoryId: categoryB.id, plannedAmount: "5000" });

    const report = await getProjectBudgetVarianceReport(owner, project.id);
    const rowA = report.items.find((i) => i.categoryId === categoryA.id)!;
    const rowB = report.items.find((i) => i.categoryId === categoryB.id)!;

    expect(rowA.varianceAmount).toBe("1000");
    expect(rowA.variancePercentage).toBe("50");
    expect(rowA.status).toBe("OVER_BUDGET");

    expect(rowB.varianceAmount).toBe("-4000");
    expect(rowB.variancePercentage).toBe("-80");
    expect(rowB.status).toBe("NORMAL");
  });

  it("iptal edilmiş gider kaydı sapma hesabına dahil edilmez", async () => {
    const { owner } = await createOwnerOrg();
    const project = await seedProject(owner);
    const category = await seedExpenseCategory(owner);
    const expense = await seedExpense(owner, project.id, category.id, 7000);
    await createProjectBudgetItem(owner, { projectId: project.id, categoryId: category.id, plannedAmount: "10000" });
    await cancelExpense(owner, { id: expense.id, reason: "Hatalı kayıt" });

    const report = await getProjectBudgetVarianceReport(owner, project.id);
    expect(report.totalRealizedExpense).toBe("0");
    expect(report.varianceAmount).toBe("-10000");
  });

  it("hesaplar arası transfer sapma hesabına dahil edilmez", async () => {
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

    const report = await getProjectBudgetVarianceReport(owner, project.id);
    expect(report.totalRealizedExpense).toBe("0");
    expect(report.varianceAmount).toBe("-5000");
  });

  it("parçalı ödeme gerçekleşen gideri (ve dolayısıyla sapmayı) değiştirmez", async () => {
    const { owner } = await createOwnerOrg();
    const project = await seedProject(owner);
    const category = await seedExpenseCategory(owner);
    const expense = await seedExpense(owner, project.id, category.id, 9000);
    await createProjectBudgetItem(owner, { projectId: project.id, categoryId: category.id, plannedAmount: "10000" });

    const account = await createAccount(owner, { name: `Hesap ${key()}`, type: "BANK", openingBalance: 100000, currency: "TRY" });
    await createSettlement(owner, {
      transactionId: expense.id,
      financialAccountId: account.id,
      amount: 3000,
      settlementDate: new Date(),
      paymentMethod: "HAVALE_EFT",
      idempotencyKey: key(),
    });

    const report = await getProjectBudgetVarianceReport(owner, project.id);
    expect(report.totalRealizedExpense).toBe("9000");
    expect(report.varianceAmount).toBe("-1000");
  });
});

describe("project-budget-variance-service — tamamlanma tahmini", () => {
  it("başlangıç tarihi olmayan projede forecastAvailable=false (NO_START_DATE)", async () => {
    const { owner } = await createOwnerOrg();
    const project = await seedProject(owner);
    const category = await seedExpenseCategory(owner);
    await seedExpense(owner, project.id, category.id, 1000);
    await createProjectBudgetItem(owner, { projectId: project.id, categoryId: category.id, plannedAmount: "5000" });

    const report = await getProjectBudgetVarianceReport(owner, project.id);
    expect(report.forecast.forecastAvailable).toBe(false);
    expect(report.forecast.unavailableReason).toBe("NO_START_DATE");
  });

  it("henüz başlamamış projede forecastAvailable=false (NOT_STARTED)", async () => {
    const { owner } = await createOwnerOrg();
    const project = await seedProject(owner, { startDate: daysFromNow(5) });
    const category = await seedExpenseCategory(owner);
    await createProjectBudgetItem(owner, { projectId: project.id, categoryId: category.id, plannedAmount: "5000" });

    const report = await getProjectBudgetVarianceReport(owner, project.id);
    expect(report.forecast.forecastAvailable).toBe(false);
    expect(report.forecast.unavailableReason).toBe("NOT_STARTED");
  });

  it("başlangıçtan bu yana geçen süre sıfırsa forecastAvailable=false (NO_ELAPSED_TIME)", async () => {
    const { owner } = await createOwnerOrg();
    const project = await seedProject(owner, { startDate: new Date() });
    const category = await seedExpenseCategory(owner);
    await createProjectBudgetItem(owner, { projectId: project.id, categoryId: category.id, plannedAmount: "5000" });

    const report = await getProjectBudgetVarianceReport(owner, project.id);
    expect(report.forecast.forecastAvailable).toBe(false);
    expect(report.forecast.unavailableReason).toBe("NO_ELAPSED_TIME");
  });

  it("gider olmayan projede güvenli empty state (NO_EXPENSE), sapma metrikleri de hata vermez", async () => {
    const { owner } = await createOwnerOrg();
    const project = await seedProject(owner, { startDate: daysAgo(10) });
    const category = await seedExpenseCategory(owner);
    await createProjectBudgetItem(owner, { projectId: project.id, categoryId: category.id, plannedAmount: "5000" });

    const report = await getProjectBudgetVarianceReport(owner, project.id);
    expect(report.totalRealizedExpense).toBe("0");
    expect(report.varianceAmount).toBe("-5000");
    expect(report.items[0].realizedExpense).toBe("0");
    expect(report.forecast.forecastAvailable).toBe(false);
    expect(report.forecast.unavailableReason).toBe("NO_EXPENSE");
  });

  it("planlanan bütçe girilmemiş projede forecastAvailable=false (NO_BUDGET)", async () => {
    const { owner } = await createOwnerOrg();
    const project = await seedProject(owner, { startDate: daysAgo(10) });
    const category = await seedExpenseCategory(owner);
    await seedExpense(owner, project.id, category.id, 1000);

    const report = await getProjectBudgetVarianceReport(owner, project.id);
    expect(report.forecast.forecastAvailable).toBe(false);
    expect(report.forecast.unavailableReason).toBe("NO_BUDGET");
  });

  it("bitiş tarihi olan projede tahmini toplam gider ve tahmini aşım/tasarruf hesaplanır", async () => {
    const { owner } = await createOwnerOrg();
    const project = await seedProject(owner, { startDate: daysAgo(10), plannedEndDate: daysAgo(10 - 30) });
    const category = await seedExpenseCategory(owner);
    await seedExpense(owner, project.id, category.id, 5000);
    await createProjectBudgetItem(owner, { projectId: project.id, categoryId: category.id, plannedAmount: "20000" });

    const report = await getProjectBudgetVarianceReport(owner, project.id);
    expect(report.forecast.forecastAvailable).toBe(true);
    expect(report.forecast.elapsedDays).toBe(10);
    expect(report.forecast.dailyBurnRate).toBe("500");
    expect(report.forecast.projectedTotalExpenseAvailable).toBe(true);
    expect(report.forecast.projectedTotalExpense).toBe("15000");
    expect(report.forecast.projectedOverrunOrSavings).toBe("-5000");
    expect(report.forecast.estimatedDaysRemainingOnBudget).toBe(30);
  });

  it("bitiş tarihi olmayan projede yalnızca bütçenin tahmini kaç gün yeteceği hesaplanır", async () => {
    const { owner } = await createOwnerOrg();
    const project = await seedProject(owner, { startDate: daysAgo(10) });
    const category = await seedExpenseCategory(owner);
    await seedExpense(owner, project.id, category.id, 5000);
    await createProjectBudgetItem(owner, { projectId: project.id, categoryId: category.id, plannedAmount: "20000" });

    const report = await getProjectBudgetVarianceReport(owner, project.id);
    expect(report.forecast.forecastAvailable).toBe(true);
    expect(report.forecast.projectedTotalExpenseAvailable).toBe(false);
    expect(report.forecast.projectedTotalExpense).toBeNull();
    expect(report.forecast.projectedOverrunOrSavings).toBeNull();
    expect(report.forecast.estimatedDaysRemainingOnBudget).toBe(30);
  });

  it("bütçe zaten tükenmiş/aşılmışsa kalan gün 0 döner (negatif gün üretilmez)", async () => {
    const { owner } = await createOwnerOrg();
    const project = await seedProject(owner, { startDate: daysAgo(10) });
    const category = await seedExpenseCategory(owner);
    await seedExpense(owner, project.id, category.id, 12000);
    await createProjectBudgetItem(owner, { projectId: project.id, categoryId: category.id, plannedAmount: "10000" });

    const report = await getProjectBudgetVarianceReport(owner, project.id);
    expect(report.forecast.forecastAvailable).toBe(true);
    expect(report.forecast.estimatedDaysRemainingOnBudget).toBe(0);
  });

  it("Decimal hassasiyeti: küsuratlı tutarlarda sapma yüzdesi doğru yuvarlanır", async () => {
    const { owner } = await createOwnerOrg();
    const project = await seedProject(owner);
    const category = await seedExpenseCategory(owner);
    await seedExpense(owner, project.id, category.id, 333.33);
    await createProjectBudgetItem(owner, { projectId: project.id, categoryId: category.id, plannedAmount: "1000" });

    const report = await getProjectBudgetVarianceReport(owner, project.id);
    expect(report.items[0].realizedExpense).toBe("333.33");
    expect(report.items[0].varianceAmount).toBe("-666.67");
    expect(report.items[0].variancePercentage).toBe("-66.67");
  });
});

describe("project-budget-variance-service — yetkilendirme ve tenant izolasyonu", () => {
  it("atanmış PROJECT_MANAGER sapma raporunu görüntüleyebilir", async () => {
    const { owner } = await createOwnerOrg();
    const pm = await createOrgUser(owner.organizationId, "PROJECT_MANAGER");
    const project = await seedProject(owner);
    const category = await seedExpenseCategory(owner);
    await createProjectBudgetItem(owner, { projectId: project.id, categoryId: category.id, plannedAmount: "1000" });
    await assignProjectMember(owner, project.id, pm.id);

    const report = await getProjectBudgetVarianceReport(pm, project.id);
    expect(report.totalPlannedBudget).toBe("1000");
  });

  it("atanmamış PROJECT_MANAGER sapma raporuna erişemez (NOT_FOUND)", async () => {
    const { owner } = await createOwnerOrg();
    const pm = await createOrgUser(owner.organizationId, "PROJECT_MANAGER");
    const project = await seedProject(owner);

    await expect(getProjectBudgetVarianceReport(pm, project.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("başka organizasyonun proje ID'sine erişim NOT_FOUND döner (cross-tenant izolasyonu)", async () => {
    const { owner: ownerA } = await createOwnerOrg();
    const { owner: ownerB } = await createOwnerOrg();
    const projectB = await seedProject(ownerB);

    await expect(getProjectBudgetVarianceReport(ownerA, projectB.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("project-budget-variance-service — performans (N+1 yok)", () => {
  it("proje kalem sayısından bağımsız olarak tek proje sorgusu ve tek bütçe kalemi sorgusu çalıştırır", async () => {
    const { owner } = await createOwnerOrg();
    const project = await seedProject(owner, { startDate: daysAgo(10) });
    const categories = await Promise.all(Array.from({ length: 5 }, () => seedExpenseCategory(owner)));
    for (const [i, category] of categories.entries()) {
      await seedExpense(owner, project.id, category.id, 100 * (i + 1));
      await createProjectBudgetItem(owner, { projectId: project.id, categoryId: category.id, plannedAmount: String(1000 * (i + 1)) });
    }

    // `vi.spyOn(...).mockRestore()` bu ortamda Prisma delegate metodunu kalıcı
    // olarak bozuyor (restore sonrası "... is not a function") — dosyadaki
    // sonraki testler etkileniyor. Bu yüzden doğrudan özellik atamasıyla
    // manuel mock/restore kullanılıyor (vi.spyOn'un descriptor tabanlı
    // restore mekanizmasına güvenilmiyor).
    const originalProjectFindFirst = db.project.findFirst;
    const originalBudgetItemFindMany = db.projectBudgetItem.findMany;
    const findFirstMock = vi.fn((...args: Parameters<typeof originalProjectFindFirst>) =>
      originalProjectFindFirst.apply(db.project, args),
    );
    const findManyMock = vi.fn((...args: Parameters<typeof originalBudgetItemFindMany>) =>
      originalBudgetItemFindMany.apply(db.projectBudgetItem, args),
    );
    db.project.findFirst = findFirstMock as unknown as typeof originalProjectFindFirst;
    db.projectBudgetItem.findMany = findManyMock as unknown as typeof originalBudgetItemFindMany;

    try {
      const report = await getProjectBudgetVarianceReport(owner, project.id);

      expect(report.items).toHaveLength(5);
      expect(findFirstMock).toHaveBeenCalledTimes(1);
      expect(findManyMock).toHaveBeenCalledTimes(1);
    } finally {
      db.project.findFirst = originalProjectFindFirst;
      db.projectBudgetItem.findMany = originalBudgetItemFindMany;
    }
  });
});
