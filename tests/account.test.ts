import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { cleanDatabase, createOwnerOrg, createOrgUser } from "./helpers";
import {
  createAccount,
  updateAccount,
  archiveAccount,
  reactivateAccount,
  listAccountsForUser,
  getAccountForUser,
} from "@/server/services/account-service";

beforeAll(async () => {
  await cleanDatabase();
});
afterEach(async () => {
  await cleanDatabase();
});
afterAll(async () => {
  await db.$disconnect();
});

const baseInput = {
  name: "Şantiye Kasası",
  type: "CASH" as const,
  bankName: undefined,
  iban: undefined,
  openingBalance: 1000,
  currency: "TRY",
};

describe("kasa/banka hesap yönetimi", () => {
  it("OWNER, ADMIN ve FINANCE hesap oluşturabilir; PROJECT_MANAGER oluşturamaz ve göremez", async () => {
    const { owner } = await createOwnerOrg();
    const admin = await createOrgUser(owner.organizationId, "ADMIN");
    const finance = await createOrgUser(owner.organizationId, "FINANCE");
    const pm = await createOrgUser(owner.organizationId, "PROJECT_MANAGER");

    await expect(createAccount(owner, baseInput)).resolves.toMatchObject({ name: baseInput.name });
    await expect(createAccount(admin, { ...baseInput, name: "Banka - Admin" })).resolves.toMatchObject({
      name: "Banka - Admin",
    });
    await expect(createAccount(finance, { ...baseInput, name: "Banka - Finance" })).resolves.toMatchObject({
      name: "Banka - Finance",
    });
    await expect(createAccount(pm, { ...baseInput, name: "PM Hesabı" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(listAccountsForUser(pm)).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("açılış bakiyesi denetlenebilir bir hesap hareketi olarak kaydedilir", async () => {
    const { owner } = await createOwnerOrg();
    const account = await createAccount(owner, baseInput);

    const movements = await db.accountMovement.findMany({ where: { financialAccountId: account.id } });
    expect(movements).toHaveLength(1);
    expect(movements[0]).toMatchObject({ type: "OPENING", direction: "CREDIT" });
    expect(Number(movements[0].amount)).toBe(1000);

    const detail = await getAccountForUser(owner, account.id);
    expect(detail.balance.toString()).toBe("1000");
  });

  it("aynı organizasyonda aynı isimde ikinci hesap oluşturulamaz", async () => {
    const { owner } = await createOwnerOrg();
    await createAccount(owner, baseInput);
    await expect(createAccount(owner, baseInput)).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("hesap arşivlenip yeniden etkinleştirilebilir; fiziksel olarak silinmez", async () => {
    const { owner } = await createOwnerOrg();
    const account = await createAccount(owner, baseInput);

    await archiveAccount(owner, account.id);
    let updated = await db.financialAccount.findUniqueOrThrow({ where: { id: account.id } });
    expect(updated.isActive).toBe(false);

    await reactivateAccount(owner, account.id);
    updated = await db.financialAccount.findUniqueOrThrow({ where: { id: account.id } });
    expect(updated.isActive).toBe(true);
  });

  it("organizasyon A, organizasyon B'nin hesabına erişemez", async () => {
    const { owner: ownerA } = await createOwnerOrg();
    const { owner: ownerB } = await createOwnerOrg();
    const accountA = await createAccount(ownerA, baseInput);

    const visibleForB = await listAccountsForUser(ownerB);
    expect(visibleForB.find((a) => a.id === accountA.id)).toBeUndefined();
    await expect(getAccountForUser(ownerB, accountA.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(updateAccount(ownerB, { id: accountA.id, name: "Ele geçirildi" })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  it("hesap oluşturma ve arşivleme audit log üretir", async () => {
    const { owner } = await createOwnerOrg();
    const account = await createAccount(owner, baseInput);
    await archiveAccount(owner, account.id);

    const logs = await db.auditLog.findMany({ where: { entityType: "FinancialAccount", entityId: account.id } });
    expect(logs.map((l) => l.action).sort()).toEqual(["account.archive", "account.create"]);
  });
});
