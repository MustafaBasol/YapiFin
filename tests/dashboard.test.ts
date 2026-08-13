import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { cleanDatabase, createOwnerOrg, createOrgUser } from "./helpers";
import { createIncome, createExpense, cancelIncome, cancelExpense } from "@/server/services/transaction-service";
import { createAccount } from "@/server/services/account-service";
import { createSettlement, cancelSettlement } from "@/server/services/settlement-service";
import { createTransfer } from "@/server/services/transfer-service";
import { createProject, assignProjectMember } from "@/server/services/project-service";
import { getDashboardData, resolveActorProjectScope, resolveActorReportScope } from "@/server/services/dashboard-service";
import type { SessionUser } from "@/lib/auth/session";
import type { TransactionType } from "@prisma/client";

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
  return `dash-test-${seq}-${Math.floor(Math.random() * 1e9)}`;
}

async function seedCategory(owner: SessionUser, type: TransactionType) {
  seq += 1;
  return db.transactionCategory.create({
    data: { organizationId: owner.organizationId, type, name: `Kategori ${seq}` },
  });
}

async function seedIncome(
  owner: SessionUser,
  opts: { subtotal: number; projectId?: string; dueDate?: Date; issueDate?: Date; categoryId?: string },
) {
  const categoryId = opts.categoryId ?? (await seedCategory(owner, "INCOME")).id;
  return createIncome(owner, {
    categoryId,
    projectId: opts.projectId,
    description: "Test geliri",
    issueDate: opts.issueDate ?? new Date(),
    dueDate: opts.dueDate,
    subtotal: opts.subtotal,
    taxRate: 0,
  });
}

