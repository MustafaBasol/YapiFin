import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { cleanDatabase, createOwnerOrg, createOrgUser } from "./helpers";
import { createProject, assignProjectMember } from "@/server/services/project-service";
import { createAccount } from "@/server/services/account-service";
import { createSettlement } from "@/server/services/settlement-service";
import { listTransactionsForUser, cancelIncome } from "@/server/services/transaction-service";
import { getOpenAndOverdueTotals } from "@/server/services/ledger";
import {
  listProgressPaymentsForProject,
  getProgressPaymentForUser,
  createProgressPayment,
  updateProgressPayment,
  addExtraWorkItem,
  deleteExtraWorkItem,
  submitProgressPayment,
  approveProgressPayment,
  rejectProgressPayment,
  cancelProgressPayment,
  getProgressPaymentAggregatesForProject,
} from "@/server/services/progress-payment-service";
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
  return `pp-test-${seq}-${Math.floor(Math.random() * 1e9)}`;
}

async function seedIncomeCategory(owner: SessionUser) {
  seq += 1;
  return db.transactionCategory.create({
    data: { organizationId: owner.organizationId, type: "INCOME", name: `Gelir Kategorisi ${seq}` },
  });
}

async function seedProject(owner: SessionUser) {
  seq += 1;
  return createProject(owner, { code: `HK-${seq}-${key()}`, name: `Hakediş Projesi ${seq}`, contractAmount: 0, estimatedBudget: 0 });
}

function period() {
  return { periodStartDate: new Date("2026-01-01"), periodEndDate: new Date("2026-01-31") };
}

async function seedDraft(owner: SessionUser, projectId: string, categoryId: string, gross = "10000", deduction = "500") {
  return createProgressPayment(owner, {
    projectId,
    categoryId,
    ...period(),
    grossAmount: gross,
    deductionAmount: deduction,
  });
}

