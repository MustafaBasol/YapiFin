import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { cleanDatabase, createOwnerOrg, createOrgUser } from "./helpers";
import { createExpense, cancelExpense } from "@/server/services/transaction-service";
import { createAccount } from "@/server/services/account-service";
import { createSettlement } from "@/server/services/settlement-service";
import { createProject, assignProjectMember, setProjectStatus } from "@/server/services/project-service";
import { getBudgetReport, getBudgetStatus } from "@/server/services/budget-report-service";
import type { SessionUser } from "@/lib/auth/session";

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
  return `bg-test-${seq}-${Math.floor(Math.random() * 1e9)}`;
}

async function seedCategory(owner: SessionUser, name?: string) {
  seq += 1;
  return db.transactionCategory.create({
    data: { organizationId: owner.organizationId, type: "EXPENSE", name: name ?? `Kategori ${seq}` },
  });
}

async function seedExpense(owner: SessionUser, opts: { subtotal: number; projectId?: string; categoryId?: string; issueDate?: Date }) {
  const categoryId = opts.categoryId ?? (await seedCategory(owner)).id;
  return createExpense(owner, {
    categoryId,
    projectId: opts.projectId,
    description: "Test gideri",
    issueDate: opts.issueDate ?? new Date(),
    subtotal: opts.subtotal,
    taxRate: 0,
  });
}

async function seedAccount(owner: SessionUser, openingBalance = 0) {
  seq += 1;
  return createAccount(owner, {
    name: `Hesap ${seq}`,
    type: "BANK",
    bankName: undefined,
    iban: undefined,
    openingBalance,
    currency: "TRY",
  });
}

async function settle(owner: SessionUser, transactionId: string, accountId: string, amount: number) {
  return createSettlement(owner, {
    transactionId,
    financialAccountId: accountId,
    amount,
    settlementDate: new Date(),
    paymentMethod: "HAVALE_EFT",
    idempotencyKey: key(),
  });
}

async function seedActiveProject(owner: SessionUser, estimatedBudget: number) {
  seq += 1;
  const project = await createProject(owner, {
    code: `P-${seq}`,
    name: `Proje ${seq}`,
    contractAmount: 0,
    estimatedBudget,
  });
  await setProjectStatus(owner, project.id, "ACTIVE");
  return project;
}

const NO_FILTER = { projectId: undefined, categoryId: undefined };

describe("getBudgetStatus — merkezi eşik fonksiyonu", () => {
  it("bütçe girilmemişse (<=0) NO_BUDGET döner", () => {
    expect(getBudgetStatus(0, 5000)).toBe("NO_BUDGET");
    expect(getBudgetStatus(-100, 0)).toBe("NO_BUDGET");
  });

  it("kullanım %80'in altındaysa NORMAL döner", () => {
    expect(getBudgetStatus(100_000, 79_999)).toBe("NORMAL");
  });

  it("kullanım %80–%99.99 arasındaysa CRITICAL döner", () => {
    expect(getBudgetStatus(100_000, 80_000)).toBe("CRITICAL");
    expect(getBudgetStatus(100_000, 99_999)).toBe("CRITICAL");
  });

  it("kullanım tam %100 ise OVER_BUDGET döner", () => {
    expect(getBudgetStatus(100_000, 100_000)).toBe("OVER_BUDGET");
  });

  it("kullanım %100'ü aşıyorsa OVER_BUDGET döner", () => {
    expect(getBudgetStatus(100_000, 150_000)).toBe("OVER_BUDGET");
  });
});