async function seedExpense(
  owner: SessionUser,
  opts: { subtotal: number; projectId?: string; dueDate?: Date; issueDate?: Date; categoryId?: string },
) {
  const categoryId = opts.categoryId ?? (await seedCategory(owner, "EXPENSE")).id;
  return createExpense(owner, {
    categoryId,
    projectId: opts.projectId,
    description: "Test gideri",
    issueDate: opts.issueDate ?? new Date(),
    dueDate: opts.dueDate,
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

async function settle(
  owner: SessionUser,
  transactionId: string,
  accountId: string,
  amount: number,
  settlementDate = new Date(),
) {
  return createSettlement(owner, {
    transactionId,
    financialAccountId: accountId,
    amount,
    settlementDate,
    paymentMethod: "HAVALE_EFT",
    idempotencyKey: key(),
  });
}

const CURRENT_MONTH = { period: "CURRENT_MONTH" as const, projectId: undefined };
const LAST_12 = { period: "LAST_12_MONTHS" as const, projectId: undefined };

describe("dashboard-service — organizasyon", () => {
  it("boş organizasyonda tüm KPI'lar sıfır ve listeler boştur (empty state)", async () => {
    const { owner } = await createOwnerOrg();
    const data = await getDashboardData(owner, LAST_12);
    expect(data.scope).toBe("ORGANIZATION");
    if (data.scope !== "ORGANIZATION") return;
    expect(data.kpis.collectedIncome).toBe("0");
    expect(data.kpis.paidExpense).toBe("0");
    expect(data.kpis.netCashFlow).toBe("0");
    expect(data.kpis.openReceivable).toBe("0");
    expect(data.kpis.cashAndBankBalance).toBe("0");
    // Kayıt akışında otomatik oluşturulan "Ana Kasa" hesabının açılış hareketi
    // dışında (bkz. server/services/organization-service.ts) hiçbir hareket yoktur.
    expect(data.recentMovements).toHaveLength(1);
    expect(data.recentMovements[0].type).toBe("OPENING");
    expect(data.projectComparison).toHaveLength(0);
    expect(data.expenseCategoryDistribution).toHaveLength(0);
  });

  it("aylık seri her zaman 12 ay içerir, veri olmayan aylar sıfır görünür (zero-fill)", async () => {
    const { owner } = await createOwnerOrg();
    const data = await getDashboardData(owner, LAST_12);
    if (data.scope !== "ORGANIZATION") throw new Error("scope");
    expect(data.monthlySeries).toHaveLength(12);
    expect(new Set(data.monthlySeries.map((m) => m.key)).size).toBe(12);
    expect(data.monthlySeries.every((m) => m.collected === 0 && m.paid === 0 && m.net === 0)).toBe(true);
  });

  it("tahsil edilen ve ödenen tutarlar doğru toplanır, ondalık hassasiyet korunur", async () => {
    const { owner } = await createOwnerOrg();
    const account = await seedAccount(owner);
    const income = await seedIncome(owner, { subtotal: 1234.56 });
    await settle(owner, income.id, account.id, Number(income.totalAmount));

    const data = await getDashboardData(owner, CURRENT_MONTH);
    if (data.scope !== "ORGANIZATION") throw new Error("scope");
    expect(data.kpis.collectedIncome).toBe(income.totalAmount.toString());
    expect(data.kpis.netCashFlow).toBe(income.totalAmount.toString());
  });

  it("kısmi tahsilat sonrası açık alacak doğru hesaplanır", async () => {
    const { owner } = await createOwnerOrg();
    const account = await seedAccount(owner);
    const income = await seedIncome(owner, { subtotal: 100000 });
    await settle(owner, income.id, account.id, 40000);

    const data = await getDashboardData(owner, LAST_12);
    if (data.scope !== "ORGANIZATION") throw new Error("scope");
    expect(data.kpis.openReceivable).toBe("60000");
    expect(data.kpis.collectedIncome).toBe("40000");
  });

  it("kısmi ödeme sonrası açık borç doğru hesaplanır", async () => {
    const { owner } = await createOwnerOrg();
    const account = await seedAccount(owner, 100000);
    const expense = await seedExpense(owner, { subtotal: 50000 });
    await settle(owner, expense.id, account.id, 20000);

    const data = await getDashboardData(owner, LAST_12);
    if (data.scope !== "ORGANIZATION") throw new Error("scope");
    expect(data.kpis.openPayable).toBe("30000");
  });

  it("vadesi geçmiş ve kalan tutarı pozitif olan gelir vadesi geçen alacağa sayılır; gelecekteki vade sayılmaz", async () => {
    const { owner } = await createOwnerOrg();
    const past = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000);
    const future = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    await seedIncome(owner, { subtotal: 1000, dueDate: past });
    await seedIncome(owner, { subtotal: 2000, dueDate: future });

    const data = await getDashboardData(owner, LAST_12);
    if (data.scope !== "ORGANIZATION") throw new Error("scope");
    expect(data.kpis.overdueReceivable).toBe("1000");
    expect(data.kpis.openReceivable).toBe("3000");
  });

  it("vadesi geçmiş gider vadesi geçen borca sayılır", async () => {
    const { owner } = await createOwnerOrg();
    const past = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
    await seedExpense(owner, { subtotal: 500, dueDate: past });

    const data = await getDashboardData(owner, LAST_12);
    if (data.scope !== "ORGANIZATION") throw new Error("scope");
    expect(data.kpis.overduePayable).toBe("500");
  });

  it("iptal edilmiş gelir hiçbir toplamı etkilemez", async () => {
    const { owner } = await createOwnerOrg();
    const income = await seedIncome(owner, { subtotal: 5000 });
    await cancelIncome(owner, { id: income.id, reason: "Hatalı kayıt" });

    const data = await getDashboardData(owner, LAST_12);
    if (data.scope !== "ORGANIZATION") throw new Error("scope");
    expect(data.kpis.openReceivable).toBe("0");
    expect(data.kpis.overdueReceivable).toBe("0");
  });

  it("iptal edilmiş gider hiçbir toplamı etkilemez", async () => {
    const { owner } = await createOwnerOrg();
    const expense = await seedExpense(owner, { subtotal: 3000 });
    await cancelExpense(owner, { id: expense.id, reason: "Hatalı kayıt" });

    const data = await getDashboardData(owner, LAST_12);
    if (data.scope !== "ORGANIZATION") throw new Error("scope");
    expect(data.kpis.openPayable).toBe("0");
  });

  it("iptal edilen (ters kayıtlı) tahsilat toplam tahsilata dahil edilmez", async () => {
    const { owner } = await createOwnerOrg();
    const account = await seedAccount(owner);
    const income = await seedIncome(owner, { subtotal: 1000 });
    const settlement = await settle(owner, income.id, account.id, 1000);
    await cancelSettlement(owner, { id: settlement.id, reason: "Yanlış hesap" });

    const data = await getDashboardData(owner, LAST_12);
    if (data.scope !== "ORGANIZATION") throw new Error("scope");
    expect(data.kpis.collectedIncome).toBe("0");
    expect(data.kpis.openReceivable).toBe("1000");
    // Ters kayıt hareketi hesap bakiyesini de sıfıra döndürmeli (çift sayım yok).
    expect(data.kpis.cashAndBankBalance).toBe("0");
  });

  it("iptal edilen (ters kayıtlı) ödeme toplam ödemeye dahil edilmez", async () => {
    const { owner } = await createOwnerOrg();
    const account = await seedAccount(owner, 10000);
    const expense = await seedExpense(owner, { subtotal: 1000 });
    const settlement = await settle(owner, expense.id, account.id, 1000);
    await cancelSettlement(owner, { id: settlement.id, reason: "Yanlış hesap" });

    const data = await getDashboardData(owner, LAST_12);
    if (data.scope !== "ORGANIZATION") throw new Error("scope");
    expect(data.kpis.paidExpense).toBe("0");
    expect(data.kpis.cashAndBankBalance).toBe("10000");
  });

  it("hesaplar arası transfer organizasyon genel kasa/banka bakiyesini bozmaz", async () => {
    const { owner } = await createOwnerOrg();
    const accountA = await seedAccount(owner, 0);
    const accountB = await seedAccount(owner, 0);
    const income = await seedIncome(owner, { subtotal: 1000 });
    await settle(owner, income.id, accountA.id, 1000);
    await createTransfer(owner, {
      fromAccountId: accountA.id,
      toAccountId: accountB.id,
      amount: 400,
      transferDate: new Date(),
      description: "Test transfer",
      idempotencyKey: key(),
    });

    const data = await getDashboardData(owner, LAST_12);
    if (data.scope !== "ORGANIZATION") throw new Error("scope");
    expect(data.kpis.cashAndBankBalance).toBe("1000");
  });

  it("gider kategorisi dağılımı kategoriye göre doğru gruplanır", async () => {
    const { owner } = await createOwnerOrg();
    const catA = await seedCategory(owner, "EXPENSE");
    const catB = await seedCategory(owner, "EXPENSE");
    await seedExpense(owner, { subtotal: 1000, categoryId: catA.id });
    await seedExpense(owner, { subtotal: 500, categoryId: catA.id });
    await seedExpense(owner, { subtotal: 700, categoryId: catB.id });

    const data = await getDashboardData(owner, LAST_12);
    if (data.scope !== "ORGANIZATION") throw new Error("scope");
    const byId = new Map(data.expenseCategoryDistribution.map((c) => [c.categoryId, c.amount]));
    expect(byId.get(catA.id)).toBe("1500");
    expect(byId.get(catB.id)).toBe("700");
  });

  it("son hareketler en fazla 15 kayıt döner ve tarihe göre azalan sıralanır", async () => {
    const { owner } = await createOwnerOrg();
    const account = await seedAccount(owner, 0);
    for (let i = 0; i < 20; i++) {
      const income = await seedIncome(owner, { subtotal: 10 });
      await settle(owner, income.id, account.id, 10, new Date(Date.now() - i * 60_000));
    }

    const data = await getDashboardData(owner, LAST_12);
    if (data.scope !== "ORGANIZATION") throw new Error("scope");
    expect(data.recentMovements.length).toBeLessThanOrEqual(15);
    const times = data.recentMovements.map((m) => m.occurredAt.getTime());
    const sorted = [...times].sort((a, b) => b - a);
    expect(times).toEqual(sorted);
  });

  it("FINANCE organizasyon geneli dashboard'a erişebilir", async () => {
    const { owner } = await createOwnerOrg();
    const finance = await createOrgUser(owner.organizationId, "FINANCE");
    const data = await getDashboardData(finance, LAST_12);
    expect(data.scope).toBe("ORGANIZATION");
  });

  it("ADMIN organizasyon geneli dashboard'a erişebilir", async () => {
    const { owner } = await createOwnerOrg();
    const admin = await createOrgUser(owner.organizationId, "ADMIN");
    const account = await seedAccount(owner, 0);
    const income = await seedIncome(owner, { subtotal: 4000 });
    await settle(owner, income.id, account.id, 4000);

    const data = await getDashboardData(admin, LAST_12);
    expect(data.scope).toBe("ORGANIZATION");
    if (data.scope !== "ORGANIZATION") throw new Error("scope");
    expect(data.kpis.collectedIncome).toBe("4000");
  });

  it("tenant izolasyonu: organizasyon A'nın verileri organizasyon B dashboard'unda görünmez", async () => {
    const { owner: ownerA } = await createOwnerOrg();
    const { owner: ownerB } = await createOwnerOrg();
    const accountA = await seedAccount(ownerA, 0);
    const incomeA = await seedIncome(ownerA, { subtotal: 5000 });
    await settle(ownerA, incomeA.id, accountA.id, 5000);

    const dataB = await getDashboardData(ownerB, LAST_12);
    if (dataB.scope !== "ORGANIZATION") throw new Error("scope");
    expect(dataB.kpis.collectedIncome).toBe("0");
    expect(dataB.kpis.cashAndBankBalance).toBe("0");
  });

  it("başka bir organizasyona ait proje ID'si dashboard filtresi olarak kabul edilmez (tenant izolasyonu)", async () => {
    const { owner: ownerA } = await createOwnerOrg();
    const { owner: ownerB } = await createOwnerOrg();
    const projectB = await createProject(ownerB, { code: "D-9", name: "B projesi", contractAmount: 0, estimatedBudget: 0 });
    const account = await seedAccount(ownerA, 0);
    const incomeA = await seedIncome(ownerA, { subtotal: 6000 });
    await settle(ownerA, incomeA.id, account.id, 6000);

    const data = await getDashboardData(ownerA, { period: "LAST_12_MONTHS", projectId: projectB.id });
    if (data.scope !== "ORGANIZATION") throw new Error("scope");
    // Yabancı proje kimliği filtreyi düşürür; aktör kendi organizasyonunun
    // tamamını görmeye devam eder — B'nin verisi hiçbir şekilde SIZMAZ.
    expect(data.projectFilter).toBeNull();
    expect(data.kpis.collectedIncome).toBe("6000");
  });
});

describe("dashboard-service — PROJECT_MANAGER", () => {
  it("atanmış projesi olmayan PROJECT_MANAGER boş bir dashboard görür", async () => {
    const { owner } = await createOwnerOrg();
    const pm = await createOrgUser(owner.organizationId, "PROJECT_MANAGER");
    const data = await getDashboardData(pm, LAST_12);
    expect(data.scope).toBe("PROJECT_MANAGER");
    if (data.scope !== "PROJECT_MANAGER") return;
    expect(data.hasAssignedProjects).toBe(false);
    expect(data.kpis.collectedIncome).toBe("0");
  });

  it("PROJECT_MANAGER yalnızca atandığı projenin toplamlarını görür, atanmadığı projeyi göremez", async () => {
    const { owner } = await createOwnerOrg();
    const pm = await createOrgUser(owner.organizationId, "PROJECT_MANAGER");
    const assigned = await createProject(owner, { code: "D-1", name: "Atanan", contractAmount: 0, estimatedBudget: 0 });
    const other = await createProject(owner, { code: "D-2", name: "Atanmayan", contractAmount: 0, estimatedBudget: 0 });
    await assignProjectMember(owner, assigned.id, pm.id);

    const account = await seedAccount(owner, 0);
    const incomeAssigned = await seedIncome(owner, { subtotal: 1000, projectId: assigned.id });
    await settle(owner, incomeAssigned.id, account.id, 1000);
    const incomeOther = await seedIncome(owner, { subtotal: 9000, projectId: other.id });
    await settle(owner, incomeOther.id, account.id, 9000);

    const data = await getDashboardData(pm, LAST_12);
    if (data.scope !== "PROJECT_MANAGER") throw new Error("scope");
    expect(data.hasAssignedProjects).toBe(true);
    expect(data.kpis.collectedIncome).toBe("1000");
    expect(data.projectComparison.map((p) => p.projectId)).toEqual([assigned.id]);
  });

  it("PROJECT_MANAGER DTO'sunda organizasyon geneli kasa/banka bakiyesi alanı bulunmaz", async () => {
    const { owner } = await createOwnerOrg();
    const pm = await createOrgUser(owner.organizationId, "PROJECT_MANAGER");
    const project = await createProject(owner, { code: "D-3", name: "Proje", contractAmount: 0, estimatedBudget: 0 });
    await assignProjectMember(owner, project.id, pm.id);

    const data = await getDashboardData(pm, LAST_12);
    if (data.scope !== "PROJECT_MANAGER") throw new Error("scope");
    expect("cashAndBankBalance" in data.kpis).toBe(false);
    expect("activeCustomerCount" in data.kpis).toBe(false);
  });

  it("birden fazla projeye atanmış PROJECT_MANAGER tüm atandığı projelerin toplamını görür", async () => {
    const { owner } = await createOwnerOrg();
    const pm = await createOrgUser(owner.organizationId, "PROJECT_MANAGER");
    const first = await createProject(owner, { code: "D-4", name: "Birinci", contractAmount: 0, estimatedBudget: 0 });
    const second = await createProject(owner, { code: "D-5", name: "İkinci", contractAmount: 0, estimatedBudget: 0 });
    const other = await createProject(owner, { code: "D-6", name: "Atanmayan", contractAmount: 0, estimatedBudget: 0 });
    await assignProjectMember(owner, first.id, pm.id);
    await assignProjectMember(owner, second.id, pm.id);

    const account = await seedAccount(owner, 0);
    const incomeFirst = await seedIncome(owner, { subtotal: 1000, projectId: first.id });
    await settle(owner, incomeFirst.id, account.id, 1000);
    const incomeSecond = await seedIncome(owner, { subtotal: 2500, projectId: second.id });
    await settle(owner, incomeSecond.id, account.id, 2500);
    const incomeOther = await seedIncome(owner, { subtotal: 90_000, projectId: other.id });
    await settle(owner, incomeOther.id, account.id, 90_000);

    const data = await getDashboardData(pm, LAST_12);
    if (data.scope !== "PROJECT_MANAGER") throw new Error("scope");
    expect(data.kpis.collectedIncome).toBe("3500");
    expect(data.kpis.totalProjectCount).toBe(2);
    expect(new Set(data.projectComparison.map((p) => p.projectId))).toEqual(new Set([first.id, second.id]));
  });

  it("PROJECT_MANAGER atandığı projeyi filtre olarak verebilir ve toplamlar o projeye daralır", async () => {
    const { owner } = await createOwnerOrg();
    const pm = await createOrgUser(owner.organizationId, "PROJECT_MANAGER");
    const first = await createProject(owner, { code: "D-7", name: "Birinci", contractAmount: 0, estimatedBudget: 0 });
    const second = await createProject(owner, { code: "D-8", name: "İkinci", contractAmount: 0, estimatedBudget: 0 });
    await assignProjectMember(owner, first.id, pm.id);
    await assignProjectMember(owner, second.id, pm.id);

    const account = await seedAccount(owner, 0);
    const incomeFirst = await seedIncome(owner, { subtotal: 1000, projectId: first.id });
    await settle(owner, incomeFirst.id, account.id, 1000);
    const incomeSecond = await seedIncome(owner, { subtotal: 2500, projectId: second.id });
    await settle(owner, incomeSecond.id, account.id, 2500);

    const data = await getDashboardData(pm, { period: "LAST_12_MONTHS", projectId: first.id });
    if (data.scope !== "PROJECT_MANAGER") throw new Error("scope");
    expect(data.projectFilter?.id).toBe(first.id);
    expect(data.kpis.collectedIncome).toBe("1000");
  });

  it("PROJECT_MANAGER, atanmadığı bir projeyi filtre olarak veremez (fail closed)", async () => {
    const { owner } = await createOwnerOrg();
    const pm = await createOrgUser(owner.organizationId, "PROJECT_MANAGER");
    const assigned = await createProject(owner, { code: "D-10", name: "Atanan", contractAmount: 0, estimatedBudget: 0 });
    const unassigned = await createProject(owner, { code: "D-11", name: "Atanmayan", contractAmount: 0, estimatedBudget: 0 });
    await assignProjectMember(owner, assigned.id, pm.id);

    const account = await seedAccount(owner, 0);
    const incomeAssigned = await seedIncome(owner, { subtotal: 1200, projectId: assigned.id });
    await settle(owner, incomeAssigned.id, account.id, 1200);
    const incomeUnassigned = await seedIncome(owner, { subtotal: 45_000, projectId: unassigned.id });
    await settle(owner, incomeUnassigned.id, account.id, 45_000);

    const data = await getDashboardData(pm, { period: "LAST_12_MONTHS", projectId: unassigned.id });
    if (data.scope !== "PROJECT_MANAGER") throw new Error("scope");
    // Filtre düşer ve kapsam atanmış projelerde kalır; atanmayan projenin
    // tutarı toplamlara DÜŞMEZ.
    expect(data.projectFilter).toBeNull();
    expect(data.kpis.collectedIncome).toBe("1200");
  });
});

describe("YF-702-F7 — kanonik aktör proje kapsamı", () => {
  it("organizasyon geneli roller (OWNER/ADMIN/FINANCE) için kapsam undefined döner", async () => {
    const { owner, organizationId } = await createOwnerOrg();
    const admin = await createOrgUser(organizationId, "ADMIN");
    const finance = await createOrgUser(organizationId, "FINANCE");

    expect(await resolveActorProjectScope(owner)).toBeUndefined();
    expect(await resolveActorProjectScope(admin)).toBeUndefined();
    expect(await resolveActorProjectScope(finance)).toBeUndefined();
  });

  it("atandığı projeleri olan PROJECT_MANAGER için yalnızca o proje kimlikleri döner", async () => {
    const { owner, organizationId } = await createOwnerOrg();
    const pm = await createOrgUser(organizationId, "PROJECT_MANAGER");
    const first = await createProject(owner, { code: "S-1", name: "Birinci", contractAmount: 0, estimatedBudget: 0 });
    const second = await createProject(owner, { code: "S-2", name: "İkinci", contractAmount: 0, estimatedBudget: 0 });
    await createProject(owner, { code: "S-3", name: "Atanmayan", contractAmount: 0, estimatedBudget: 0 });
    await assignProjectMember(owner, first.id, pm.id);
    await assignProjectMember(owner, second.id, pm.id);

    const scope = await resolveActorProjectScope(pm);
    expect(new Set(scope)).toEqual(new Set([first.id, second.id]));
  });

  it("atanmış projesi olmayan PROJECT_MANAGER için BOŞ DİZİ döner, undefined DÖNMEZ (fail closed)", async () => {
    const { owner, organizationId } = await createOwnerOrg();
    await createProject(owner, { code: "S-4", name: "Atanmayan", contractAmount: 0, estimatedBudget: 0 });
    const pm = await createOrgUser(organizationId, "PROJECT_MANAGER");

    const scope = await resolveActorProjectScope(pm);
    expect(scope).toEqual([]);
    expect(scope).not.toBeUndefined();
  });

  it("başka organizasyondaki üyelik kaydı kapsama SIZMAZ", async () => {
    const { organizationId: organizationIdA } = await createOwnerOrg();
    const { owner: ownerB, organizationId: organizationIdB } = await createOwnerOrg();
    const pmA = await createOrgUser(organizationIdA, "PROJECT_MANAGER");
    const projectB = await createProject(ownerB, { code: "S-5", name: "B projesi", contractAmount: 0, estimatedBudget: 0 });

    // Servis katmanı organizasyonlar arası atama YAPMAZ (bkz.
    // `assignProjectMember`); sızıntı senaryosunu üretmek için üyelik kaydı
    // doğrudan yazılır — kapsam çözümlemesinin `organizationId` süzgecine
    // gerçekten güvenilebildiği ancak böyle kanıtlanabilir.
    await db.projectMember.create({
      data: { organizationId: organizationIdB, projectId: projectB.id, userId: pmA.id },
    });

    expect(await resolveActorProjectScope(pmA)).toEqual([]);
  });

  it("resolveActorReportScope: atanmış projesi olmayan PROJECT_MANAGER'da moneyScope BOŞ DİZİDİR, undefined DEĞİLDİR (fail closed)", async () => {
    const { owner, organizationId } = await createOwnerOrg();
    // Organizasyonda proje VAR; kapsamın boş kalmasının tek nedeni atama
    // olmaması olmalı — "veri yok" ile "kapsam yok" karışmasın.
    await createProject(owner, { code: "S-9", name: "Atanmayan", contractAmount: 0, estimatedBudget: 0 });
    const pm = await createOrgUser(organizationId, "PROJECT_MANAGER");

    const scope = await resolveActorReportScope(pm, undefined);
    expect(scope.scope).toBe("PROJECT_MANAGER");
    expect(scope.assignedProjectIds).toEqual([]);
    // Kritik değişmez: BOŞ DİZİ tüketicilerde sıfır sonuç üretir; `undefined`
    // ise "proje süzgeci yok" = TÜM ORGANIZASYON anlamına gelirdi.
    expect(scope.moneyScope).toEqual([]);
    expect(scope.moneyScope).not.toBeUndefined();
  });

  it("resolveActorReportScope: PROJECT_MANAGER'ın atanmadığı projectId kapsamı GENİŞLETMEZ, moneyScope atanmış projelerde kalır", async () => {
    const { owner, organizationId } = await createOwnerOrg();
    const pm = await createOrgUser(organizationId, "PROJECT_MANAGER");
    const assigned = await createProject(owner, { code: "S-6", name: "Atanan", contractAmount: 0, estimatedBudget: 0 });
    const unassigned = await createProject(owner, { code: "S-7", name: "Atanmayan", contractAmount: 0, estimatedBudget: 0 });
    await assignProjectMember(owner, assigned.id, pm.id);

    const scope = await resolveActorReportScope(pm, unassigned.id);
    expect(scope.scope).toBe("PROJECT_MANAGER");
    expect(scope.projectFilter).toBeNull();
    expect(scope.moneyScope).toEqual([assigned.id]);
    expect(scope.assignedProjectIds).toEqual([assigned.id]);
  });

  it("resolveActorReportScope: organizasyon geneli aktörde geçersiz projectId moneyScope'u undefined bırakır", async () => {
    const { owner } = await createOwnerOrg();
    const { owner: ownerB } = await createOwnerOrg();
    const projectB = await createProject(ownerB, { code: "S-8", name: "B projesi", contractAmount: 0, estimatedBudget: 0 });

    const scope = await resolveActorReportScope(owner, projectB.id);
    expect(scope.scope).toBe("ORGANIZATION");
    expect(scope.projectFilter).toBeNull();
    expect(scope.moneyScope).toBeUndefined();
    expect(scope.assignedProjectIds).toBeUndefined();
  });
});
