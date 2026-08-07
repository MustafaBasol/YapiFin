import { db } from "@/lib/db";
import { writeAuditLog } from "@/lib/audit";
import { canCancelFinancialRecord, canRecordTransfer, canViewCashAndBank } from "@/lib/permissions";
import { conflict, forbidden, notFound } from "@/server/services/errors";
import { getAccountBalance, lockAccount, lockTransfer, toDecimal, ZERO } from "@/server/services/ledger";
import type { SessionUser } from "@/lib/auth/session";
import type { CancelTransferInput, CreateTransferInput } from "@/lib/validation/transfer";

/**
 * Hesaplar arası transfer — YF-305. Çıkış ve giriş hareketi aynı veritabanı
 * işleminde, tek taraflı (yarım) transfer durumu oluşmadan yaratılır.
 * Deadlock'u önlemek için iki hesap her zaman id sırasına göre kilitlenir
 * (kaynak/hedef rolünden bağımsız); böylece A→B ve B→A eşzamanlı transferleri
 * aynı kilit sırasını izler. Negatif bakiye varsayılan olarak engellenir
 * (docs/SECURITY.md §3 — MVP ürün kararı, bkz. teslimat raporu).
 */
export async function createTransfer(actor: SessionUser, input: CreateTransferInput) {
  if (!canRecordTransfer(actor.role)) throw forbidden();
  if (input.fromAccountId === input.toAccountId) throw conflict("Kaynak ve hedef hesap aynı olamaz");

  const [firstId, secondId] = [input.fromAccountId, input.toAccountId].sort();

  try {
    return await db.$transaction(async (tx) => {
      const first = await lockAccount(tx, actor.organizationId, firstId);
      const second = await lockAccount(tx, actor.organizationId, secondId);
      const fromAccount = first.id === input.fromAccountId ? first : second;
      const toAccount = first.id === input.toAccountId ? first : second;

      if (!fromAccount.isActive) throw conflict("Kaynak hesap pasif, transfer yapılamaz");
      if (!toAccount.isActive) throw conflict("Hedef hesap pasif, transfer yapılamaz");
      if (fromAccount.currency !== toAccount.currency) {
        throw conflict("Kaynak ve hedef hesabın para birimi aynı olmalıdır");
      }

      const amount = toDecimal(input.amount);
      const fromBalance = await getAccountBalance(tx, fromAccount.id);
      if (fromBalance.minus(amount).lessThan(ZERO)) {
        throw conflict("Bu transfer kaynak hesabın bakiyesini negatife düşürür");
      }

      const transfer = await tx.accountTransfer.create({
        data: {
          organizationId: actor.organizationId,
          fromAccountId: fromAccount.id,
          toAccountId: toAccount.id,
          amount,
          transferDate: input.transferDate,
          description: input.description || null,
          status: "ACTIVE",
          createdById: actor.id,
          idempotencyKey: input.idempotencyKey,
        },
      });

      await tx.accountMovement.create({
        data: {
          organizationId: actor.organizationId,
          financialAccountId: fromAccount.id,
          type: "TRANSFER_OUT",
          direction: "DEBIT",
          amount,
          occurredAt: input.transferDate,
          transferId: transfer.id,
          description: `Transfer çıkışı: ${fromAccount.name} → ${toAccount.name}`,
          createdById: actor.id,
        },
      });
      await tx.accountMovement.create({
        data: {
          organizationId: actor.organizationId,
          financialAccountId: toAccount.id,
          type: "TRANSFER_IN",
          direction: "CREDIT",
          amount,
          occurredAt: input.transferDate,
          transferId: transfer.id,
          description: `Transfer girişi: ${fromAccount.name} → ${toAccount.name}`,
          createdById: actor.id,
        },
      });

      await writeAuditLog(tx, {
        organizationId: actor.organizationId,
        actorId: actor.id,
        action: "transfer.create",
        entityType: "AccountTransfer",
        entityId: transfer.id,
        after: { fromAccountId: fromAccount.id, toAccountId: toAccount.id, amount: amount.toString() },
      });

      return transfer;
    });
  } catch (err) {
    if ((err as { code?: string })?.code === "P2002") {
      const existing = await db.accountTransfer.findUnique({ where: { idempotencyKey: input.idempotencyKey } });
      if (existing) return existing;
      throw conflict("Bu işlem daha önce gönderilmiş");
    }
    throw err;
  }
}

