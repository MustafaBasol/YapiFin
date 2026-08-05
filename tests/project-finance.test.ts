import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { cleanDatabase, createOwnerOrg, createOrgUser } from "./helpers";
import { createIncome, createExpense, cancelExpense } from "@/server/services/transaction-service";
import { createAccount } from "@/server/services/account-service";
import { createSettlement } from "@/server/services/settlement-service";
import { createProject, assignProjectMember } from "@/server/services/project-service";
import { getProjectFinanceSummary } from "@/server/services/project-finance-service";
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
  return `pf-test-${seq}-${Math.floor(Math.random() * 1e9)}`;
}

async function seedCategory(owner: SessionUser, type: TransactionType) {
  seq += 1;
  return db.transactionCategory.create({
    data: { organizationId: owner.organizationId, type, name: `Kategori ${seq}` },
  });
}

async function seedIncome(owner: SessionUser, projectId: string, subtotal: number, categoryId?: string) {
  const cat = categoryId ?? (await seedCategory(owner, "INCOME")).id;
  return createIncome(owner, {
    categoryId: cat,
    projectId,
    description: "Proje geliri",
    issueDate: new Date(),
    subtotal,
    taxRate: 0,
  });
}

async function seedExpense(owner: SessionUser, projectId: string, subtotal: number, categoryId?: string) {
  const cat = categoryId ?? (await seedCategory(owner, "EXPENSE")).id;
  return createExpense(owner, {
    categoryId: cat,
    projectId,
    description: "Proje gideri",
    issueDate: new Date(),
    subtotal,
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

describe("project-finance-service", () => {
  it("nakit pozisyonu = tahsil edilen - ödenen; tahakkuk sonucu = kaydedilen gelir - kaydedilen gider", async () => {
    const { owner } = await createOwnerOrg();
    const project = await createProject(owner, { code: "PF-1", name: "Proje 1", contractAmount: 0, estimatedBudget: 0 });
    const account = await seedAccount(owner, 0);

    const income = await seedIncome(owner, project.id, 100000);
    await settle(owner, income.id, account.id, 60000);
    const expense = await seedExpense(owner, project.id, 40000);
    await settle(owner, expense.id, account.id, 10000);

    const summary = await getProjectFinanceSummary(owner, project.id);
    expect(summary.totalRecordedIncome).toBe("100000");
    expect(summary.totalCollected).toBe("60000");
    expect(summary.remainingReceivable).toBe("40000");
    expect(summary.totalRecordedExpense).toBe("40000");
    expect(summary.totalPaid).toBe("10000");
    expect(summary.remainingPayable).toBe("30000");
    expect(summary.cashPosition).toBe("50000"); // 60000 - 10000
    expect(summary.accrualResult).toBe("60000"); // 100000 - 40000
  });

  it("sözleşme bedeli girilmişse tahmini brüt kâr ve marj hesaplanır", async () => {
    const { owner } = await createOwnerOrg();
    const project = await createProject(owner, { code: "PF-2", name: "Proje 2", contractAmount: 200000, estimatedBudget: 0 });
    await seedExpense(owner, project.id, 50000);

    const summary = await getProjectFinanceSummary(owner, project.id);
    expect(summary.estimatedProfitAvailable).toBe(true);
    expect(summary.estimatedGrossProfit).toBe("150000"); // 200000 - 50000
    expect(summary.estimatedProfitMargin).toBe("75"); // 150000/200000*100
  });

  it("sözleşme bedeli sıfırsa tahmini kâr ve marj dürüstçe 'unavailable' döner (sıfır payda korunması)", async () => {
    const { owner } = await createOwnerOrg();
    const project = await createProject(owner, { code: "PF-3", name: "Proje 3", contractAmount: 0, estimatedBudget: 0 });
    await seedExpense(owner, project.id, 1000);

    const summary = await getProjectFinanceSummary(owner, project.id);
    expect(summary.estimatedProfitAvailable).toBe(false);
    expect(summary.estimatedGrossProfit).toBeNull();
    expect(summary.estimatedProfitMargin).toBeNull();
  });

  it("beklenen ek gelir, şema tarafından desteklenmediği için her zaman açıkça 'unavailable' işaretlenir", async () => {
    const { owner } = await createOwnerOrg();
    const project = await createProject(owner, { code: "PF-4", name: "Proje 4", contractAmount: 100000, estimatedBudget: 0 });
    const summary = await getProjectFinanceSummary(owner, project.id);
    expect(summary.expectedAdditionalIncomeAvailable).toBe(false);
  });

  it("bütçe kullanımı ve kalan bütçe doğru hesaplanır; %80 üzeri aşım olarak işaretlenir", async () => {
    const { owner } = await createOwnerOrg();
    const project = await createProject(owner, { code: "PF-5", name: "Proje 5", contractAmount: 0, estimatedBudget: 10000 });
    await seedExpense(owner, project.id, 9000);

    const summary = await getProjectFinanceSummary(owner, project.id);
    expect(summary.budgetAvailable).toBe(true);
    expect(summary.budgetUsed).toBe("9000");
    expect(summary.remainingBudget).toBe("1000");
    expect(summary.budgetUsedRatio).toBe("90");
    expect(summary.isBudgetOverrun).toBe(false); // henüz bütçeyi AŞMADI (90 < 100)
  });

  it("gerçekleşen gider bütçeyi aştığında bütçe aşım durumu true olur", async () => {
    const { owner } = await createOwnerOrg();
    const project = await createProject(owner, { code: "PF-6", name: "Proje 6", contractAmount: 0, estimatedBudget: 10000 });
    await seedExpense(owner, project.id, 15000);

    const summary = await getProjectFinanceSummary(owner, project.id);
    expect(summary.isBudgetOverrun).toBe(true);
    expect(summary.remainingBudget).toBe("-5000");
  });

  it("bütçe girilmemişse (0) bütçe oranı dürüstçe null döner, aşım false olur", async () => {
    const { owner } = await createOwnerOrg();
    const project = await createProject(owner, { code: "PF-7", name: "Proje 7", contractAmount: 0, estimatedBudget: 0 });
    await seedExpense(owner, project.id, 5000);

    const summary = await getProjectFinanceSummary(owner, project.id);
    expect(summary.budgetAvailable).toBe(false);
    expect(summary.budgetUsedRatio).toBeNull();
    expect(summary.isBudgetOverrun).toBe(false);
  });

  it("iptal edilmiş gider proje toplamlarından hariç tutulur", async () => {
    const { owner } = await createOwnerOrg();
    const project = await createProject(owner, { code: "PF-8", name: "Proje 8", contractAmount: 0, estimatedBudget: 0 });
    const expense = await seedExpense(owner, project.id, 7000);
    await cancelExpense(owner, { id: expense.id, reason: "Hatalı kayıt" });

    const summary = await getProjectFinanceSummary(owner, project.id);
    expect(summary.totalRecordedExpense).toBe("0");
    expect(summary.budgetUsed).toBe("0");
  });

  it("gider kategorisi dağılımı proje bazında doğru gruplanır", async () => {
    const { owner } = await createOwnerOrg();
    const project = await createProject(owner, { code: "PF-9", name: "Proje 9", contractAmount: 0, estimatedBudget: 0 });
    const catA = await seedCategory(owner, "EXPENSE");
    await seedExpense(owner, project.id, 1200, catA.id);
    await seedExpense(owner, project.id, 300, catA.id);

    const summary = await getProjectFinanceSummary(owner, project.id);
    const slice = summary.categoryDistribution.find((c) => c.categoryId === catA.id);
    expect(slice?.amount).toBe("1500");
  });

  it("cross-tenant proje ID'sine erişim NOT_FOUND ile reddedilir", async () => {
    const { owner: ownerA } = await createOwnerOrg();
    const { owner: ownerB } = await createOwnerOrg();
    const projectB = await createProject(ownerB, { code: "PF-10", name: "Proje 10", contractAmount: 0, estimatedBudget: 0 });

    await expect(getProjectFinanceSummary(ownerA, projectB.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("atanmamış PROJECT_MANAGER proje finans özetine erişemez", async () => {
    const { owner } = await createOwnerOrg();
    const pm = await createOrgUser(owner.organizationId, "PROJECT_MANAGER");
    const project = await createProject(owner, { code: "PF-11", name: "Proje 11", contractAmount: 0, estimatedBudget: 0 });

    await expect(getProjectFinanceSummary(pm, project.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("atanmış PROJECT_MANAGER kendi projesinin finans özetine erişebilir", async () => {
    const { owner } = await createOwnerOrg();
    const pm = await createOrgUser(owner.organizationId, "PROJECT_MANAGER");
    const project = await createProject(owner, { code: "PF-12", name: "Proje 12", contractAmount: 0, estimatedBudget: 0 });
    await assignProjectMember(owner, project.id, pm.id);
    await seedExpense(owner, project.id, 100);

    const summary = await getProjectFinanceSummary(pm, project.id);
    expect(summary.projectId).toBe(project.id);
    expect(summary.totalRecordedExpense).toBe("100");
  });

  it("ondalık hassasiyet: KDV'li tutarlar kuruş bazında doğru toplanır", async () => {
    const { owner } = await createOwnerOrg();
    const project = await createProject(owner, { code: "PF-13", name: "Proje 13", contractAmount: 0, estimatedBudget: 0 });
    const income = await createIncome(owner, {
      categoryId: (await seedCategory(owner, "INCOME")).id,
      projectId: project.id,
      description: "KDV'li gelir",
      issueDate: new Date(),
      subtotal: 1234.56,
      taxRate: 18,
    });
    // 1234.56 * 1.18 = 1456.7808 -> 1456.78 (2 ondalık)
    expect(income.totalAmount.toString()).toBe("1456.78");

    const summary = await getProjectFinanceSummary(owner, project.id);
    expect(summary.totalRecordedIncome).toBe("1456.78");
  });
});