describe("progress-payment-service — yetkilendirme ve tenant izolasyonu", () => {
  it("OWNER hakediş oluşturabilir, listeleyebilir ve görüntüleyebilir", async () => {
    const { owner } = await createOwnerOrg();
    const project = await seedProject(owner);
    const category = await seedIncomeCategory(owner);

    const draft = await seedDraft(owner, project.id, category.id);
    expect(draft.sequenceNo).toBe(1);
    expect(draft.netAmount.toString()).toBe("9500");

    const listing = await listProgressPaymentsForProject(owner, project.id);
    expect(listing.records).toHaveLength(1);
    expect(listing.canManage).toBe(true);

    const detail = await getProgressPaymentForUser(owner, draft.id);
    expect(detail.categoryName).toBe(category.name);
  });

  it("başka bir organizasyonun hakedişine erişim NOT_FOUND ile reddedilir (sızıntı yok)", async () => {
    const { owner: ownerA } = await createOwnerOrg();
    const { owner: ownerB } = await createOwnerOrg();
    const projectA = await seedProject(ownerA);
    const categoryA = await seedIncomeCategory(ownerA);
    const draft = await seedDraft(ownerA, projectA.id, categoryA.id);

    await expect(getProgressPaymentForUser(ownerB, draft.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(listProgressPaymentsForProject(ownerB, projectA.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("başka bir organizasyonun proje/kategori id'siyle hakediş oluşturma NOT_FOUND ile reddedilir", async () => {
    const { owner: ownerA } = await createOwnerOrg();
    const { owner: ownerB } = await createOwnerOrg();
    const projectB = await seedProject(ownerB);
    const categoryB = await seedIncomeCategory(ownerB);

    await expect(
      createProgressPayment(ownerA, { projectId: projectB.id, categoryId: categoryB.id, ...period(), grossAmount: "1000", deductionAmount: "0" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("atanmış PROJECT_MANAGER hakedişleri yalnızca görüntüleyebilir; oluşturamaz/onaylayamaz", async () => {
    const { owner } = await createOwnerOrg();
    const pm = await createOrgUser(owner.organizationId, "PROJECT_MANAGER");
    const project = await seedProject(owner);
    const category = await seedIncomeCategory(owner);
    await assignProjectMember(owner, project.id, pm.id);
    const draft = await seedDraft(owner, project.id, category.id);

    const listing = await listProgressPaymentsForProject(pm, project.id);
    expect(listing.records).toHaveLength(1);
    expect(listing.canManage).toBe(false);

    await expect(
      createProgressPayment(pm, { projectId: project.id, categoryId: category.id, ...period(), grossAmount: "1000", deductionAmount: "0" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(submitProgressPayment(pm, { id: draft.id })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(approveProgressPayment(pm, { id: draft.id })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("atanmamış PROJECT_MANAGER projeye hiç erişemez (NOT_FOUND)", async () => {
    const { owner } = await createOwnerOrg();
    const pm = await createOrgUser(owner.organizationId, "PROJECT_MANAGER");
    const project = await seedProject(owner);
    const category = await seedIncomeCategory(owner);
    const draft = await seedDraft(owner, project.id, category.id);

    await expect(listProgressPaymentsForProject(pm, project.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(getProgressPaymentForUser(pm, draft.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("progress-payment-service — rol bazlı yetkilendirme (FINANCE/ADMIN)", () => {
  it.each(["FINANCE", "ADMIN"] as const)("%s, OWNER ile aynı şekilde tam yaşam döngüsünü yürütebilir", async (role) => {
    const { owner } = await createOwnerOrg();
    const actor = await createOrgUser(owner.organizationId, role);
    const project = await seedProject(owner);
    const category = await seedIncomeCategory(owner);

    const draft = await seedDraft(actor, project.id, category.id);
    const submitted = await submitProgressPayment(actor, { id: draft.id });
    expect(submitted.status).toBe("SUBMITTED");

    const { progressPayment, financialTransaction } = await approveProgressPayment(actor, { id: draft.id });
    expect(progressPayment.status).toBe("APPROVED");
    expect(financialTransaction?.type).toBe("INCOME");

    const listing = await listProgressPaymentsForProject(actor, project.id);
    expect(listing.canManage).toBe(true);
  });
});

describe("progress-payment-service — Decimal hassasiyeti", () => {
  it("brüt/kesinti/net tutarlar Decimal olarak doğru hesaplanır", async () => {
    const { owner } = await createOwnerOrg();
    const project = await seedProject(owner);
    const category = await seedIncomeCategory(owner);

    const draft = await createProgressPayment(owner, {
      projectId: project.id,
      categoryId: category.id,
      ...period(),
      grossAmount: "123456.78",
      deductionAmount: "3456.78",
    });
    expect(draft.grossAmount.toString()).toBe("123456.78");
    expect(draft.deductionAmount.toString()).toBe("3456.78");
    expect(draft.netAmount.toString()).toBe("120000");
  });

  it("kesinti brüt tutarı aşamaz", async () => {
    const { owner } = await createOwnerOrg();
    const project = await seedProject(owner);
    const category = await seedIncomeCategory(owner);

    await expect(
      createProgressPayment(owner, {
        projectId: project.id,
        categoryId: category.id,
        ...period(),
        grossAmount: "1000",
        deductionAmount: "1000.01",
      }),
    ).rejects.toMatchObject({ code: "VALIDATION" });
  });
});

describe("progress-payment-service — yaşam döngüsü", () => {
  it("DRAFT -> SUBMITTED -> APPROVED geçerli akışı izler ve tek bir kanonik gelir kaydı oluşturur", async () => {
    const { owner } = await createOwnerOrg();
    const project = await seedProject(owner);
    const category = await seedIncomeCategory(owner);
    const draft = await seedDraft(owner, project.id, category.id);

    const submitted = await submitProgressPayment(owner, { id: draft.id });
    expect(submitted.status).toBe("SUBMITTED");

    const { progressPayment, financialTransaction } = await approveProgressPayment(owner, { id: draft.id });
    expect(progressPayment.status).toBe("APPROVED");
    expect(financialTransaction?.type).toBe("INCOME");
    expect(financialTransaction?.totalAmount.toString()).toBe("9500");
    expect(financialTransaction?.projectId).toBe(project.id);

    const count = await db.financialTransaction.count({ where: { organizationId: owner.organizationId } });
    expect(count).toBe(1);
  });

  it("geçersiz durum geçişleri reddedilir", async () => {
    const { owner } = await createOwnerOrg();
    const project = await seedProject(owner);
    const category = await seedIncomeCategory(owner);
    const draft = await seedDraft(owner, project.id, category.id);

    await expect(approveProgressPayment(owner, { id: draft.id })).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(rejectProgressPayment(owner, { id: draft.id, reason: "test" })).rejects.toMatchObject({ code: "CONFLICT" });

    const submitted = await submitProgressPayment(owner, { id: draft.id });
    await expect(submitProgressPayment(owner, { id: submitted.id })).rejects.toMatchObject({ code: "CONFLICT" });

    await approveProgressPayment(owner, { id: draft.id });
    await expect(rejectProgressPayment(owner, { id: draft.id, reason: "test" })).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(cancelProgressPayment(owner, { id: draft.id, reason: "test" })).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(updateProgressPayment(owner, { id: draft.id, categoryId: category.id, ...period(), grossAmount: "1", deductionAmount: "0" })).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("SUBMITTED bir hakediş reddedilebilir; reddedilen hakediş gelir tahakkuku oluşturmaz", async () => {
    const { owner } = await createOwnerOrg();
    const project = await seedProject(owner);
    const category = await seedIncomeCategory(owner);
    const draft = await seedDraft(owner, project.id, category.id);
    await submitProgressPayment(owner, { id: draft.id });

    const rejected = await rejectProgressPayment(owner, { id: draft.id, reason: "Metraj hatalı" });
    expect(rejected.status).toBe("REJECTED");
    expect(rejected.financialTransactionId).toBeNull();

    const count = await db.financialTransaction.count({ where: { organizationId: owner.organizationId } });
    expect(count).toBe(0);
  });

  it("DRAFT/SUBMITTED hakediş iptal edilebilir; APPROVED hakediş doğrudan iptal edilemez", async () => {
    const { owner } = await createOwnerOrg();
    const project = await seedProject(owner);
    const category = await seedIncomeCategory(owner);

    const draft1 = await seedDraft(owner, project.id, category.id);
    const cancelled = await cancelProgressPayment(owner, { id: draft1.id, reason: "Vazgeçildi" });
    expect(cancelled.status).toBe("CANCELLED");

    const draft2 = await seedDraft(owner, project.id, category.id);
    await submitProgressPayment(owner, { id: draft2.id });
    const cancelledSubmitted = await cancelProgressPayment(owner, { id: draft2.id, reason: "Vazgeçildi" });
    expect(cancelledSubmitted.status).toBe("CANCELLED");

    const draft3 = await seedDraft(owner, project.id, category.id);
    await submitProgressPayment(owner, { id: draft3.id });
    await approveProgressPayment(owner, { id: draft3.id });
    await expect(cancelProgressPayment(owner, { id: draft3.id, reason: "test" })).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("onay idempotenttir — tekrarlı (ardışık ve eşzamanlı) onay çağrıları tek bir kanonik kayıt üretir", async () => {
    const { owner } = await createOwnerOrg();
    const project = await seedProject(owner);
    const category = await seedIncomeCategory(owner);
    const draft = await seedDraft(owner, project.id, category.id);
    await submitProgressPayment(owner, { id: draft.id });

    const first = await approveProgressPayment(owner, { id: draft.id });
    const second = await approveProgressPayment(owner, { id: draft.id });
    expect(second.financialTransaction?.id).toBe(first.financialTransaction?.id);

    const countAfterSequential = await db.financialTransaction.count({ where: { organizationId: owner.organizationId } });
    expect(countAfterSequential).toBe(1);

    const draft2 = await seedDraft(owner, project.id, category.id, "20000", "0");
    await submitProgressPayment(owner, { id: draft2.id });
    const [r1, r2, r3] = await Promise.all([
      approveProgressPayment(owner, { id: draft2.id }),
      approveProgressPayment(owner, { id: draft2.id }),
      approveProgressPayment(owner, { id: draft2.id }),
    ]);
    const ids = new Set([r1.financialTransaction?.id, r2.financialTransaction?.id, r3.financialTransaction?.id]);
    expect(ids.size).toBe(1);

    const countAfterConcurrent = await db.financialTransaction.count({
      where: { organizationId: owner.organizationId, projectId: project.id },
    });
    expect(countAfterConcurrent).toBe(2);
  });
});

describe("progress-payment-service — ek iş kalemleri", () => {
  it("yalnızca DRAFT hakedişte ek iş kalemi eklenip silinebilir", async () => {
    const { owner } = await createOwnerOrg();
    const project = await seedProject(owner);
    const category = await seedIncomeCategory(owner);
    const draft = await seedDraft(owner, project.id, category.id);

    const item = await addExtraWorkItem(owner, { progressPaymentId: draft.id, description: "Ek elektrik tesisatı", amount: "2500" });
    const detail = await getProgressPaymentForUser(owner, draft.id);
    expect(detail.extraWorkItems).toHaveLength(1);

    await deleteExtraWorkItem(owner, { id: item.id });
    const afterDelete = await getProgressPaymentForUser(owner, draft.id);
    expect(afterDelete.extraWorkItems).toHaveLength(0);

    await submitProgressPayment(owner, { id: draft.id });
    await expect(
      addExtraWorkItem(owner, { progressPaymentId: draft.id, description: "Geç kalem", amount: "100" }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("başka bir organizasyonun ek iş kalemine erişim/silme NOT_FOUND ile reddedilir (sızıntı yok)", async () => {
    const { owner: ownerA } = await createOwnerOrg();
    const { owner: ownerB } = await createOwnerOrg();
    const projectA = await seedProject(ownerA);
    const categoryA = await seedIncomeCategory(ownerA);
    const draftA = await seedDraft(ownerA, projectA.id, categoryA.id);
    const itemA = await addExtraWorkItem(ownerA, { progressPaymentId: draftA.id, description: "İzole kalem", amount: "500" });

    await expect(deleteExtraWorkItem(ownerB, { id: itemA.id })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      addExtraWorkItem(ownerB, { progressPaymentId: draftA.id, description: "Sızıntı denemesi", amount: "1" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    const stillThere = await getProgressPaymentForUser(ownerA, draftA.id);
    expect(stillThere.extraWorkItems).toHaveLength(1);
  });
});

describe("progress-payment-service — kanonik finansal bütünlük", () => {
  it("taslak/reddedilmiş/iptal edilmiş hakedişler hiçbir toplamı etkilemez; yalnızca onaylanan kanonik gelir olarak görünür", async () => {
    const { owner } = await createOwnerOrg();
    const project = await seedProject(owner);
    const category = await seedIncomeCategory(owner);

    const draft = await seedDraft(owner, project.id, category.id, "5000", "0");
    await submitProgressPayment(owner, { id: draft.id });
    await rejectProgressPayment(owner, { id: draft.id, reason: "red" });

    const draft2 = await seedDraft(owner, project.id, category.id, "7000", "0");
    await cancelProgressPayment(owner, { id: draft2.id, reason: "iptal" });

    const draft3 = await seedDraft(owner, project.id, category.id, "9000", "0");
    // hâlâ DRAFT — hiçbir işlem uygulanmadı

    const totalsBeforeApproval = await getOpenAndOverdueTotals(db, { organizationId: owner.organizationId, type: "INCOME" });
    expect(totalsBeforeApproval.open.toString()).toBe("0");

    const draft4 = await seedDraft(owner, project.id, category.id, "11000", "0");
    await submitProgressPayment(owner, { id: draft4.id });
    const { financialTransaction } = await approveProgressPayment(owner, { id: draft4.id });

    const totalsAfterApproval = await getOpenAndOverdueTotals(db, { organizationId: owner.organizationId, type: "INCOME" });
    expect(totalsAfterApproval.open.toString()).toBe("11000");

    const incomes = await listTransactionsForUser(owner, "INCOME");
    expect(incomes).toHaveLength(1);
    expect(incomes[0]?.id).toBe(financialTransaction?.id);
    expect(incomes[0]?.totalAmount.toString()).toBe("11000");

    // draft3 hâlâ DRAFT durumda, hiçbir kanonik kayıt üretmedi
    void draft3;
  });

  it("tahsilat (collection) yalnızca ilişkili gelir kaydını etkiler; hakediş tahakkuk gerçeğini değiştirmez", async () => {
    const { owner } = await createOwnerOrg();
    const project = await seedProject(owner);
    const category = await seedIncomeCategory(owner);
    const account = await createAccount(owner, { name: `Kasa ${key()}`, type: "CASH", currency: "TRY", openingBalance: 0 });

    const draft = await seedDraft(owner, project.id, category.id, "10000", "0");
    await submitProgressPayment(owner, { id: draft.id });
    const { financialTransaction } = await approveProgressPayment(owner, { id: draft.id });

    await createSettlement(owner, {
      transactionId: financialTransaction!.id,
      financialAccountId: account.id,
      amount: 4000,
      settlementDate: new Date(),
      paymentMethod: "NAKIT",
      idempotencyKey: key(),
    });

    const afterCollection = await getProgressPaymentForUser(owner, draft.id);
    expect(afterCollection.status).toBe("APPROVED");
    expect(afterCollection.netAmount.toString()).toBe("10000");
    expect(afterCollection.financialTransaction?.status).toBe("PARTIALLY_PAID");
    expect(afterCollection.financialTransaction?.totalAmount.toString()).toBe("10000");
  });
});

describe("progress-payment-service — proje toplamları (aggregates)", () => {
  it("hiç hakediş yokken tüm toplamlar 0 döner (bölme hatası yok)", async () => {
    const { owner } = await createOwnerOrg();
    const project = await seedProject(owner);

    const aggregates = await getProgressPaymentAggregatesForProject(owner, project.id);
    expect(aggregates).toEqual({ totalSubmitted: "0", totalApproved: "0", totalPaid: "0", totalOutstanding: "0" });
  });

  it("gönderilen/onaylanan/tahsil edilen/kalan alacak doğru hesaplanır; taslak/reddedilmiş/iptal hariç tutulur", async () => {
    const { owner } = await createOwnerOrg();
    const project = await seedProject(owner);
    const category = await seedIncomeCategory(owner);
    const account = await createAccount(owner, { name: `Kasa ${key()}`, type: "CASH", currency: "TRY", openingBalance: 0 });

    // DRAFT — hiçbir toplama girmez
    await seedDraft(owner, project.id, category.id, "1000", "0");

    // SUBMITTED — yalnızca "submitted" toplamına girer
    const submitted = await seedDraft(owner, project.id, category.id, "3000", "0");
    await submitProgressPayment(owner, { id: submitted.id });

    // REJECTED — hiçbir toplama girmez
    const rejected = await seedDraft(owner, project.id, category.id, "4000", "0");
    await submitProgressPayment(owner, { id: rejected.id });
    await rejectProgressPayment(owner, { id: rejected.id, reason: "red" });

    // CANCELLED — hiçbir toplama girmez
    const cancelled = await seedDraft(owner, project.id, category.id, "5000", "0");
    await cancelProgressPayment(owner, { id: cancelled.id, reason: "iptal" });

    // APPROVED, kısmi tahsilat — "approved" tam net tutarla, "paid" kısmi, "outstanding" fark kadar girer
    const approved = await seedDraft(owner, project.id, category.id, "10000", "0");
    await submitProgressPayment(owner, { id: approved.id });
    const { financialTransaction } = await approveProgressPayment(owner, { id: approved.id });
    await createSettlement(owner, {
      transactionId: financialTransaction!.id,
      financialAccountId: account.id,
      amount: 4000,
      settlementDate: new Date(),
      paymentMethod: "NAKIT",
      idempotencyKey: key(),
    });

    const aggregates = await getProgressPaymentAggregatesForProject(owner, project.id);
    expect(aggregates.totalSubmitted).toBe("3000");
    expect(aggregates.totalApproved).toBe("10000");
    expect(aggregates.totalPaid).toBe("4000");
    expect(aggregates.totalOutstanding).toBe("6000");
  });

  it("iptal edilmiş (cancelIncome) bağlı gelir kaydı olan onaylı hakediş 'onaylanan' toplamından hariç tutulur", async () => {
    const { owner } = await createOwnerOrg();
    const project = await seedProject(owner);
    const category = await seedIncomeCategory(owner);

    const draft = await seedDraft(owner, project.id, category.id, "8000", "0");
    await submitProgressPayment(owner, { id: draft.id });
    const { financialTransaction } = await approveProgressPayment(owner, { id: draft.id });

    // Onay sonrası tahsilat yokken bağlı gelir kaydı doğrudan iptal edilebilir
    // (bkz. transaction-service.ts cancelIncome) — hakedişin kendi `status`
    // alanı APPROVED'da kalır, ama gerçek alacak artık geçersizdir.
    await cancelIncome(owner, { id: financialTransaction!.id, reason: "Hatalı tahakkuk" });

    const afterCancel = await getProgressPaymentForUser(owner, draft.id);
    expect(afterCancel.status).toBe("APPROVED");

    // Aynı projede normal (iptal edilmemiş) bir onaylı hakediş daha ekleyip
    // hariç tutmanın kayıt bazında (per-row) çalıştığını, grup bazında
    // (per-status) çalışmadığını kanıtlıyoruz — aksi halde bu ikinci kayıt da
    // yanlışlıkla toplamdan düşerdi.
    const normalDraft = await seedDraft(owner, project.id, category.id, "3000", "0");
    await submitProgressPayment(owner, { id: normalDraft.id });
    await approveProgressPayment(owner, { id: normalDraft.id });

    const aggregates = await getProgressPaymentAggregatesForProject(owner, project.id);
    expect(aggregates.totalApproved).toBe("3000");
    expect(aggregates.totalPaid).toBe("0");
    expect(aggregates.totalOutstanding).toBe("3000");
  });

  it("başka bir projenin/organizasyonun hakedişleri toplamlara karışmaz", async () => {
    const { owner } = await createOwnerOrg();
    const { owner: otherOrgOwner } = await createOwnerOrg();
    const projectA = await seedProject(owner);
    const projectB = await seedProject(owner);
    const categoryA = await seedIncomeCategory(owner);

    const draftA = await seedDraft(owner, projectA.id, categoryA.id, "2000", "0");
    await submitProgressPayment(owner, { id: draftA.id });

    const categoryB = await seedIncomeCategory(owner);
    const draftB = await seedDraft(owner, projectB.id, categoryB.id, "9999", "0");
    await submitProgressPayment(owner, { id: draftB.id });

    const aggregatesA = await getProgressPaymentAggregatesForProject(owner, projectA.id);
    expect(aggregatesA.totalSubmitted).toBe("2000");

    await expect(getProgressPaymentAggregatesForProject(otherOrgOwner, projectA.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
