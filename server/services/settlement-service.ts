import type { MovementDirection, MovementType, SettlementType, TransactionType } from "@prisma/client";
import { db } from "@/lib/db";
import { writeAuditLog } from "@/lib/audit";
import { canCancelFinancialRecord, canRecordSettlement } from "@/lib/permissions";
import { conflict, forbidden, notFound } from "@/server/services/errors";
import {
  deriveTransactionStatus,
  getAccountBalance,
  getSettledAmount,
  lockAccount,
  lockSettlement,
  lockTransaction,
  toDecimal,
  ZERO,
} from "@/server/services/ledger";
import type { SessionUser } from "@/lib/auth/session";
import type { CancelSettlementInput, CreateSettlementInput } from "@/lib/validation/settlement";

const SETTLEMENT_TYPE_BY_TX: Record<TransactionType, SettlementType> = {
  INCOME: "COLLECTION",
  EXPENSE: "PAYMENT",
};
const MOVEMENT_TYPE_BY_SETTLEMENT: Record<SettlementType, MovementType> = {
  COLLECTION: "COLLECTION",
  PAYMENT: "PAYMENT",
};
const MOVEMENT_DIRECTION_BY_SETTLEMENT: Record<SettlementType, MovementDirection> = {
  COLLECTION: "CREDIT",
  PAYMENT: "DEBIT",
};
const oppositeDirection = (d: MovementDirection): MovementDirection => (d === "CREDIT" ? "DEBIT" : "CREDIT");

/**
 * Tahsilat/ödeme (Settlement) — YF-303. Aynı gelire/gidere birden fazla
 * parçalı tahsilat/ödeme uygulanabilir. Eşzamanlı iki istek aynı kalan
 * tutarı aşamaz: FinancialTransaction ve FinancialAccount satırları
 * `SELECT ... FOR UPDATE` ile kilitlenir (bkz. server/services/ledger.ts),
 * kalan tutar bu kilit altında yeniden hesaplanır. Mükerrer form gönderimi
 * `idempotencyKey` unique kısıtı ile engellenir.
 */
export async function createSettlement(actor: SessionUser, input: CreateSettlementInput) {
  if (!canRecordSettlement(actor.role)) throw forbidden();

  const transaction = await db.financialTransaction.findFirst({
    where: { id: input.transactionId, organizationId: actor.organizationId },
  });
  if (!transaction) throw notFound("Kayıt bulunamadı");
  if (transaction.status === "CANCELLED") throw conflict("İptal edilmiş bir kayda tahsilat/ödeme girilemez");

  const settlementType = SETTLEMENT_TYPE_BY_TX[transaction.type];
  const movementType = MOVEMENT_TYPE_BY_SETTLEMENT[settlementType];
  const direction = MOVEMENT_DIRECTION_BY_SETTLEMENT[settlementType];

  try {
    return await db.$transaction(async (tx) => {
      // Sıra önemli: önce işlem, sonra hesap kilidi — çapraz kilitlenmeyi
      // (deadlock) önlemek için transfer servisiyle aynı sıralama kullanılır.
      const lockedTransaction = await lockTransaction(tx, actor.organizationId, transaction.id);
      const account = await lockAccount(tx, actor.organizationId, input.financialAccountId);
      if (!account.isActive) throw conflict("Pasif hesaba işlem yapılamaz");
      if (account.currency !== lockedTransaction.currency) {
        throw conflict("Hesap para birimi kayıt para birimiyle uyuşmuyor");
      }

      const settledSoFar = await getSettledAmount(tx, lockedTransaction.id);
      const totalAmount = toDecimal(lockedTransaction.totalAmount);
      const remaining = totalAmount.minus(settledSoFar);
      const amount = toDecimal(input.amount);
      if (amount.greaterThan(remaining)) {
        throw conflict(
          settlementType === "COLLECTION"
            ? "Tahsilat toplamı gelir toplamını aşamaz"
            : "Ödeme toplamı gider toplamını aşamaz",
        );
      }

      if (direction === "DEBIT") {
        const currentBalance = await getAccountBalance(tx, account.id);
        if (currentBalance.minus(amount).lessThan(ZERO)) {
          throw conflict("Bu işlem hesap bakiyesini negatife düşürür");
        }
      }

      const settlement = await tx.settlement.create({
        data: {
          organizationId: actor.organizationId,
          transactionId: lockedTransaction.id,
          financialAccountId: account.id,
          type: settlementType,
          amount,
          settlementDate: input.settlementDate,
          paymentMethod: input.paymentMethod,
          referenceNumber: input.referenceNumber || null,
          notes: input.notes || null,
          status: "ACTIVE",
          createdById: actor.id,
          idempotencyKey: input.idempotencyKey,
        },
      });

      await tx.accountMovement.create({
        data: {
          organizationId: actor.organizationId,
          financialAccountId: account.id,
          type: movementType,
          direction,
          amount,
          occurredAt: input.settlementDate,
          settlementId: settlement.id,
          description:
            settlementType === "COLLECTION"
              ? `Tahsilat: ${lockedTransaction.description}`
              : `Ödeme: ${lockedTransaction.description}`,
          createdById: actor.id,
        },
      });

      const newSettledAmount = settledSoFar.plus(amount);
      const newStatus = deriveTransactionStatus({
        totalAmount,
        settledAmount: newSettledAmount,
        dueDate: lockedTransaction.dueDate,
        cancelled: false,
      });
      await tx.financialTransaction.update({
        where: { id: lockedTransaction.id },
        data: { status: newStatus },
      });

      await writeAuditLog(tx, {
        organizationId: actor.organizationId,
        actorId: actor.id,
        action: "settlement.create",
        entityType: "Settlement",
        entityId: settlement.id,
        after: {
          transactionId: lockedTransaction.id,
          financialAccountId: account.id,
          amount: amount.toString(),
          type: settlementType,
        },
      });

      return settlement;
    });
  } catch (err) {
    if ((err as { code?: string })?.code === "P2002") {
      const existing = await db.settlement.findUnique({ where: { idempotencyKey: input.idempotencyKey } });
      if (existing && existing.transactionId === input.transactionId) return existing;
      throw conflict("Bu işlem daha önce gönderilmiş");
    }
    throw err;
  }
}

