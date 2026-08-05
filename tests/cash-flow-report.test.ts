import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { cleanDatabase, createOwnerOrg, createOrgUser } from "./helpers";
import { createIncome, createExpense, cancelIncome, cancelExpense } from "@/server/services/transaction-service";
import { createAccount } from "@/server/services/account-service";
import { createSettlement, cancelSettlement } from "@/server/services/settlement-service";
import { createTransfer } from "@/server/services/transfer-service";
import { createProject, assignProjectMember, setProjectStatus } from "@/server/services/project-service";
import { getCashFlowReport, resolveCashFlowRange } from "@/server/services/cash-flow-report-service";
import { cashFlowFilterSchema } from "@/lib/validation/reports";
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
  return `cf-test-${seq}-${Math.floor(Math.random() * 1e9)}`;
}

const DAY_MS = 24 * 60 * 60 * 1000;
function daysFromNow(days: number) {
  return new Date(Date.now() + days * DAY_MS);
}

async function seedCategory(owner: SessionUser, type: TransactionType) {
  seq += 1;
  return db.transactionCategory.create({
    data: { organizationId: owner.organizationId, type, name: `Kategori ${seq}` },
  });
}

async function seedIncome(
  owner: SessionUser,
  opts: { subtotal: number; projectId?: string; dueDate?: Date; issueDate?: Date; categoryId?: string; customerId?: string },
) {
  const categoryId = opts.categoryId ?? (await seedCategory(owner, "INCOME")).id;
  return createIncome(owner, {
    categoryId,
    projectId: opts.projectId,
    customerId: opts.customerId,
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

async function settle(owner: SessionUser, transactionId: string, accountId: string, amount: number, settlementDate = new Date()) {
  return createSettlement(owner, {
    transactionId,
    financialAccountId: accountId,
    amount,
    settlementDate,
    paymentMethod: "HAVALE_EFT",
    idempotencyKey: key(),
  });
}

async function seedProject(owner: SessionUser, estimatedBudget = 0) {
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

const CURRENT_MONTH = { range: "CURRENT_MONTH" as const, scenario: "ON_DUE_DATE" as const, projectId: undefined, startDate: undefined, endDate: undefined };
const NEXT_30 = { range: "NEXT_30_DAYS" as const, scenario: "ON_DUE_DATE" as const, projectId: undefined, startDate: undefined, endDate: undefined };
const NEXT_90 = { range: "NEXT_90_DAYS" as const, scenario: "ON_DUE_DATE" as const, projectId: undefined, startDate: undefined, endDate: undefined };
const CURRENT_YEAR = { range: "CURRENT_YEAR" as const, scenario: "ON_DUE_DATE" as const, projectId: undefined, startDate: undefined, endDate: undefined };

describe("cash-flow-report-service — filtre doğrulama", () => {
  it("CUSTOM aralık için başlangıç/bitiş tarihi zorunludur", () => {
    const result = cashFlowFilterSchema.safeParse({ range: "CUSTOM" });
    expect(result.success).toBe(false);
  });

  it("CUSTOM aralıkta bitiş, başlangıçtan önce olamaz", () => {
    const result = cashFlowFilterSchema.safeParse({
      range: "CUSTOM",
      startDate: "2026-06-10",
      endDate: "2026-06-01",
    });
    expect(result.success).toBe(false);
  });

  it("özel aralık azami 366 günü aşamaz", () => {
    const tooLong = cashFlowFilterSchema.safeParse({
      range: "CUSTOM",
      startDate: "2026-01-01",
      endDate: "2027-06-01",
    });
    expect(tooLong.success).toBe(false);

    const valid = cashFlowFilterSchema.safeParse({
      range: "CUSTOM",
      startDate: "2026-01-01",
      endDate: "2026-12-01",
    });
    expect(valid.success).toBe(true);
  });

  it("geçersiz range değeri reddedilir, tanımsız filtre NEXT_30_DAYS varsayılanına düşmez (hata döner)", () => {
    const result = cashFlowFilterSchema.safeParse({ range: "INVALID" });
    expect(result.success).toBe(false);
  });
});

describe("cash-flow-report-service — organizasyon", () => {
  it("boş organizasyonda tüm alanlar sıfır/boştur (empty state)", async () => {
    const { owner } = await createOwnerOrg();
    const data = await getCashFlowReport(owner, NEXT_30);
    expect(data.scope).toBe("ORGANIZATION");
    if (data.scope !== "ORGANIZATION") return;
    expect(data.openingBalance).toBe("0");
    expect(data.projectedClosingBalance).toBe("0");
    expect(data.summary.realizedCollections).toBe("0");
    expect(data.summary.scheduledCollections).toBe("0");
    expect(data.receivables.rows).toHaveLength(0);
    expect(data.payables.rows).toHaveLength(0);
    expect(data.projectComparison).toHaveLength(0);
  });

  it("gerçekleşen tahsilat ve ödeme, aktif settlement toplamlarını yansıtır", async () => {
    const { owner } = await createOwnerOrg();
    const account = await seedAccount(owner, 0);
    const income = await seedIncome(owner, { subtotal: 100_000 });
    const expense = await seedExpense(owner, { subtotal: 40_000 });
    await settle(owner, income.id, account.id, 100_000);
    await settle(owner, expense.id, account.id, 40_000);

    const data = await getCashFlowReport(owner, CURRENT_MONTH);
    if (data.scope !== "ORGANIZATION") throw new Error("beklenmeyen kapsam");
    expect(data.summary.realizedCollections).toBe("100000");
    expect(data.summary.realizedPayments).toBe("40000");
    expect(data.summary.realizedNet).toBe("60000");
  });

  it("planlanan tahsilat ve ödeme, açık kayıtların kalan tutarını yansıtır", async () => {
    const { owner } = await createOwnerOrg();
    await seedIncome(owner, { subtotal: 50_000, dueDate: daysFromNow(10) });
    await seedExpense(owner, { subtotal: 20_000, dueDate: daysFromNow(10) });

    const data = await getCashFlowReport(owner, NEXT_30);
    if (data.scope !== "ORGANIZATION") throw new Error("beklenmeyen kapsam");
    expect(data.summary.scheduledCollections).toBe("50000");
    expect(data.summary.scheduledPayments).toBe("20000");
    expect(data.summary.scheduledNet).toBe("30000");
  });

  it("parçalı tahsilat sonrası kalan tutar doğru hesaplanır", async () => {
    const { owner } = await createOwnerOrg();
    const account = await seedAccount(owner);
    const income = await seedIncome(owner, { subtotal: 100_000, dueDate: daysFromNow(5) });
    await settle(owner, income.id, account.id, 40_000);

    const data = await getCashFlowReport(owner, NEXT_30);
    if (data.scope !== "ORGANIZATION") throw new Error("beklenmeyen kapsam");
    const row = data.receivables.rows.find((r) => r.id === income.id);
    expect(row?.remainingAmount).toBe("60000");
    expect(row?.collectedOrPaidAmount).toBe("40000");
  });

  it("parçalı ödeme sonrası kalan tutar doğru hesaplanır", async () => {
    const { owner } = await createOwnerOrg();
    const account = await seedAccount(owner, 100_000);
    const expense = await seedExpense(owner, { subtotal: 80_000, dueDate: daysFromNow(5) });
    await settle(owner, expense.id, account.id, 30_000);

    const data = await getCashFlowReport(owner, NEXT_30);
    if (data.scope !== "ORGANIZATION") throw new Error("beklenmeyen kapsam");
    const row = data.payables.rows.find((r) => r.id === expense.id);
    expect(row?.remainingAmount).toBe("50000");
  });

  it("tamamen tahsil edilen kayıt vade listesinden hariç tutulur", async () => {
    const { owner } = await createOwnerOrg();
    const account = await seedAccount(owner);
    const income = await seedIncome(owner, { subtotal: 25_000, dueDate: daysFromNow(5) });
    await settle(owner, income.id, account.id, 25_000);

    const data = await getCashFlowReport(owner, NEXT_30);
    if (data.scope !== "ORGANIZATION") throw new Error("beklenmeyen kapsam");
    expect(data.receivables.rows.find((r) => r.id === income.id)).toBeUndefined();
  });

  it("iptal edilmiş gelir kaydı hiçbir toplama dahil edilmez", async () => {
    const { owner } = await createOwnerOrg();
    const income = await seedIncome(owner, { subtotal: 30_000, dueDate: daysFromNow(5) });
    await cancelIncome(owner, { id: income.id, reason: "Test iptali" });

    const data = await getCashFlowReport(owner, NEXT_30);
    if (data.scope !== "ORGANIZATION") throw new Error("beklenmeyen kapsam");
    expect(data.summary.scheduledCollections).toBe("0");
    expect(data.receivables.rows.find((r) => r.id === income.id)).toBeUndefined();
  });

  it("iptal edilmiş ödeme kaydı hiçbir toplama dahil edilmez", async () => {
    const { owner } = await createOwnerOrg();
    const expense = await seedExpense(owner, { subtotal: 15_000, dueDate: daysFromNow(5) });
    await cancelExpense(owner, { id: expense.id, reason: "Test iptali" });

    const data = await getCashFlowReport(owner, NEXT_30);
    if (data.scope !== "ORGANIZATION") throw new Error("beklenmeyen kapsam");
    expect(data.summary.scheduledPayments).toBe("0");
  });

  it("iptal edilmiş (ters kayıtlı) settlement gerçekleşen toplamlardan hariç tutulur ve kalan tutar geri yüklenir", async () => {
    const { owner } = await createOwnerOrg();
    const account = await seedAccount(owner);
    const income = await seedIncome(owner, { subtotal: 60_000, dueDate: daysFromNow(5) });
    const settlement = await settle(owner, income.id, account.id, 60_000);

    const before = await getCashFlowReport(owner, CURRENT_MONTH);
    if (before.scope !== "ORGANIZATION") throw new Error("beklenmeyen kapsam");
    expect(before.summary.realizedCollections).toBe("60000");

    await cancelSettlement(owner, { id: settlement.id, reason: "Ters kayıt testi" });

    const after = await getCashFlowReport(owner, { ...CURRENT_MONTH, range: "NEXT_30_DAYS" });
    if (after.scope !== "ORGANIZATION") throw new Error("beklenmeyen kapsam");
    expect(after.summary.realizedCollections).toBe("0");
    const row = after.receivables.rows.find((r) => r.id === income.id);
    expect(row?.remainingAmount).toBe("60000");
  });

  it("iptal edilmiş ödeme settlement'ı gerçekleşen ödemelerden hariç tutulur ve kalan borç geri yüklenir", async () => {
    const { owner } = await createOwnerOrg();
    const account = await seedAccount(owner, 100_000);
    const expense = await seedExpense(owner, { subtotal: 40_000, dueDate: daysFromNow(5) });
    const settlement = await settle(owner, expense.id, account.id, 40_000);
    await cancelSettlement(owner, { id: settlement.id, reason: "Ters kayıt testi" });

    const data = await getCashFlowReport(owner, NEXT_30);
    if (data.scope !== "ORGANIZATION") throw new Error("beklenmeyen kapsam");
    expect(data.summary.realizedPayments).toBe("0");
    const row = data.payables.rows.find((r) => r.id === expense.id);
    expect(row?.remainingAmount).toBe("40000");
  });

  it("vade bucket'ları: vadesi geçmiş, bugün, gelecek 7/30/31-60/61-90/90+ gün doğru sınıflandırılır", async () => {
    const { owner } = await createOwnerOrg();
    const overdue = await seedIncome(owner, { subtotal: 1_000, dueDate: daysFromNow(-2) });
    const dueToday = await seedIncome(owner, { subtotal: 2_000, dueDate: new Date() });
    const next7 = await seedIncome(owner, { subtotal: 3_000, dueDate: daysFromNow(3) });
    const next30 = await seedIncome(owner, { subtotal: 4_000, dueDate: daysFromNow(15) });
    const b3160 = await seedIncome(owner, { subtotal: 5_000, dueDate: daysFromNow(45) });
    const b6190 = await seedIncome(owner, { subtotal: 6_000, dueDate: daysFromNow(75) });
    const over90 = await seedIncome(owner, { subtotal: 7_000, dueDate: daysFromNow(120) });
    void overdue;
    void dueToday;
    void next7;
    void next30;
    void b3160;
    void b6190;
    void over90;

    const data = await getCashFlowReport(owner, CURRENT_YEAR);
    if (data.scope !== "ORGANIZATION") throw new Error("beklenmeyen kapsam");
    expect(data.receivableBuckets.overdue).toBe("1000");
    expect(data.receivableBuckets.dueToday).toBe("2000");
    expect(data.receivableBuckets.next7Days).toBe("3000");
    expect(data.receivableBuckets.next30Days).toBe("4000");
    expect(data.receivableBuckets.days31to60).toBe("5000");
    expect(data.receivableBuckets.days61to90).toBe("6000");
    expect(data.receivableBuckets.over90Days).toBe("7000");
  });

  it("vade tarihi girilmemiş kayıtlar ayrı bir bölümde gösterilir, bucket'lara dağıtılmaz", async () => {
    const { owner } = await createOwnerOrg();
    const income = await seedIncome(owner, { subtotal: 9_000 });

    const data = await getCashFlowReport(owner, CURRENT_YEAR);
    if (data.scope !== "ORGANIZATION") throw new Error("beklenmeyen kapsam");
    expect(data.receivableBuckets.noDueDate).toBe("9000");
    expect(data.receivablesNoDueDate.rows.map((r) => r.id)).toContain(income.id);
    expect(data.receivables.rows.map((r) => r.id)).not.toContain(income.id);
  });

  it("açılış bakiyesi güncel kasa/banka bakiyesini yansıtır", async () => {
    const { owner } = await createOwnerOrg();
    await seedAccount(owner, 250_000);

    const data = await getCashFlowReport(owner, NEXT_30);
    if (data.scope !== "ORGANIZATION") throw new Error("beklenmeyen kapsam");
    expect(data.openingBalance).toBe("250000");
  });

  it("tahmini kapanış bakiyesi = açılış + planlanan tahsilat − planlanan ödeme", async () => {
    const { owner } = await createOwnerOrg();
    await seedAccount(owner, 100_000);
    await seedIncome(owner, { subtotal: 20_000, dueDate: daysFromNow(10) });
    await seedExpense(owner, { subtotal: 15_000, dueDate: daysFromNow(10) });

    const data = await getCashFlowReport(owner, NEXT_30);
    if (data.scope !== "ORGANIZATION") throw new Error("beklenmeyen kapsam");
    expect(data.projectedClosingBalance).toBe("105000");
    expect(data.projectedClosingBalanceIsEstimate).toBe(true);
  });

  it("planlanan tutarlar yalnızca seçilen dönem sonuna kadar olan vadeleri kapsar (kesim tarihi)", async () => {
    const { owner } = await createOwnerOrg();
    await seedIncome(owner, { subtotal: 10_000, dueDate: daysFromNow(15) });
    await seedIncome(owner, { subtotal: 40_000, dueDate: daysFromNow(60) });

    const data = await getCashFlowReport(owner, NEXT_30);
    if (data.scope !== "ORGANIZATION") throw new Error("beklenmeyen kapsam");
    expect(data.summary.scheduledCollections).toBe("10000");
  });

  it("aylık projeksiyonda koşan bakiye, aylar ilerledikçe birikimli olarak hesaplanır", async () => {
    const { owner } = await createOwnerOrg();
    await seedAccount(owner, 10_000);
    await seedIncome(owner, { subtotal: 5_000, dueDate: daysFromNow(10) });
    await seedIncome(owner, { subtotal: 8_000, dueDate: daysFromNow(70) });

    const data = await getCashFlowReport(owner, NEXT_90);
    if (data.scope !== "ORGANIZATION") throw new Error("beklenmeyen kapsam");
    expect(data.monthlyProjection.length).toBeGreaterThanOrEqual(2);
    const last = data.monthlyProjection[data.monthlyProjection.length - 1];
    expect(last.runningProjectedBalance).toBe(23000);
  });

  it("transfer hareketleri gelir/gider olarak sınıflandırılmaz", async () => {
    const { owner } = await createOwnerOrg();
    const accountA = await seedAccount(owner, 50_000);
    const accountB = await seedAccount(owner, 0);
    await createTransfer(owner, {
      fromAccountId: accountA.id,
      toAccountId: accountB.id,
      amount: 10_000,
      transferDate: new Date(),
      idempotencyKey: key(),
    });

    const data = await getCashFlowReport(owner, CURRENT_MONTH);
    if (data.scope !== "ORGANIZATION") throw new Error("beklenmeyen kapsam");
    expect(data.summary.realizedCollections).toBe("0");
    expect(data.summary.realizedPayments).toBe("0");
    expect(data.openingBalance).toBe("50000");
  });

  it("FINANCE rolü organizasyon genelinde nakit akışı raporunu görebilir", async () => {
    const { owner, organizationId } = await createOwnerOrg();
    const finance = await createOrgUser(organizationId, "FINANCE");
    await seedAccount(owner, 5_000);

    const data = await getCashFlowReport(finance, NEXT_30);
    expect(data.scope).toBe("ORGANIZATION");
    if (data.scope !== "ORGANIZATION") return;
    expect(data.openingBalance).toBe("5000");
  });

  it("proje bazlı karşılaştırma, planlanan akış ve vadesi geçen tutarları proje başına ayırır", async () => {
    const { owner } = await createOwnerOrg();
    const projectA = await seedProject(owner);
    const projectB = await seedProject(owner);
    await seedIncome(owner, { subtotal: 12_000, projectId: projectA.id, dueDate: daysFromNow(10) });
    await seedIncome(owner, { subtotal: 3_000, projectId: projectB.id, dueDate: daysFromNow(-3) });

    const data = await getCashFlowReport(owner, NEXT_30);
    if (data.scope !== "ORGANIZATION") throw new Error("beklenmeyen kapsam");
    const rowA = data.projectComparison.find((r) => r.projectId === projectA.id);
    const rowB = data.projectComparison.find((r) => r.projectId === projectB.id);
    expect(rowA?.scheduledInflow).toBe("12000");
    expect(rowB?.overdueReceivable).toBe("3000");
  });

  it("proje filtresi yalnızca belirtilen projenin verilerini döndürür", async () => {
    const { owner } = await createOwnerOrg();
    const projectA = await seedProject(owner);
    const projectB = await seedProject(owner);
    await seedIncome(owner, { subtotal: 12_000, projectId: projectA.id, dueDate: daysFromNow(10) });
    await seedIncome(owner, { subtotal: 30_000, projectId: projectB.id, dueDate: daysFromNow(10) });

    const data = await getCashFlowReport(owner, { ...NEXT_30, projectId: projectA.id });
    if (data.scope !== "ORGANIZATION") throw new Error("beklenmeyen kapsam");
    expect(data.summary.scheduledCollections).toBe("12000");
    expect(data.projectFilter?.id).toBe(projectA.id);
  });

  it("başka bir organizasyona ait proje ID'si filtre olarak kabul edilmez (tenant izolasyonu)", async () => {
    const { owner: ownerA } = await createOwnerOrg();
    const { owner: ownerB } = await createOwnerOrg();
    const projectB = await seedProject(ownerB);
    await seedIncome(ownerA, { subtotal: 8_000, dueDate: daysFromNow(10) });

    const data = await getCashFlowReport(ownerA, { ...NEXT_30, projectId: projectB.id });
    if (data.scope !== "ORGANIZATION") throw new Error("beklenmeyen kapsam");
    expect(data.projectFilter).toBeNull();
    expect(data.summary.scheduledCollections).toBe("8000");
  });

  it("senaryo: tahsilatlar 7 gün gecikirse, kesim tarihine yakın planlanan tahsilat dışarıda kalabilir", async () => {
    const { owner } = await createOwnerOrg();
    await seedIncome(owner, { subtotal: 5_000, dueDate: daysFromNow(28) });

    const onTime = await getCashFlowReport(owner, NEXT_30);
    if (onTime.scope !== "ORGANIZATION") throw new Error("beklenmeyen kapsam");
    expect(onTime.summary.scheduledCollections).toBe("5000");

    const delayed = await getCashFlowReport(owner, { ...NEXT_30, scenario: "COLLECTIONS_DELAYED_7D" });
    if (delayed.scope !== "ORGANIZATION") throw new Error("beklenmeyen kapsam");
    expect(delayed.summary.scheduledCollections).toBe("0");
  });

  it("sonuç listeleri deterministik sıralanır ve sınırlıdır (vade tarihine göre artan)", async () => {
    const { owner } = await createOwnerOrg();
    await seedIncome(owner, { subtotal: 1_000, dueDate: daysFromNow(20) });
    await seedIncome(owner, { subtotal: 1_000, dueDate: daysFromNow(5) });
    await seedIncome(owner, { subtotal: 1_000, dueDate: daysFromNow(12) });

    const data = await getCashFlowReport(owner, CURRENT_YEAR);
    if (data.scope !== "ORGANIZATION") throw new Error("beklenmeyen kapsam");
    const dueDates = data.receivables.rows.map((r) => r.dueDate!.getTime());
    const sorted = [...dueDates].sort((a, b) => a - b);
    expect(dueDates).toEqual(sorted);
  });
});

describe("cash-flow-report-service — PROJECT_MANAGER", () => {
  it("atanmış projesi olmayan PROJECT_MANAGER boş bir rapor görür", async () => {
    const { organizationId } = await createOwnerOrg();
    const pm = await createOrgUser(organizationId, "PROJECT_MANAGER");

    const data = await getCashFlowReport(pm, NEXT_30);
    expect(data.scope).toBe("PROJECT_MANAGER");
    if (data.scope !== "PROJECT_MANAGER") return;
    expect(data.hasAssignedProjects).toBe(false);
    expect(data.receivables.rows).toHaveLength(0);
  });

  it("PROJECT_MANAGER yalnızca atandığı projelerin verilerini görür", async () => {
    const { owner, organizationId } = await createOwnerOrg();
    const pm = await createOrgUser(organizationId, "PROJECT_MANAGER");
    const assignedProject = await seedProject(owner);
    const otherProject = await seedProject(owner);
    await assignProjectMember(owner, assignedProject.id, pm.id);

    await seedIncome(owner, { subtotal: 15_000, projectId: assignedProject.id, dueDate: daysFromNow(10) });
    await seedIncome(owner, { subtotal: 99_000, projectId: otherProject.id, dueDate: daysFromNow(10) });

    const data = await getCashFlowReport(pm, NEXT_30);
    if (data.scope !== "PROJECT_MANAGER") throw new Error("beklenmeyen kapsam");
    expect(data.hasAssignedProjects).toBe(true);
    expect(data.summary.scheduledCollections).toBe("15000");
  });

  it("PROJECT_MANAGER raporunda kasa/banka açılış veya kapanış bakiyesi alanı bulunmaz", async () => {
    const { owner, organizationId } = await createOwnerOrg();
    const pm = await createOrgUser(organizationId, "PROJECT_MANAGER");
    const project = await seedProject(owner);
    await assignProjectMember(owner, project.id, pm.id);
    await seedAccount(owner, 500_000);

    const data = await getCashFlowReport(pm, NEXT_30);
    if (data.scope !== "PROJECT_MANAGER") throw new Error("beklenmeyen kapsam");
    expect("openingBalance" in data).toBe(false);
    expect("projectedClosingBalance" in data).toBe(false);
    expect(data.monthlyProjection.every((m) => m.runningProjectedBalance === null)).toBe(true);
  });

  it("PROJECT_MANAGER, atanmadığı bir projeyi filtre olarak veremez (fail closed)", async () => {
    const { owner, organizationId } = await createOwnerOrg();
    const pm = await createOrgUser(organizationId, "PROJECT_MANAGER");
    const assignedProject = await seedProject(owner);
    const unassignedProject = await seedProject(owner);
    await assignProjectMember(owner, assignedProject.id, pm.id);
    await seedIncome(owner, { subtotal: 7_000, projectId: assignedProject.id, dueDate: daysFromNow(10) });
    await seedIncome(owner, { subtotal: 70_000, projectId: unassignedProject.id, dueDate: daysFromNow(10) });

    const data = await getCashFlowReport(pm, { ...NEXT_30, projectId: unassignedProject.id });
    if (data.scope !== "PROJECT_MANAGER") throw new Error("beklenmeyen kapsam");
    expect(data.projectFilter).toBeNull();
    expect(data.summary.scheduledCollections).toBe("7000");
  });
});

describe("resolveCashFlowRange", () => {
  it("NEXT_30_DAYS 30 günlük ileri dönük bir pencere döndürür", () => {
    const now = new Date("2026-06-15T10:00:00Z");
    const range = resolveCashFlowRange({ range: "NEXT_30_DAYS", scenario: "ON_DUE_DATE", projectId: undefined, startDate: undefined, endDate: undefined }, now);
    const spanDays = Math.round((range.end.getTime() - range.start.getTime()) / DAY_MS);
    expect(spanDays).toBe(30);
  });

  it("CUSTOM aralık bitiş tarihini dahil eder (gün sonuna kadar)", () => {
    const now = new Date("2026-06-15T10:00:00Z");
    const range = resolveCashFlowRange(
      { range: "CUSTOM", scenario: "ON_DUE_DATE", projectId: undefined, startDate: new Date("2026-06-01T00:00:00Z"), endDate: new Date("2026-06-10T00:00:00Z") },
      now,
    );
    const spanDays = Math.round((range.end.getTime() - range.start.getTime()) / DAY_MS);
    expect(spanDays).toBe(10);
  });
});