describe("budget-report-service — organizasyon", () => {
  it("boş organizasyonda tüm metrikler sıfır/boştur (empty state)", async () => {
    const { owner } = await createOwnerOrg();
    const data = await getBudgetReport(owner, NO_FILTER);
    expect(data.scope).toBe("ORGANIZATION");
    expect(data.metrics.totalProjectBudget).toBe("0");
    expect(data.metrics.projectsOverBudgetCount).toBe(0);
    expect(data.projectComparison).toHaveLength(0);
    expect(data.categoryAnalysis).toHaveLength(0);
    expect(data.projectsWithoutBudget).toHaveLength(0);
  });

  it("proje bütçe kullanım oranı ve durumu doğru hesaplanır", async () => {
    const { owner } = await createOwnerOrg();
    const project = await seedActiveProject(owner, 100_000);
    await seedExpense(owner, { subtotal: 45_000, projectId: project.id });

    const data = await getBudgetReport(owner, NO_FILTER);
    const row = data.projectComparison.find((r) => r.projectId === project.id);
    expect(row?.usagePercentage).toBe("45");
    expect(row?.status).toBe("NORMAL");
  });

  it("kalan bütçe = bütçe − gerçekleşen gider", async () => {
    const { owner } = await createOwnerOrg();
    const project = await seedActiveProject(owner, 100_000);
    await seedExpense(owner, { subtotal: 30_000, projectId: project.id });

    const data = await getBudgetReport(owner, NO_FILTER);
    const row = data.projectComparison.find((r) => r.projectId === project.id);
    expect(row?.remainingBudget).toBe("70000");
  });

  it("bütçeyi aşan proje aşım tutarı ve yüzdesiyle listelenir", async () => {
    const { owner } = await createOwnerOrg();
    const project = await seedActiveProject(owner, 100_000);
    await seedExpense(owner, { subtotal: 130_000, projectId: project.id });

    const data = await getBudgetReport(owner, NO_FILTER);
    const row = data.overBudgetProjects.find((r) => r.projectId === project.id);
    expect(row).toBeDefined();
    expect(row?.overrunAmount).toBe("30000");
    expect(row?.overrunPercentage).toBe("30");
  });

  it("kritik seviyeye yaklaşan proje 'bütçesi kritik' listesinde görünür", async () => {
    const { owner } = await createOwnerOrg();
    const project = await seedActiveProject(owner, 100_000);
    await seedExpense(owner, { subtotal: 85_000, projectId: project.id });

    const data = await getBudgetReport(owner, NO_FILTER);
    expect(data.metrics.projectsAtRiskCount).toBe(1);
    expect(data.atRiskProjects.map((r) => r.projectId)).toContain(project.id);
  });

  it("bütçesi girilmemiş aktif proje ayrı listede görünür ve ortalama kullanımdan hariç tutulur", async () => {
    const { owner } = await createOwnerOrg();
    const withBudget = await seedActiveProject(owner, 100_000);
    const withoutBudget = await seedActiveProject(owner, 0);
    await seedExpense(owner, { subtotal: 50_000, projectId: withBudget.id });
    await seedExpense(owner, { subtotal: 20_000, projectId: withoutBudget.id });

    const data = await getBudgetReport(owner, NO_FILTER);
    expect(data.metrics.projectsWithoutBudgetCount).toBe(1);
    expect(data.projectsWithoutBudget.map((r) => r.projectId)).toContain(withoutBudget.id);
    // Ortalama yalnızca bütçeli projeyi (%50) içermeli, bütçesiz projeyi değil.
    expect(data.metrics.averageBudgetUtilization).toBe("50");
  });

  it("iptal edilen gider kaydı bütçe kullanımına dahil edilmez", async () => {
    const { owner } = await createOwnerOrg();
    const project = await seedActiveProject(owner, 100_000);
    const expense = await seedExpense(owner, { subtotal: 40_000, projectId: project.id });
    await cancelExpense(owner, { id: expense.id, reason: "Test iptali" });

    const data = await getBudgetReport(owner, NO_FILTER);
    const row = data.projectComparison.find((r) => r.projectId === project.id);
    expect(row?.realizedExpenses).toBe("0");
    expect(row?.status).toBe("NORMAL");
  });

  it("ödenen gider, kaydedilen giderden ayrı tutulur (parçalı ödeme)", async () => {
    const { owner } = await createOwnerOrg();
    const account = await seedAccount(owner, 200_000);
    const project = await seedActiveProject(owner, 100_000);
    const expense = await seedExpense(owner, { subtotal: 60_000, projectId: project.id });
    await settle(owner, expense.id, account.id, 25_000);

    const data = await getBudgetReport(owner, NO_FILTER);
    const row = data.projectComparison.find((r) => r.projectId === project.id);
    expect(row?.realizedExpenses).toBe("60000");
    expect(row?.paidExpenses).toBe("25000");
  });

  it("kategori toplamları ve toplam içindeki pay doğru hesaplanır", async () => {
    const { owner } = await createOwnerOrg();
    const project = await seedActiveProject(owner, 0);
    const catA = await seedCategory(owner, "Malzeme");
    const catB = await seedCategory(owner, "İşçilik");
    await seedExpense(owner, { subtotal: 75_000, projectId: project.id, categoryId: catA.id });
    await seedExpense(owner, { subtotal: 25_000, projectId: project.id, categoryId: catB.id });

    const data = await getBudgetReport(owner, NO_FILTER);
    const rowA = data.categoryAnalysis.find((c) => c.categoryId === catA.id);
    const rowB = data.categoryAnalysis.find((c) => c.categoryId === catB.id);
    expect(rowA?.recordedExpense).toBe("75000");
    expect(rowA?.shareOfTotal).toBe("75");
    expect(rowB?.shareOfTotal).toBe("25");
    expect(rowA?.transactionCount).toBe(1);
    expect(rowA?.projectCount).toBe(1);
  });

  it("proje × kategori matrisi doğru gruplanır", async () => {
    const { owner } = await createOwnerOrg();
    const projectA = await seedActiveProject(owner, 0);
    const projectB = await seedActiveProject(owner, 0);
    const category = await seedCategory(owner, "Beton");
    await seedExpense(owner, { subtotal: 10_000, projectId: projectA.id, categoryId: category.id });
    await seedExpense(owner, { subtotal: 20_000, projectId: projectB.id, categoryId: category.id });

    const data = await getBudgetReport(owner, NO_FILTER);
    const rowA = data.projectCategoryMatrix.find((r) => r.projectId === projectA.id && r.categoryId === category.id);
    const rowB = data.projectCategoryMatrix.find((r) => r.projectId === projectB.id && r.categoryId === category.id);
    expect(rowA?.amount).toBe("10000");
    expect(rowB?.amount).toBe("20000");
  });

  it("aylık kategori trendi son 12 ayı kapsar ve mevcut ay tutarını içerir", async () => {
    const { owner } = await createOwnerOrg();
    const project = await seedActiveProject(owner, 0);
    const category = await seedCategory(owner, "Nakliye");
    await seedExpense(owner, { subtotal: 12_345, projectId: project.id, categoryId: category.id });

    const data = await getBudgetReport(owner, { projectId: undefined, categoryId: category.id });
    expect(data.categoryMonthlyTrend).toHaveLength(1);
    const series = data.categoryMonthlyTrend[0];
    expect(series.points).toHaveLength(12);
    const total = series.points.reduce((sum, p) => sum + p.amount, 0);
    expect(total).toBe(12345);
  });

  it("Decimal hassasiyeti korunur (kuruş bazlı hesaplama)", async () => {
    const { owner } = await createOwnerOrg();
    const project = await seedActiveProject(owner, 33_333.33);
    await seedExpense(owner, { subtotal: 11_111.11, projectId: project.id });

    const data = await getBudgetReport(owner, NO_FILTER);
    const row = data.projectComparison.find((r) => r.projectId === project.id);
    expect(row?.realizedExpenses).toBe("11111.11");
    expect(row?.remainingBudget).toBe("22222.22");
  });

  it("organizasyonlar arası veri sızıntısı olmaz (tenant izolasyonu)", async () => {
    const { owner: ownerA } = await createOwnerOrg();
    const { owner: ownerB } = await createOwnerOrg();
    const projectA = await seedActiveProject(ownerA, 50_000);
    await seedActiveProject(ownerB, 90_000);
    await seedExpense(ownerA, { subtotal: 10_000, projectId: projectA.id });

    const data = await getBudgetReport(ownerA, NO_FILTER);
    expect(data.projectComparison).toHaveLength(1);
    expect(data.projectComparison[0].projectId).toBe(projectA.id);
  });

  it("FINANCE rolü organizasyon genelinde bütçe raporunu görebilir", async () => {
    const { owner, organizationId } = await createOwnerOrg();
    const finance = await createOrgUser(organizationId, "FINANCE");
    await seedActiveProject(owner, 40_000);

    const data = await getBudgetReport(finance, NO_FILTER);
    expect(data.scope).toBe("ORGANIZATION");
    expect(data.projectComparison).toHaveLength(1);
  });

  it("ADMIN organizasyon genelinde bütçe raporunu görebilir", async () => {
    const { owner, organizationId } = await createOwnerOrg();
    const admin = await createOrgUser(organizationId, "ADMIN");
    const project = await seedActiveProject(owner, 80_000);
    await seedExpense(owner, { subtotal: 20_000, projectId: project.id });

    const data = await getBudgetReport(admin, NO_FILTER);
    expect(data.scope).toBe("ORGANIZATION");
    expect(data.projectComparison).toHaveLength(1);
    expect(data.metrics.totalRealizedExpenses).toBe("20000");
  });

  it("başka bir organizasyona ait proje ID'si bütçe filtresi olarak kabul edilmez (tenant izolasyonu)", async () => {
    const { owner: ownerA } = await createOwnerOrg();
    const { owner: ownerB } = await createOwnerOrg();
    const projectA = await seedActiveProject(ownerA, 50_000);
    const projectB = await seedActiveProject(ownerB, 90_000);
    await seedExpense(ownerA, { subtotal: 15_000, projectId: projectA.id });
    await seedExpense(ownerB, { subtotal: 70_000, projectId: projectB.id });

    const data = await getBudgetReport(ownerA, { projectId: projectB.id, categoryId: undefined });
    // Yabancı proje kimliği filtreyi düşürür; rapor A'nın tamamına döner ve
    // B'nin gideri toplamlara SIZMAZ.
    expect(data.projectFilter).toBeNull();
    expect(data.projectComparison.map((r) => r.projectId)).toEqual([projectA.id]);
    expect(data.metrics.totalRealizedExpenses).toBe("15000");
  });
});

