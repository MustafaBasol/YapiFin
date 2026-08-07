import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { cleanDatabase, createOwnerOrg, createOrgUser } from "./helpers";
import {
  createIncome,
  createExpense,
  updateIncome,
  cancelIncome,
  listTransactionsForUser,
  getTransactionForUser,
} from "@/server/services/transaction-service";
import { createProject } from "@/server/services/project-service";
import { createCustomer } from "@/server/services/customer-service";
import { createSupplier } from "@/server/services/supplier-service";

beforeAll(async () => {
  await cleanDatabase();
});
afterEach(async () => {
  await cleanDatabase();
});
afterAll(async () => {
  await db.$disconnect();
});

async function seedCategory(organizationId: string, type: "INCOME" | "EXPENSE", name = "Genel") {
  return db.transactionCategory.create({ data: { organizationId, type, name } });
}

describe("gelir kayıtları", () => {
  it("OWNER/ADMIN/FINANCE gelir oluşturabilir; PROJECT_MANAGER oluşturamaz", async () => {
    const { owner } = await createOwnerOrg();
    const finance = await createOrgUser(owner.organizationId, "FINANCE");
    const pm = await createOrgUser(owner.organizationId, "PROJECT_MANAGER");
    const category = await seedCategory(owner.organizationId, "INCOME");

    const input = {
      categoryId: category.id,
      description: "Hakediş 1",
      issueDate: new Date(),
      subtotal: 100000,
      taxRate: 20,
    };
    await expect(createIncome(owner, input)).resolves.toMatchObject({ totalAmount: expect.anything() });
    await expect(createIncome(finance, input)).resolves.toMatchObject({ description: "Hakediş 1" });
    await expect(createIncome(pm, input)).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("KDV ve toplam tutar ondalık hassasiyetle doğru hesaplanır", async () => {
    const { owner } = await createOwnerOrg();
    const category = await seedCategory(owner.organizationId, "INCOME");

    const record = await createIncome(owner, {
      categoryId: category.id,
      description: "Ara ödeme",
      issueDate: new Date(),
      subtotal: 1234.56,
      taxRate: 18,
    });

    expect(record.subtotal.toString()).toBe("1234.56");
    expect(record.taxAmount.toString()).toBe("222.22"); // 1234.56 * 0.18 = 222.2208 -> 222.22
    expect(record.totalAmount.toString()).toBe("1456.78");
  });

  it("kategori başka organizasyona aitse reddedilir", async () => {
    const { owner: ownerA } = await createOwnerOrg();
    const { owner: ownerB } = await createOwnerOrg();
    const categoryB = await seedCategory(ownerB.organizationId, "INCOME");

    await expect(
      createIncome(ownerA, {
        categoryId: categoryB.id,
        description: "Çapraz kiralık kategori",
        issueDate: new Date(),
        subtotal: 100,
        taxRate: 0,
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("müşteri başka organizasyona aitse reddedilir", async () => {
    const { owner: ownerA } = await createOwnerOrg();
    const { owner: ownerB } = await createOwnerOrg();
    const category = await seedCategory(ownerA.organizationId, "INCOME");
    const customerB = await createCustomer(ownerB, {
      type: "COMPANY",
      name: "B Müşterisi",
      identityOrTaxNumber: undefined,
      taxOffice: undefined,
      contactName: undefined,
      phone: undefined,
      email: undefined,
      city: undefined,
      district: undefined,
      address: undefined,
    });

    await expect(
      createIncome(ownerA, {
        categoryId: category.id,
        customerId: customerB.id,
        description: "Çapraz müşteri",
        issueDate: new Date(),
        subtotal: 100,
        taxRate: 0,
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("vadesi geçmiş ve tahsil edilmemiş gelir OVERDUE olarak görünür", async () => {
    const { owner } = await createOwnerOrg();
    const category = await seedCategory(owner.organizationId, "INCOME");
    const past = new Date();
    past.setDate(past.getDate() - 5);

    const record = await createIncome(owner, {
      categoryId: category.id,
      description: "Vadesi geçmiş",
      issueDate: past,
      dueDate: past,
      subtotal: 500,
      taxRate: 0,
    });

    const detail = await getTransactionForUser(owner, record.id, "INCOME");
    expect(detail.status).toBe("OVERDUE");
  });

  it("iptal edilmiş kayıt tekrar iptal edilemez ve düzenlenemez", async () => {
    const { owner } = await createOwnerOrg();
    const category = await seedCategory(owner.organizationId, "INCOME");
    const record = await createIncome(owner, {
      categoryId: category.id,
      description: "İptal edilecek",
      issueDate: new Date(),
      subtotal: 500,
      taxRate: 0,
    });

    await cancelIncome(owner, { id: record.id, reason: "Yanlış girildi" });
    await expect(cancelIncome(owner, { id: record.id, reason: "Tekrar" })).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(
      updateIncome(owner, {
        id: record.id,
        categoryId: category.id,
        description: "Değişti",
        issueDate: new Date(),
        subtotal: 600,
        taxRate: 0,
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    const cancelled = await db.financialTransaction.findUniqueOrThrow({ where: { id: record.id } });
    expect(cancelled.status).toBe("CANCELLED");
    expect(cancelled.cancellationReason).toBe("Yanlış girildi");
  });

  it("eşzamanlı iki iptal isteği aynı gelire karşı mükerrer audit log üretemez (gerçek PostgreSQL yarışı, YF-502 regresyonu)", async () => {
    const { owner } = await createOwnerOrg();
    const category = await seedCategory(owner.organizationId, "INCOME");
    const record = await createIncome(owner, {
      categoryId: category.id,
      description: "Eşzamanlı iptal testi",
      issueDate: new Date(),
      subtotal: 500,
      taxRate: 0,
    });

    const results = await Promise.allSettled([
      cancelIncome(owner, { id: record.id, reason: "Eşzamanlı iptal 1" }),
      cancelIncome(owner, { id: record.id, reason: "Eşzamanlı iptal 2" }),
    ]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({ code: "CONFLICT" });

    const logs = await db.auditLog.findMany({ where: { entityType: "FinancialTransaction", entityId: record.id } });
    expect(logs.map((l) => l.action).sort()).toEqual(["income.cancel", "income.create"]);
  });

  it("gelir oluşturma ve iptal audit log üretir", async () => {
    const { owner } = await createOwnerOrg();
    const category = await seedCategory(owner.organizationId, "INCOME");
    const record = await createIncome(owner, {
      categoryId: category.id,
      description: "Audit testi",
      issueDate: new Date(),
      subtotal: 500,
      taxRate: 0,
    });
    await cancelIncome(owner, { id: record.id, reason: "test" });

    const logs = await db.auditLog.findMany({ where: { entityType: "FinancialTransaction", entityId: record.id } });
    expect(logs.map((l) => l.action).sort()).toEqual(["income.cancel", "income.create"]);
  });
});

describe("gider kayıtları ve PROJECT_MANAGER kapsamı", () => {
  it("PROJECT_MANAGER yalnızca atandığı projeye gider girebilir", async () => {
    const { owner } = await createOwnerOrg();
    const pm = await createOrgUser(owner.organizationId, "PROJECT_MANAGER");
    const category = await seedCategory(owner.organizationId, "EXPENSE");
    const assignedProject = await createProject(owner, {
      code: "P-1",
      name: "Atanan Proje",
      contractAmount: 0,
      estimatedBudget: 0,
    });
    const otherProject = await createProject(owner, {
      code: "P-2",
      name: "Atanmayan Proje",
      contractAmount: 0,
      estimatedBudget: 0,
    });
    await db.projectMember.create({
      data: { organizationId: owner.organizationId, projectId: assignedProject.id, userId: pm.id },
    });

    await expect(
      createExpense(pm, {
        projectId: assignedProject.id,
        categoryId: category.id,
        description: "Malzeme",
        issueDate: new Date(),
        subtotal: 1000,
        taxRate: 20,
      }),
    ).resolves.toMatchObject({ projectId: assignedProject.id });

    await expect(
      createExpense(pm, {
        projectId: otherProject.id,
        categoryId: category.id,
        description: "Yetkisiz proje",
        issueDate: new Date(),
        subtotal: 1000,
        taxRate: 20,
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    await expect(
      createExpense(pm, {
        categoryId: category.id,
        description: "Projesiz gider",
        issueDate: new Date(),
        subtotal: 1000,
        taxRate: 20,
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("PROJECT_MANAGER yalnızca atandığı projelerin giderlerini listeler", async () => {
    const { owner } = await createOwnerOrg();
    const pm = await createOrgUser(owner.organizationId, "PROJECT_MANAGER");
    const category = await seedCategory(owner.organizationId, "EXPENSE");
    const assignedProject = await createProject(owner, {
      code: "P-3",
      name: "Atanan",
      contractAmount: 0,
      estimatedBudget: 0,
    });
    const otherProject = await createProject(owner, {
      code: "P-4",
      name: "Atanmayan",
      contractAmount: 0,
      estimatedBudget: 0,
    });
    await db.projectMember.create({
      data: { organizationId: owner.organizationId, projectId: assignedProject.id, userId: pm.id },
    });

    const assignedExpense = await createExpense(owner, {
      projectId: assignedProject.id,
      categoryId: category.id,
      description: "Atanan gider",
      issueDate: new Date(),
      subtotal: 100,
      taxRate: 0,
    });
    const otherExpense = await createExpense(owner, {
      projectId: otherProject.id,
      categoryId: category.id,
      description: "Atanmayan gider",
      issueDate: new Date(),
      subtotal: 100,
      taxRate: 0,
    });

    const visible = await listTransactionsForUser(pm, "EXPENSE");
    expect(visible.map((r) => r.id)).toContain(assignedExpense.id);
    expect(visible.map((r) => r.id)).not.toContain(otherExpense.id);
    await expect(getTransactionForUser(pm, otherExpense.id, "EXPENSE")).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("tedarikçi başka organizasyona aitse reddedilir", async () => {
    const { owner: ownerA } = await createOwnerOrg();
    const { owner: ownerB } = await createOwnerOrg();
    const category = await seedCategory(ownerA.organizationId, "EXPENSE");
    const supplierB = await createSupplier(ownerB, {
      type: "SUPPLIER",
      name: "B Tedarikçisi",
      identityOrTaxNumber: undefined,
      taxOffice: undefined,
      contactName: undefined,
      phone: undefined,
      email: undefined,
      city: undefined,
      district: undefined,
      address: undefined,
    });

    await expect(
      createExpense(ownerA, {
        supplierId: supplierB.id,
        categoryId: category.id,
        description: "Çapraz tedarikçi",
        issueDate: new Date(),
        subtotal: 100,
        taxRate: 0,
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
