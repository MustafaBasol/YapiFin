import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { cleanDatabase, createOwnerOrg, createOrgUser } from "./helpers";
import { createIncome, createExpense } from "@/server/services/transaction-service";
import { createAccount, archiveAccount } from "@/server/services/account-service";
import { createSettlement, cancelSettlement } from "@/server/services/settlement-service";
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

async function seedIncome(owner: SessionUser, subtotal: number, taxRate = 0) {
  const category = await db.transactionCategory.create({
    data: { organizationId: owner.organizationId, type: "INCOME", name: "Genel" },
  });
  return createIncome(owner, {
    categoryId: category.id,
    description: "Test geliri",
    issueDate: new Date(),
    subtotal,
    taxRate,
  });
}

async function seedExpense(owner: SessionUser, subtotal: number, taxRate = 0) {
  const category = await db.transactionCategory.create({
    data: { organizationId: owner.organizationId, type: "EXPENSE", name: "Genel" },
  });
  return createExpense(owner, {
    categoryId: category.id,
    description: "Test gideri",
    issueDate: new Date(),
    subtotal,
    taxRate,
  });
}

let seq = 0;
function key() {
  seq += 1;
  return `test-key-${seq}-${Math.floor(Math.random() * 1e9)}`;
}

describe("tahsilat ve ödeme (Settlement)", () => {
  it("100.000 TL gelire 40.000 TL sonra 60.000 TL tahsilatla tamamen tahsil edilir", async () => {
    const { owner } = await createOwnerOrg();
    const account = await createAccount(owner, {
      name: "Ana Hesap",
      type: "BANK",
      bankName: undefined,
      iban: undefined,
      openingBalance: 0,
      currency: "TRY",
    });
    const income = await seedIncome(owner, 100000, 0);

    await createSettlement(owner, {
      transactionId: income.id,
      financialAccountId: account.id,
      amount: 40000,
      settlementDate: new Date(),
      paymentMethod: "HAVALE_EFT",
      idempotencyKey: key(),
    });
    let updated = await db.financialTransaction.findUniqueOrThrow({ where: { id: income.id } });
    expect(updated.status).toBe("PARTIALLY_PAID");

    await createSettlement(owner, {
      transactionId: income.id,
      financialAccountId: account.id,
      amount: 60000,
      settlementDate: new Date(),
      paymentMethod: "HAVALE_EFT",
      idempotencyKey: key(),
    });
    updated = await db.financialTransaction.findUniqueOrThrow({ where: { id: income.id } });
    expect(updated.status).toBe("PAID");
  });

  it("gelir toplamını aşan tahsilat reddedilir", async () => {
    const { owner } = await createOwnerOrg();
    const account = await createAccount(owner, {
      name: "Ana Hesap",
      type: "BANK",
      bankName: undefined,
      iban: undefined,
      openingBalance: 0,
      currency: "TRY",
    });
    const income = await seedIncome(owner, 100000, 0);

    await expect(
      createSettlement(owner, {
        transactionId: income.id,
        financialAccountId: account.id,
        amount: 100001,
        settlementDate: new Date(),
        paymentMethod: "HAVALE_EFT",
        idempotencyKey: key(),
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("gider toplamını aşan ödeme reddedilir", async () => {
    const { owner } = await createOwnerOrg();
    const account = await createAccount(owner, {
      name: "Ana Hesap",
      type: "BANK",
      bankName: undefined,
      iban: undefined,
      openingBalance: 100000,
      currency: "TRY",
    });
    const expense = await seedExpense(owner, 50000, 0);

    await expect(
      createSettlement(owner, {
        transactionId: expense.id,
        financialAccountId: account.id,
        amount: 50001,
        settlementDate: new Date(),
        paymentMethod: "HAVALE_EFT",
        idempotencyKey: key(),
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("ödeme, hesap bakiyesini negatife düşürüyorsa reddedilir", async () => {
    const { owner } = await createOwnerOrg();
    const account = await createAccount(owner, {
      name: "Yetersiz Bakiye",
      type: "BANK",
      bankName: undefined,
      iban: undefined,
      openingBalance: 100,
      currency: "TRY",
    });
    const expense = await seedExpense(owner, 5000, 0);

    await expect(
      createSettlement(owner, {
        transactionId: expense.id,
        financialAccountId: account.id,
        amount: 1000,
        settlementDate: new Date(),
        paymentMethod: "NAKIT",
        idempotencyKey: key(),
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("arşivlenmiş hesaba tahsilat/ödeme girilemez", async () => {
    const { owner } = await createOwnerOrg();
    const account = await createAccount(owner, {
      name: "Arşivlenecek",
      type: "BANK",
      bankName: undefined,
      iban: undefined,
      openingBalance: 0,
      currency: "TRY",
    });
    await archiveAccount(owner, account.id);
    const income = await seedIncome(owner, 1000, 0);

    await expect(
      createSettlement(owner, {
        transactionId: income.id,
        financialAccountId: account.id,
        amount: 500,
        settlementDate: new Date(),
        paymentMethod: "NAKIT",
        idempotencyKey: key(),
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("aynı idempotencyKey ile mükerrer gönderim ikinci hareket yaratmaz", async () => {
    const { owner } = await createOwnerOrg();
    const account = await createAccount(owner, {
      name: "Ana Hesap",
      type: "BANK",
      bankName: undefined,
      iban: undefined,
      openingBalance: 0,
      currency: "TRY",
    });
    const income = await seedIncome(owner, 1000, 0);
    const idempotencyKey = key();

    const input = {
      transactionId: income.id,
      financialAccountId: account.id,
      amount: 500,
      settlementDate: new Date(),
      paymentMethod: "NAKIT" as const,
      idempotencyKey,
    };
    const first = await createSettlement(owner, input);
    const second = await createSettlement(owner, input);
    expect(second.id).toBe(first.id);

    const settlements = await db.settlement.findMany({ where: { transactionId: income.id } });
    expect(settlements).toHaveLength(1);
  });

  it("eşzamanlı iki tahsilat kalan tutarı aşamaz (gerçek PostgreSQL yarışı)", async () => {
    const { owner } = await createOwnerOrg();
    const account = await createAccount(owner, {
      name: "Yarış Hesabı",
      type: "BANK",
      bankName: undefined,
      iban: undefined,
      openingBalance: 0,
      currency: "TRY",
    });
    const income = await seedIncome(owner, 100000, 0);

    const results = await Promise.allSettled([
      createSettlement(owner, {
        transactionId: income.id,
        financialAccountId: account.id,
        amount: 70000,
        settlementDate: new Date(),
        paymentMethod: "HAVALE_EFT",
        idempotencyKey: key(),
      }),
      createSettlement(owner, {
        transactionId: income.id,
        financialAccountId: account.id,
        amount: 70000,
        settlementDate: new Date(),
        paymentMethod: "HAVALE_EFT",
        idempotencyKey: key(),
      }),
    ]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);

    const settled = await db.settlement.aggregate({
      where: { transactionId: income.id, status: "ACTIVE" },
      _sum: { amount: true },
    });
    expect(Number(settled._sum.amount)).toBeLessThanOrEqual(100000);
    expect(Number(settled._sum.amount)).toBe(70000);
  });

  it("eşzamanlı iki ödeme hesap bakiyesini negatife düşüremez (gerçek PostgreSQL yarışı)", async () => {
    const { owner } = await createOwnerOrg();
    const account = await createAccount(owner, {
      name: "Yarış Ödeme Hesabı",
      type: "BANK",
      bankName: undefined,
      iban: undefined,
      openingBalance: 100000,
      currency: "TRY",
    });
    const expense = await seedExpense(owner, 200000, 0);

    const results = await Promise.allSettled([
      createSettlement(owner, {
        transactionId: expense.id,
        financialAccountId: account.id,
        amount: 70000,
        settlementDate: new Date(),
        paymentMethod: "HAVALE_EFT",
        idempotencyKey: key(),
      }),
      createSettlement(owner, {
        transactionId: expense.id,
        financialAccountId: account.id,
        amount: 70000,
        settlementDate: new Date(),
        paymentMethod: "HAVALE_EFT",
        idempotencyKey: key(),
      }),
    ]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    expect(fulfilled).toHaveLength(1);

    const movements = await db.accountMovement.findMany({ where: { financialAccountId: account.id } });
    const debit = movements.filter((m) => m.direction === "DEBIT").reduce((sum, m) => sum + Number(m.amount), 0);
    expect(100000 - debit).toBeGreaterThanOrEqual(0);
  });

  it("tahsilat iptali ters kayıt oluşturur ve kalan tutarı yeniden açar; tekrar iptal edilemez", async () => {
    const { owner } = await createOwnerOrg();
    const account = await createAccount(owner, {
      name: "Ana Hesap",
      type: "BANK",
      bankName: undefined,
      iban: undefined,
      openingBalance: 0,
      currency: "TRY",
    });
    const income = await seedIncome(owner, 1000, 0);

    const settlement = await createSettlement(owner, {
      transactionId: income.id,
      financialAccountId: account.id,
      amount: 1000,
      settlementDate: new Date(),
      paymentMethod: "NAKIT",
      idempotencyKey: key(),
    });

    let tx = await db.financialTransaction.findUniqueOrThrow({ where: { id: income.id } });
    expect(tx.status).toBe("PAID");

    await cancelSettlement(owner, { id: settlement.id, reason: "Yanlış hesaba girildi" });

    tx = await db.financialTransaction.findUniqueOrThrow({ where: { id: income.id } });
    expect(tx.status).toBe("OPEN");

    const movements = await db.accountMovement.findMany({
      where: { settlementId: settlement.id },
      orderBy: { createdAt: "asc" },
    });
    expect(movements.map((m) => m.type)).toEqual(["COLLECTION", "REVERSAL"]);
    expect(movements[1].direction).toBe("DEBIT");

    await expect(cancelSettlement(owner, { id: settlement.id, reason: "Tekrar" })).rejects.toMatchObject({
      code: "CONFLICT",
    });
  });

  it("FINANCE tahsilat girebilir, PROJECT_MANAGER giremez", async () => {
    const { owner } = await createOwnerOrg();
    const finance = await createOrgUser(owner.organizationId, "FINANCE");
    const pm = await createOrgUser(owner.organizationId, "PROJECT_MANAGER");
    const account = await createAccount(owner, {
      name: "Ana Hesap",
      type: "BANK",
      bankName: undefined,
      iban: undefined,
      openingBalance: 0,
      currency: "TRY",
    });
    const income = await seedIncome(owner, 1000, 0);

    await expect(
      createSettlement(finance, {
        transactionId: income.id,
        financialAccountId: account.id,
        amount: 500,
        settlementDate: new Date(),
        paymentMethod: "NAKIT",
        idempotencyKey: key(),
      }),
    ).resolves.toMatchObject({ amount: expect.anything() });

    await expect(
      createSettlement(pm, {
        transactionId: income.id,
        financialAccountId: account.id,
        amount: 100,
        settlementDate: new Date(),
        paymentMethod: "NAKIT",
        idempotencyKey: key(),
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("tahsilat/ödeme oluşturma ve iptal audit log üretir", async () => {
    const { owner } = await createOwnerOrg();
    const account = await createAccount(owner, {
      name: "Ana Hesap",
      type: "BANK",
      bankName: undefined,
      iban: undefined,
      openingBalance: 0,
      currency: "TRY",
    });
    const income = await seedIncome(owner, 1000, 0);
    const settlement = await createSettlement(owner, {
      transactionId: income.id,
      financialAccountId: account.id,
      amount: 1000,
      settlementDate: new Date(),
      paymentMethod: "NAKIT",
      idempotencyKey: key(),
    });
    await cancelSettlement(owner, { id: settlement.id, reason: "test" });

    const logs = await db.auditLog.findMany({ where: { entityType: "Settlement", entityId: settlement.id } });
    expect(logs.map((l) => l.action).sort()).toEqual(["settlement.cancel", "settlement.create"]);
  });
});