describe("budget-report-service — PROJECT_MANAGER", () => {
  it("atanmış projesi olmayan PROJECT_MANAGER boş bir rapor görür", async () => {
    const { organizationId } = await createOwnerOrg();
    const pm = await createOrgUser(organizationId, "PROJECT_MANAGER");

    const data = await getBudgetReport(pm, NO_FILTER);
    expect(data.scope).toBe("PROJECT_MANAGER");
    if (data.scope !== "PROJECT_MANAGER") return;
    expect(data.hasAssignedProjects).toBe(false);
    expect(data.projectComparison).toHaveLength(0);
  });

  it("PROJECT_MANAGER yalnızca atandığı projelerin bütçe verilerini görür", async () => {
    const { owner, organizationId } = await createOwnerOrg();
    const pm = await createOrgUser(organizationId, "PROJECT_MANAGER");
    const assigned = await seedActiveProject(owner, 60_000);
    const unassigned = await seedActiveProject(owner, 60_000);
    await assignProjectMember(owner, assigned.id, pm.id);
    await seedExpense(owner, { subtotal: 20_000, projectId: assigned.id });
    await seedExpense(owner, { subtotal: 55_000, projectId: unassigned.id });

    const data = await getBudgetReport(pm, NO_FILTER);
    if (data.scope !== "PROJECT_MANAGER") throw new Error("beklenmeyen kapsam");
    expect(data.hasAssignedProjects).toBe(true);
    expect(data.projectComparison).toHaveLength(1);
    expect(data.projectComparison[0].projectId).toBe(assigned.id);
    expect(data.metrics.totalRealizedExpenses).toBe("20000");
  });

  it("birden fazla projeye atanmış PROJECT_MANAGER tüm atandığı projelerin bütçe toplamını görür", async () => {
    const { owner, organizationId } = await createOwnerOrg();
    const pm = await createOrgUser(organizationId, "PROJECT_MANAGER");
    const first = await seedActiveProject(owner, 60_000);
    const second = await seedActiveProject(owner, 40_000);
    const unassigned = await seedActiveProject(owner, 500_000);
    await assignProjectMember(owner, first.id, pm.id);
    await assignProjectMember(owner, second.id, pm.id);
    await seedExpense(owner, { subtotal: 10_000, projectId: first.id });
    await seedExpense(owner, { subtotal: 5_000, projectId: second.id });
    await seedExpense(owner, { subtotal: 300_000, projectId: unassigned.id });

    const data = await getBudgetReport(pm, NO_FILTER);
    if (data.scope !== "PROJECT_MANAGER") throw new Error("beklenmeyen kapsam");
    expect(data.projectComparison).toHaveLength(2);
    expect(data.metrics.totalProjectBudget).toBe("100000");
    expect(data.metrics.totalRealizedExpenses).toBe("15000");
  });

  it("PROJECT_MANAGER atandığı projeyi filtre olarak verebilir", async () => {
    const { owner, organizationId } = await createOwnerOrg();
    const pm = await createOrgUser(organizationId, "PROJECT_MANAGER");
    const first = await seedActiveProject(owner, 60_000);
    const second = await seedActiveProject(owner, 40_000);
    await assignProjectMember(owner, first.id, pm.id);
    await assignProjectMember(owner, second.id, pm.id);
    await seedExpense(owner, { subtotal: 10_000, projectId: first.id });
    await seedExpense(owner, { subtotal: 5_000, projectId: second.id });

    const data = await getBudgetReport(pm, { projectId: first.id, categoryId: undefined });
    if (data.scope !== "PROJECT_MANAGER") throw new Error("beklenmeyen kapsam");
    expect(data.projectFilter?.id).toBe(first.id);
    expect(data.projectComparison.map((r) => r.projectId)).toEqual([first.id]);
    expect(data.metrics.totalRealizedExpenses).toBe("10000");
  });

  it("PROJECT_MANAGER, atanmadığı bir projeyi filtre olarak veremez (fail closed)", async () => {
    const { owner, organizationId } = await createOwnerOrg();
    const pm = await createOrgUser(organizationId, "PROJECT_MANAGER");
    const assigned = await seedActiveProject(owner, 60_000);
    const unassigned = await seedActiveProject(owner, 200_000);
    await assignProjectMember(owner, assigned.id, pm.id);
    await seedExpense(owner, { subtotal: 12_000, projectId: assigned.id });
    await seedExpense(owner, { subtotal: 150_000, projectId: unassigned.id });

    const data = await getBudgetReport(pm, { projectId: unassigned.id, categoryId: undefined });
    if (data.scope !== "PROJECT_MANAGER") throw new Error("beklenmeyen kapsam");
    // Filtre düşer, kapsam atanmış projelerde kalır; atanmayan projenin gideri
    // rapora DÜŞMEZ.
    expect(data.projectFilter).toBeNull();
    expect(data.projectComparison.map((r) => r.projectId)).toEqual([assigned.id]);
    expect(data.metrics.totalRealizedExpenses).toBe("12000");
  });
});