export async function cancelTransfer(actor: SessionUser, input: CancelTransferInput) {
  if (!canCancelFinancialRecord(actor.role)) throw forbidden();

  const transfer = await db.accountTransfer.findFirst({
    where: { id: input.id, organizationId: actor.organizationId },
    include: { movements: true },
  });
  if (!transfer) throw notFound("Transfer bulunamadı");
  if (transfer.status === "CANCELLED") throw conflict("Bu transfer zaten iptal edilmiş");

  const outMovement = transfer.movements.find((m) => m.type === "TRANSFER_OUT");
  const inMovement = transfer.movements.find((m) => m.type === "TRANSFER_IN");
  if (!outMovement || !inMovement) throw conflict("Orijinal transfer hareketleri bulunamadı");

  return db.$transaction(async (tx) => {
    // Satır kilidi altında durumu yeniden oku — bkz. settlement-service.ts
    // cancelSettlement ile aynı gerekçe: kilitsiz `findFirst` ile hesap
    // kilitleri arasındaki pencerede aynı transfere karşı eşzamanlı ikinci
    // bir iptal isteği, ilk istek commit olana kadar burada bekler ve
    // ardından "zaten iptal edilmiş" olarak reddedilir; böylece mükerrer
    // REVERSAL hareketi (çift ters kayıt) oluşamaz (bkz. YF-502 regresyon
    // testi).
    const lockedTransfer = await lockTransfer(tx, actor.organizationId, transfer.id);
    if (lockedTransfer.status === "CANCELLED") throw conflict("Bu transfer zaten iptal edilmiş");

    // Kilit sonrası hesap seçimi ve deterministik kilit sırası (firstId/
    // secondId) yalnızca lockedTransfer'ın alanlarından türetilir; kilit
    // öncesi `transfer` değişkeni bu noktadan sonra yalnızca hareket
    // (movement) kayıtlarını bulmak için kullanılmıştı, artık başka bir
    // yazma kararında kaynak olarak kullanılmaz.
    const [firstId, secondId] = [lockedTransfer.fromAccountId, lockedTransfer.toAccountId].sort();
    const first = await lockAccount(tx, actor.organizationId, firstId);
    const second = await lockAccount(tx, actor.organizationId, secondId);
    const fromAccount = first.id === lockedTransfer.fromAccountId ? first : second;
    const toAccount = first.id === lockedTransfer.toAccountId ? first : second;

    // Hedef hesaptan tutarı geri almak (ters kayıt) bakiyeyi negatife
    // düşürebilir — kontrol edilir.
    const toBalance = await getAccountBalance(tx, toAccount.id);
    if (toBalance.minus(toDecimal(lockedTransfer.amount)).lessThan(ZERO)) {
      throw conflict("Bu ters kayıt hedef hesabın bakiyesini negatife düşürür");
    }

    await tx.accountMovement.create({
      data: {
        organizationId: actor.organizationId,
        financialAccountId: fromAccount.id,
        type: "REVERSAL",
        direction: "CREDIT",
        amount: outMovement.amount,
        occurredAt: new Date(),
        transferId: lockedTransfer.id,
        description: `İptal: ${outMovement.description}`,
        createdById: actor.id,
      },
    });
    await tx.accountMovement.create({
      data: {
        organizationId: actor.organizationId,
        financialAccountId: toAccount.id,
        type: "REVERSAL",
        direction: "DEBIT",
        amount: inMovement.amount,
        occurredAt: new Date(),
        transferId: lockedTransfer.id,
        description: `İptal: ${inMovement.description}`,
        createdById: actor.id,
      },
    });

    const updated = await tx.accountTransfer.update({
      where: { id: lockedTransfer.id },
      data: {
        status: "CANCELLED",
        cancelledAt: new Date(),
        cancelledById: actor.id,
        cancellationReason: input.reason,
      },
    });

    await writeAuditLog(tx, {
      organizationId: actor.organizationId,
      actorId: actor.id,
      action: "transfer.cancel",
      entityType: "AccountTransfer",
      entityId: lockedTransfer.id,
      before: { status: "ACTIVE" },
      after: { status: "CANCELLED", reason: input.reason },
    });

    return updated;
  });
}

export async function listTransfersForUser(user: SessionUser) {
  if (!canViewCashAndBank(user.role)) throw forbidden();
  return db.accountTransfer.findMany({
    where: { organizationId: user.organizationId },
    orderBy: { transferDate: "desc" },
    include: { fromAccount: true, toAccount: true },
  });
}

export async function getTransferForUser(user: SessionUser, id: string) {
  if (!canViewCashAndBank(user.role)) throw forbidden();
  const transfer = await db.accountTransfer.findFirst({
    where: { id, organizationId: user.organizationId },
    include: { fromAccount: true, toAccount: true, movements: true },
  });
  if (!transfer) throw notFound("Transfer bulunamadı");
  return transfer;
}
