import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { cleanDatabase, createOwnerOrg, createOrgUser } from "./helpers";
import { createAccount, archiveAccount } from "@/server/services/account-service";
import { createTransfer, cancelTransfer } from "@/server/services/transfer-service";
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

async function seedAccount(owner: SessionUser, name: string, openingBalance = 0) {
  return createAccount(owner, {
    name,
    type: "BANK",
    bankName: undefined,
    iban: undefined,
    openingBalance,
    currency: "TRY",
  });
}

let seq = 0;
function key() {
  seq += 1;
  return `transfer-key-${seq}-${Math.floor(Math.random() * 1e9)}`;
}

describe("hesaplar arası transfer", () => {
  it("transfer her iki hesapta atomik olarak iki hareket oluşturur", async () => {
    const { owner } = await createOwnerOrg();
    const from = await seedAccount(owner, "Kaynak", 10000);
    const to = await seedAccount(owner, "Hedef", 0);

    const transfer = await createTransfer(owner, {
      fromAccountId: from.id,
      toAccountId: to.id,
      amount: 4000,
      transferDate: new Date(),
      idempotencyKey: key(),
    });

    const movements = await db.accountMovement.findMany({ where: { transferId: transfer.id } });
    expect(movements).toHaveLength(2);
    expect(movements.find((m) => m.financialAccountId === from.id)).toMatchObject({
      type: "TRANSFER_OUT",
      direction: "DEBIT",
    });
    expect(movements.find((m) => m.financialAccountId === to.id)).toMatchObject({
      type: "TRANSFER_IN",
      direction: "CREDIT",
    });
  });

  it("kaynak ve hedef hesap aynı olamaz", async () => {
    const { owner } = await createOwnerOrg();
    const account = await seedAccount(owner, "Tek Hesap", 1000);

    await expect(
      createTransfer(owner, {
        fromAccountId: account.id,
        toAccountId: account.id,
        amount: 100,
        transferDate: new Date(),
        idempotencyKey: key(),
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("kaynak hesap bakiyesini negatife düşüren transfer reddedilir", async () => {
    const { owner } = await createOwnerOrg();
    const from = await seedAccount(owner, "Kaynak", 100);
    const to = await seedAccount(owner, "Hedef", 0);

    await expect(
      createTransfer(owner, {
        fromAccountId: from.id,
        toAccountId: to.id,
        amount: 500,
        transferDate: new Date(),
        idempotencyKey: key(),
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("arşivlenmiş hesap transferde kullanılamaz", async () => {
    const { owner } = await createOwnerOrg();
    const from = await seedAccount(owner, "Kaynak", 1000);
    const to = await seedAccount(owner, "Hedef", 0);
    await archiveAccount(owner, to.id);

    await expect(
      createTransfer(owner, {
        fromAccountId: from.id,
        toAccountId: to.id,
        amount: 100,
        transferDate: new Date(),
        idempotencyKey: key(),
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("başka organizasyonun hesabına transfer edilemez", async () => {
    const { owner: ownerA } = await createOwnerOrg();
    const { owner: ownerB } = await createOwnerOrg();
    const from = await seedAccount(ownerA, "A Hesabı", 1000);
    const toB = await seedAccount(ownerB, "B Hesabı", 0);

    await expect(
      createTransfer(ownerA, {
        fromAccountId: from.id,
        toAccountId: toB.id,
        amount: 100,
        transferDate: new Date(),
        idempotencyKey: key(),
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("mükerrer gönderim (aynı idempotencyKey) ikinci transfer yaratmaz", async () => {
    const { owner } = await createOwnerOrg();
    const from = await seedAccount(owner, "Kaynak", 1000);
    const to = await seedAccount(owner, "Hedef", 0);
    const idempotencyKey = key();

    const input = {
      fromAccountId: from.id,
      toAccountId: to.id,
      amount: 200,
      transferDate: new Date(),
      idempotencyKey,
    };
    const first = await createTransfer(owner, input);
    const second = await createTransfer(owner, input);
    expect(second.id).toBe(first.id);

    const transfers = await db.accountTransfer.findMany({ where: { fromAccountId: from.id } });
    expect(transfers).toHaveLength(1);
  });

  it("eşzamanlı iki transfer kaynak hesabı negatife düşüremez (gerçek PostgreSQL yarışı)", async () => {
    const { owner } = await createOwnerOrg();
    const from = await seedAccount(owner, "Yarış Kaynak", 10000);
    const to = await seedAccount(owner, "Yarış Hedef", 0);

    const results = await Promise.allSettled([
      createTransfer(owner, {
        fromAccountId: from.id,
        toAccountId: to.id,
        amount: 7000,
        transferDate: new Date(),
        idempotencyKey: key(),
      }),
      createTransfer(owner, {
        fromAccountId: from.id,
        toAccountId: to.id,
        amount: 7000,
        transferDate: new Date(),
        idempotencyKey: key(),
      }),
    ]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    expect(fulfilled).toHaveLength(1);

    const movements = await db.accountMovement.findMany({ where: { financialAccountId: from.id } });
    const debit = movements.filter((m) => m.direction === "DEBIT").reduce((sum, m) => sum + Number(m.amount), 0);
    expect(10000 - debit).toBeGreaterThanOrEqual(0);
  });

  it("A→B ve B→A eşzamanlı transferleri kilitlenmeden (deadlock olmadan) tamamlanır", async () => {
    const { owner } = await createOwnerOrg();
    const a = await seedAccount(owner, "A", 10000);
    const b = await seedAccount(owner, "B", 10000);

    const results = await Promise.allSettled([
      createTransfer(owner, { fromAccountId: a.id, toAccountId: b.id, amount: 1000, transferDate: new Date(), idempotencyKey: key() }),
      createTransfer(owner, { fromAccountId: b.id, toAccountId: a.id, amount: 1000, transferDate: new Date(), idempotencyKey: key() }),
    ]);

    expect(results.every((r) => r.status === "fulfilled")).toBe(true);
  });

  it("transfer iptali her iki hesapta ters kayıt oluşturur; tekrar iptal edilemez", async () => {
    const { owner } = await createOwnerOrg();
    const from = await seedAccount(owner, "Kaynak", 5000);
    const to = await seedAccount(owner, "Hedef", 0);

    const transfer = await createTransfer(owner, {
      fromAccountId: from.id,
      toAccountId: to.id,
      amount: 2000,
      transferDate: new Date(),
      idempotencyKey: key(),
    });

    await cancelTransfer(owner, { id: transfer.id, reason: "Yanlış hesap seçildi" });

    const movements = await db.accountMovement.findMany({ where: { transferId: transfer.id } });
    expect(movements).toHaveLength(4);
    const reversals = movements.filter((m) => m.type === "REVERSAL");
    expect(reversals).toHaveLength(2);
    expect(reversals.find((m) => m.financialAccountId === from.id)?.direction).toBe("CREDIT");
    expect(reversals.find((m) => m.financialAccountId === to.id)?.direction).toBe("DEBIT");

    const updated = await db.accountTransfer.findUniqueOrThrow({ where: { id: transfer.id } });
    expect(updated.status).toBe("CANCELLED");

    await expect(cancelTransfer(owner, { id: transfer.id, reason: "Tekrar" })).rejects.toMatchObject({
      code: "CONFLICT",
    });
  });

  it("PROJECT_MANAGER transfer oluşturamaz", async () => {
    const { owner } = await createOwnerOrg();
    const pm = await createOrgUser(owner.organizationId, "PROJECT_MANAGER");
    const from = await seedAccount(owner, "Kaynak", 1000);
    const to = await seedAccount(owner, "Hedef", 0);

    await expect(
      createTransfer(pm, {
        fromAccountId: from.id,
        toAccountId: to.id,
        amount: 100,
        transferDate: new Date(),
        idempotencyKey: key(),
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("transfer oluşturma ve iptal audit log üretir (her iki hesaba referansla)", async () => {
    const { owner } = await createOwnerOrg();
    const from = await seedAccount(owner, "Kaynak", 5000);
    const to = await seedAccount(owner, "Hedef", 0);
    const transfer = await createTransfer(owner, {
      fromAccountId: from.id,
      toAccountId: to.id,
      amount: 1000,
      transferDate: new Date(),
      idempotencyKey: key(),
    });
    await cancelTransfer(owner, { id: transfer.id, reason: "test" });

    const logs = await db.auditLog.findMany({ where: { entityType: "AccountTransfer", entityId: transfer.id } });
    expect(logs.map((l) => l.action).sort()).toEqual(["transfer.cancel", "transfer.create"]);
    const createLog = logs.find((l) => l.action === "transfer.create");
    expect(createLog?.afterJson).toMatchObject({ fromAccountId: from.id, toAccountId: to.id });
  });
});