export async function cancelSettlement(actor: SessionUser, input: CancelSettlementInput) {
  if (!canCancelFinancialRecord(actor.role)) throw forbidden();

  const settlement = await db.settlement.findFirst({
    where: { id: input.id, organizationId: actor.organizationId },
    include: { movements: true },
  });
  if (!settlement) throw notFound("Kayıt bulunamadı");
  if (settlement.status === "CANCELLED") throw conflict("Bu hareket zaten iptal edilmiş");

  const originalMovement = settlement.movements.find((m) => m.type === settlement.type);
  if (!originalMovement) throw conflict("Orijinal hesap hareketi bulunamadı");

  return db.$transaction(async (tx) => {
    // Satır kilidi altında durumu yeniden oku — kilitsiz `findFirst` ile bu
    // kilit arasındaki pencerede aynı settlement'a karşı eşzamanlı ikinci bir
    // iptal isteği, ilk istek commit olana kadar burada bekler ve ardından
    // "zaten iptal edilmiş" olarak reddedilir; böylece mükerrer REVERSAL
    // hareketi (çift ters kayıt) oluşamaz (bkz. YF-502 regresyon testi).
    const lockedSettlement = await lockSettlement(tx, actor.organizationId, settlement.id);
    if (lockedSettlement.status === "CANCELLED") throw conflict("Bu hareket zaten iptal edilmiş");

    // Kilit sonrası transaction/account seçimleri yalnızca lockedSettlement'ın
    // foreign key'lerinden türetilir; kilit öncesi `settlement` değişkeni bu
    // noktadan sonra yalnızca orijinal hareket (movement) kaydını bulmak için
    // kullanılmıştı, artık başka bir yazma kararında kaynak olarak kullanılmaz.
    const transaction = await lockTransaction(tx, actor.organizationId, lockedSettlement.transactionId);
    const account = await lockAccount(tx, actor.organizationId, lockedSettlement.financialAccountId);

    const reversalDirection = oppositeDirection(originalMovement.direction);
    if (reversalDirection === "DEBIT") {
      const currentBalance = await getAccountBalance(tx, account.id);
      if (currentBalance.minus(toDecimal(originalMovement.amount)).lessThan(ZERO)) {
        throw conflict("Bu ters kayıt hesap bakiyesini negatife düşürür");
      }
    }

    await tx.accountMovement.create({
      data: {
        organizationId: actor.organizationId,
        financialAccountId: account.id,
        type: "REVERSAL",
        direction: reversalDirection,
        amount: originalMovement.amount,
        occurredAt: new Date(),
        settlementId: lockedSettlement.id,
        description: `İptal: ${originalMovement.description}`,
        createdById: actor.id,
      },
    });

    const updatedSettlement = await tx.settlement.update({
      where: { id: lockedSettlement.id },
      data: {
        status: "CANCELLED",
        cancelledAt: new Date(),
        cancelledById: actor.id,
        cancellationReason: input.reason,
      },
    });

    const settledAfter = await getSettledAmount(tx, transaction.id);
    const newStatus = deriveTransactionStatus({
      totalAmount: toDecimal(transaction.totalAmount),
      settledAmount: settledAfter,
      dueDate: transaction.dueDate,
      cancelled: transaction.status === "CANCELLED",
    });
    await tx.financialTransaction.update({ where: { id: transaction.id }, data: { status: newStatus } });

    await writeAuditLog(tx, {
      organizationId: actor.organizationId,
      actorId: actor.id,
      action: "settlement.cancel",
      entityType: "Settlement",
      entityId: lockedSettlement.id,
      before: { status: "ACTIVE" },
      after: { status: "CANCELLED", reason: input.reason },
    });

    return updatedSettlement;
  });
}
