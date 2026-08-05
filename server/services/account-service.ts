import { db } from "@/lib/db";
import { writeAuditLog } from "@/lib/audit";
import { canManageAccounts, canViewCashAndBank } from "@/lib/permissions";
import { forbidden, notFound, conflict } from "@/server/services/errors";
import { getAccountBalance } from "@/server/services/ledger";
import type { SessionUser } from "@/lib/auth/session";
import type { CreateAccountInput, UpdateAccountInput } from "@/lib/validation/account";

/**
 * Kasa/banka hesapları organizasyon geneli finansal ana kayıtlardır.
 * PROJECT_MANAGER bu modüle hiç erişemez (docs/SECURITY.md §1) — Kasa/banka
 * bakiyesi satırı PM için her zaman "Hayır".
 */
export async function listAccountsForUser(user: SessionUser) {
  if (!canViewCashAndBank(user.role)) throw forbidden();

  const accounts = await db.financialAccount.findMany({
    where: { organizationId: user.organizationId },
    orderBy: { name: "asc" },
  });

  return Promise.all(
    accounts.map(async (account) => ({
      ...account,
      balance: await getAccountBalance(db, account.id),
    })),
  );
}

export async function listActiveAccountsForUser(user: SessionUser) {
  if (!canViewCashAndBank(user.role)) throw forbidden();
  return db.financialAccount.findMany({
    where: { organizationId: user.organizationId, isActive: true },
    orderBy: { name: "asc" },
  });
}

export async function getAccountForUser(user: SessionUser, accountId: string) {
  if (!canViewCashAndBank(user.role)) throw forbidden();

  const account = await db.financialAccount.findFirst({
    where: { id: accountId, organizationId: user.organizationId },
  });
  if (!account) throw notFound("Hesap bulunamadı");

  const [balance, movements] = await Promise.all([
    getAccountBalance(db, account.id),
    db.accountMovement.findMany({
      where: { financialAccountId: account.id },
      orderBy: { occurredAt: "desc" },
      take: 100,
    }),
  ]);

  return { ...account, balance, movements };
}

export async function createAccount(actor: SessionUser, input: CreateAccountInput) {
  if (!canManageAccounts(actor.role)) throw forbidden();

  return db
    .$transaction(async (tx) => {
      const account = await tx.financialAccount.create({
        data: {
          organizationId: actor.organizationId,
          name: input.name,
          type: input.type,
          bankName: input.bankName || null,
          iban: input.iban || null,
          currency: input.currency,
          openingBalance: input.openingBalance,
        },
      });

      // Açılış bakiyesi mutable bir alan değil, denetlenebilir bir hesap
      // hareketidir — bkz. görev talimatları "opening balance must be an
      // auditable opening movement".
      await tx.accountMovement.create({
        data: {
          organizationId: actor.organizationId,
          financialAccountId: account.id,
          type: "OPENING",
          direction: "CREDIT",
          amount: input.openingBalance,
          occurredAt: account.createdAt,
          description: "Açılış bakiyesi",
          createdById: actor.id,
        },
      });

      await writeAuditLog(tx, {
        organizationId: actor.organizationId,
        actorId: actor.id,
        action: "account.create",
        entityType: "FinancialAccount",
        entityId: account.id,
        after: { name: account.name, type: account.type, openingBalance: input.openingBalance.toString() },
      });

      return account;
    })
    .catch((err) => {
      if (err?.code === "P2002") throw conflict("Bu isimde bir hesap zaten var");
      throw err;
    });
}

export async function updateAccount(actor: SessionUser, input: UpdateAccountInput) {
  if (!canManageAccounts(actor.role)) throw forbidden();

  const existing = await db.financialAccount.findFirst({
    where: { id: input.id, organizationId: actor.organizationId },
  });
  if (!existing) throw notFound("Hesap bulunamadı");

  return db
    .$transaction(async (tx) => {
      const updated = await tx.financialAccount.update({
        where: { id: existing.id },
        data: { name: input.name, bankName: input.bankName || null, iban: input.iban || null },
      });
      await writeAuditLog(tx, {
        organizationId: actor.organizationId,
        actorId: actor.id,
        action: "account.update",
        entityType: "FinancialAccount",
        entityId: updated.id,
        before: { name: existing.name, bankName: existing.bankName, iban: existing.iban },
        after: { name: updated.name, bankName: updated.bankName, iban: updated.iban },
      });
      return updated;
    })
    .catch((err) => {
      if (err?.code === "P2002") throw conflict("Bu isimde bir hesap zaten var");
      throw err;
    });
}

async function setAccountActive(actor: SessionUser, accountId: string, isActive: boolean) {
  if (!canManageAccounts(actor.role)) throw forbidden();

  const existing = await db.financialAccount.findFirst({
    where: { id: accountId, organizationId: actor.organizationId },
  });
  if (!existing) throw notFound("Hesap bulunamadı");

  return db.$transaction(async (tx) => {
    const updated = await tx.financialAccount.update({ where: { id: existing.id }, data: { isActive } });
    await writeAuditLog(tx, {
      organizationId: actor.organizationId,
      actorId: actor.id,
      action: isActive ? "account.reactivate" : "account.archive",
      entityType: "FinancialAccount",
      entityId: existing.id,
    });
    return updated;
  });
}

export const archiveAccount = (actor: SessionUser, accountId: string) => setAccountActive(actor, accountId, false);
export const reactivateAccount = (actor: SessionUser, accountId: string) => setAccountActive(actor, accountId, true);
