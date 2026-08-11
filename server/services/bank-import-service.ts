import { Prisma } from "@prisma/client";
import type { TransactionType } from "@prisma/client";
import { db } from "@/lib/db";
import { writeAuditLog } from "@/lib/audit";
import { canManageAccounts } from "@/lib/permissions";
import { forbidden, notFound, conflict, ServiceError } from "@/server/services/errors";
import { assertCapability } from "@/lib/entitlements/entitlement-service";
import { assertNotBillingRestricted } from "@/lib/billing/billing-restriction-policy";
import { lockBankImportRow } from "@/server/services/ledger";
import { createSettlementInTransaction } from "@/server/services/settlement-service";
import { createTransferInTransaction } from "@/server/services/transfer-service";
import {
  extractRawRows,
  normalizeBankStatementRows,
  computeFileFingerprint,
  type ParsedBankRow,
} from "@/server/services/bank-import/normalize";
import type { SessionUser } from "@/lib/auth/session";

type Tx = Prisma.TransactionClient;

/**
 * YF-602 — Banka ekstresi içe aktarım ve kontrollü mutabakat.
 *
 * Kesin ilke: bu servis TEK BAŞINA hiçbir finansal kayıt (Settlement/
 * AccountTransfer/AccountMovement) OLUŞTURMAZ. İçe aktarım yalnızca aday
 * `BankImportRow` satırları üretir; eşleşme önerisi (`suggestMatchesForRow`)
 * salt-okunurdur; yalnızca kullanıcının açık onayı sonrası (`confirmBankImportRowAsSettlement`/
 * `confirmBankImportRowAsTransfer`) mevcut canonical `createSettlementInTransaction`/
 * `createTransferInTransaction` servisleri çağrılır — iş kuralları (kilitleme,
 * kalan tutar, bakiye, idempotency) burada TEKRARLANMAZ.
 *
 * Yetki: bu modülün tamamı `canManageAccounts` (OWNER/ADMIN/FINANCE) ile
 * kapalıdır — Kasa/Banka modülünün geri kalanıyla aynı ilke
 * (server/services/account-service.ts), PROJECT_MANAGER kapalı-durumda-başarısız
 * dışlanır. Mutabakat mutasyonları ayrıca kendi canonical servislerinin
 * (`canRecordSettlement`/`canRecordTransfer`) iç yetki kontrolünden de geçer.
 */

function sanitizeDisplayFileName(rawName: string): string {
  const trimmed = rawName.trim().slice(0, 180);
  return trimmed.length > 0 ? trimmed : "ekstre";
}

async function requireBankAccount(actor: SessionUser, financialAccountId: string) {
  const account = await db.financialAccount.findFirst({
    where: { id: financialAccountId, organizationId: actor.organizationId },
  });
  if (!account) throw notFound("Hesap bulunamadı");
  if (account.type !== "BANK") throw new ServiceError("Yalnızca banka hesaplarına ekstre içe aktarılabilir");
  if (!account.isActive) throw conflict("Pasif hesaba içe aktarım yapılamaz");
  return account;
}

export interface ImportBankStatementInput {
  financialAccountId: string;
  fileName: string;
  buffer: Buffer;
}

/**
 * Dosyayı ayrıştırıp normalize eder ve `BankImportBatch`/`BankImportRow`
 * olarak kaydeder. Aynı dosya (byte-normalize edilmiş SHA-256) aynı hesaba
 * daha önce yüklenmişse, YENİDEN işlenmeden mevcut batch idempotent olarak
 * döner (`alreadyImported: true`) — bkz. server/services/bank-import/normalize.ts
 * modül başı yorumu (iki katmanlı parmak izi tasarımı).
 */
export async function importBankStatement(actor: SessionUser, input: ImportBankStatementInput) {
  if (!canManageAccounts(actor.role)) throw forbidden();

  // YF-814/YF-815 — açık bir ödeme gecikmesi veya kaybedilmiş bir Stripe
  // uyuşmazlığı (chargeback) nedeniyle faturalama hesabı kısıtlıysa YENİ
  // banka ekstresi içe aktarımı ENGELLENİR (bkz.
  // lib/billing/billing-restriction-policy.ts dosya başı notu).
  await assertNotBillingRestricted(db, actor.organizationId);

  // YF-802 — banka içe aktarım bir plan modülüdür: rol yetkisi yeterli olsa
  // bile, organizasyonun planı bu özelliği içermiyorsa reddedilir (bkz.
  // lib/entitlements/entitlement-service.ts, capability="bank_import").
  await assertCapability(
    db,
    actor.organizationId,
    "bank_import",
    "Banka ekstresi içe aktarma modülü mevcut planınızda yer almıyor. Bu özelliği kullanmak için planınızı yükseltin.",
  );

  const account = await requireBankAccount(actor, input.financialAccountId);
  const fileFingerprint = computeFileFingerprint(input.buffer);

  const existingBatch = await db.bankImportBatch.findUnique({
    where: {
      organizationId_financialAccountId_fileFingerprint: {
        organizationId: actor.organizationId,
        financialAccountId: account.id,
        fileFingerprint,
      },
    },
  });
  if (existingBatch) {
    return { batch: existingBatch, alreadyImported: true as const };
  }

  const { rows } = await extractRawRows(input.buffer);
  const parsedRows = normalizeBankStatementRows({
    rows,
    organizationId: actor.organizationId,
    financialAccountId: account.id,
    currency: account.currency,
    fileFingerprint,
  });

  // `existingBatch` denetimiyle bu `create` arasındaki pencerede eşzamanlı
  // AYNI dosya iki kez yüklenirse, ikinci istek `fileFingerprint` benzersizlik
  // kısıtında P2002 alır — aşağıdaki catch bunu idempotent bir dönüşe çevirir
  // (bkz. createSettlement/createTransfer ile aynı desen).
  let batch;
  try {
    batch = await db.$transaction(async (tx) => {
      const created = await tx.bankImportBatch.create({
        data: {
          organizationId: actor.organizationId,
          financialAccountId: account.id,
          fileName: sanitizeDisplayFileName(input.fileName),
          fileFingerprint,
          rowCount: parsedRows.length,
          importedRowCount: 0,
          errorRowCount: 0,
          duplicateSkippedCount: 0,
          importedById: actor.id,
        },
      });

      await tx.bankImportRow.createMany({
        data: parsedRows.map((r: ParsedBankRow) => ({
          organizationId: actor.organizationId,
          financialAccountId: account.id,
          batchId: created.id,
          rowFingerprint: r.rowFingerprint,
          transactionDate: r.transactionDate,
          valueDate: r.valueDate,
          amount: r.amount,
          currency: r.currency,
          direction: r.direction,
          description: r.description,
          bankReference: r.bankReference,
          counterparty: r.counterparty,
          rawRowJson: r.rawRowJson,
          status: r.status,
          errorMessage: r.errorMessage,
        })),
        skipDuplicates: true,
      });

      const [actualInserted, actualImportedRowCount] = await Promise.all([
        tx.bankImportRow.count({ where: { batchId: created.id } }),
        tx.bankImportRow.count({ where: { batchId: created.id, status: "IMPORTED" } }),
      ]);
      const duplicateSkippedCount = parsedRows.length - actualInserted;
      const actualErrorRowCount = actualInserted - actualImportedRowCount;

      const updated = await tx.bankImportBatch.update({
        where: { id: created.id },
        data: {
          importedRowCount: actualImportedRowCount,
          errorRowCount: actualErrorRowCount,
          duplicateSkippedCount,
        },
      });

      await writeAuditLog(tx, {
        organizationId: actor.organizationId,
        actorId: actor.id,
        action: "bank_import_batch.create",
        entityType: "BankImportBatch",
        entityId: created.id,
        after: {
          financialAccountId: account.id,
          rowCount: parsedRows.length,
          importedRowCount: actualImportedRowCount,
          errorRowCount: actualErrorRowCount,
          duplicateSkippedCount,
        },
      });

      return updated;
    });
  } catch (err) {
    if ((err as { code?: string })?.code === "P2002") {
      const raced = await db.bankImportBatch.findUnique({
        where: {
          organizationId_financialAccountId_fileFingerprint: {
            organizationId: actor.organizationId,
            financialAccountId: account.id,
            fileFingerprint,
          },
        },
      });
      if (raced) return { batch: raced, alreadyImported: true as const };
    }
    throw err;
  }

  return { batch, alreadyImported: false as const };
}

export async function listBatchesForUser(actor: SessionUser) {
  if (!canManageAccounts(actor.role)) throw forbidden();
  return db.bankImportBatch.findMany({
    where: { organizationId: actor.organizationId },
    orderBy: { createdAt: "desc" },
  });
}

export async function getBatchForUser(actor: SessionUser, batchId: string) {
  if (!canManageAccounts(actor.role)) throw forbidden();
  const batch = await db.bankImportBatch.findFirst({
    where: { id: batchId, organizationId: actor.organizationId },
  });
  if (!batch) throw notFound("İçe aktarım grubu bulunamadı");
  const rows = await db.bankImportRow.findMany({
    where: { batchId: batch.id, organizationId: actor.organizationId },
    orderBy: { createdAt: "asc" },
  });
  return { batch, rows };
}

export async function getBankImportRowForUser(actor: SessionUser, rowId: string) {
  if (!canManageAccounts(actor.role)) throw forbidden();
  const row = await db.bankImportRow.findFirst({ where: { id: rowId, organizationId: actor.organizationId } });
  if (!row) throw notFound("İçe aktarım satırı bulunamadı");
  return row;
}

export async function listBankAccountsForImport(actor: SessionUser) {
  if (!canManageAccounts(actor.role)) throw forbidden();
  return db.financialAccount.findMany({
    where: { organizationId: actor.organizationId, type: "BANK", isActive: true },
    orderBy: { name: "asc" },
  });
}

export interface TransactionMatchCandidate {
  id: string;
  description: string;
  documentNumber: string | null;
  issueDate: Date;
  dueDate: Date | null;
  totalAmount: string;
  remaining: string;
}

/**
 * SALT-OKUNUR eşleşme önerisi — hiçbir DB yazması yapmaz, hiçbir durumu
 * kalıcı hâle getirmez (görev talimatı "matching must not mutate before
 * confirmation"). Yalnızca `IMPORTED` durumundaki, tarih/tutar/yönü
 * ayrıştırılabilmiş satırlar için aday üretir; muhafazakâr sıralama: önce en
 * yakın kalan tutar, sonra en yakın vade/belge tarihi. En fazla 5 aday.
 */
export async function suggestMatchesForRow(actor: SessionUser, rowId: string): Promise<TransactionMatchCandidate[]> {
  if (!canManageAccounts(actor.role)) throw forbidden();
  const row = await db.bankImportRow.findFirst({ where: { id: rowId, organizationId: actor.organizationId } });
  if (!row) throw notFound("İçe aktarım satırı bulunamadı");
  if (row.status !== "IMPORTED" || !row.amount || !row.transactionDate || !row.direction || !row.currency) {
    return [];
  }

  const type: TransactionType = row.direction === "CREDIT" ? "INCOME" : "EXPENSE";

  const candidates = await db.$queryRaw<
    {
      id: string;
      description: string;
      documentNumber: string | null;
      issueDate: Date;
      dueDate: Date | null;
      totalAmount: string;
      remaining: string;
    }[]
  >(Prisma.sql`
    SELECT ft.id, ft.description, ft."documentNumber", ft."issueDate", ft."dueDate",
      ft."totalAmount"::text AS "totalAmount",
      (ft."totalAmount" - COALESCE(s.settled, 0))::text AS remaining
    FROM "FinancialTransaction" ft
    LEFT JOIN (
      SELECT "transactionId", SUM(amount) AS settled FROM "Settlement" WHERE status = 'ACTIVE' GROUP BY "transactionId"
    ) s ON s."transactionId" = ft.id
    WHERE ft."organizationId" = ${actor.organizationId}
      AND ft.type = ${type}::"TransactionType"
      AND ft.status != 'CANCELLED'
      AND ft.currency = ${row.currency}
      AND (ft."totalAmount" - COALESCE(s.settled, 0)) > 0
    ORDER BY
      ABS((ft."totalAmount" - COALESCE(s.settled, 0)) - ${row.amount.toString()}::numeric) ASC,
      ABS(EXTRACT(EPOCH FROM (COALESCE(ft."dueDate", ft."issueDate") - ${row.transactionDate}::timestamp))) ASC
    LIMIT 5
  `);

  return candidates;
}

async function claimRowForConfirm(tx: Tx, actor: SessionUser, rowId: string) {
  const row = await lockBankImportRow(tx, actor.organizationId, rowId);
  if (row.status === "CONFIRMING") {
    throw conflict("Bu satır şu anda mutabakat sağlanıyor, lütfen birazdan tekrar deneyin");
  }
  if (row.status !== "IMPORTED") {
    throw conflict("Bu satır mutabakata hazır durumda değil (yok sayılmış, zaten mutabık kalınmış veya hatalı olabilir)");
  }
  if (!row.amount || !row.transactionDate || !row.direction) {
    throw conflict("Bu satır eksik/hatalı verilere sahip, mutabakat sağlanamaz");
  }
  await tx.bankImportRow.update({ where: { id: row.id }, data: { status: "CONFIRMING" } });
  return row;
}

async function rollbackClaimedRow(rowId: string, organizationId: string) {
  await db.bankImportRow.updateMany({
    where: { id: rowId, organizationId, status: "CONFIRMING" },
    data: { status: "IMPORTED" },
  });
}

export interface ConfirmBankImportRowAsSettlementInput {
  rowId: string;
  transactionId: string;
}

/**
 * Banka satırını, mevcut açık bir gelir/gider kaydına tahsilat/ödeme olarak
 * mutabık kılar — canonical `createSettlementInTransaction` TEK bir DB
 * transaction'ında çağrılır (satır kilidi/CONFIRMING iddiası ayrı, kısa bir
 * ön-transaction'da alınır; bkz. `claimRowForConfirm` — aynı desen
 * `confirmDocumentExtraction`, server/services/document-extraction-service.ts).
 * Bu iki-aşamalı çöküş penceresi bilinçli olarak KAPALI tutulur: gider/
 * settlement oluşturma ile satırın RECONCILED işaretlenmesi + audit log AYNI
 * transaction'da commit edilir — süreç bu adımda çökerse asılı bir
 * Settlement kalmaz, satır CONFIRMING'de takılı kalırsa `rollbackClaimedRow`
 * onu tekrar denemeye açar.
 */
export async function confirmBankImportRowAsSettlement(actor: SessionUser, input: ConfirmBankImportRowAsSettlementInput) {
  if (!canManageAccounts(actor.role)) throw forbidden();

  const claim = await db.$transaction((tx) => claimRowForConfirm(tx, actor, input.rowId));

  try {
    const settlement = await db.$transaction(async (tx) => {
      const targetTransaction = await tx.financialTransaction.findFirst({
        where: { id: input.transactionId, organizationId: actor.organizationId },
      });
      if (!targetTransaction) throw notFound("Kayıt bulunamadı");
      const expectedType: TransactionType = claim.direction === "CREDIT" ? "INCOME" : "EXPENSE";
      if (targetTransaction.type !== expectedType) {
        throw conflict("Banka satırının yönü (giriş/çıkış) seçilen kaydın türüyle uyuşmuyor");
      }

      const created = await createSettlementInTransaction(tx, actor, {
        transactionId: input.transactionId,
        financialAccountId: claim.financialAccountId,
        // `claim.amount` zaten bir `Prisma.Decimal` (DECIMAL(18,2)) — JS
        // number'a çevrilmeden doğrudan geçirilir, aksi halde kuruş
        // hassasiyeti `toDecimal()` geri çevirmeden ÖNCE kaybolabilir
        // (YF-602 regresyon, bkz. CreateSettlementServiceInput).
        amount: claim.amount as Prisma.Decimal,
        settlementDate: claim.transactionDate as Date,
        paymentMethod: "HAVALE_EFT",
        referenceNumber: claim.bankReference ?? "",
        notes: `Banka içe aktarımından mutabakat (BankImportRow ${claim.id})`,
        idempotencyKey: `bank-import-row:${claim.id}`,
      });

      await tx.bankImportRow.update({
        where: { id: claim.id },
        data: {
          status: "RECONCILED",
          reconciliationType: created.type,
          matchedSettlementId: created.id,
          confirmedById: actor.id,
          confirmedAt: new Date(),
        },
      });

      await writeAuditLog(tx, {
        organizationId: actor.organizationId,
        actorId: actor.id,
        action: "bank_import_row.reconcile_settlement",
        entityType: "BankImportRow",
        entityId: claim.id,
        after: { settlementId: created.id, transactionId: input.transactionId },
      });

      return created;
    });

    return { settlementId: settlement.id, alreadyConfirmed: false };
  } catch (err) {
    await rollbackClaimedRow(claim.id, actor.organizationId);
    throw err;
  }
}

export interface ConfirmBankImportRowAsTransferInput {
  rowId: string;
  counterpartAccountId: string;
}

/**
 * Banka satırını, organizasyonun KENDİ başka bir hesabına yapılan bir
 * transfer olarak mutabık kılar — canonical `createTransferInTransaction`
 * kullanılır (bkz. `confirmBankImportRowAsSettlement` ile aynı iki-fazlı
 * kilitleme/çöküş-penceresi-kapalı gerekçe). Satırın yönü hangi hesabın
 * kaynak/hedef olduğunu belirler: DEBIT (para bu hesaptan çıktı) ise bu hesap
 * kaynaktır; CREDIT (para bu hesaba girdi) ise bu hesap hedeftir.
 */
export async function confirmBankImportRowAsTransfer(actor: SessionUser, input: ConfirmBankImportRowAsTransferInput) {
  if (!canManageAccounts(actor.role)) throw forbidden();

  const claim = await db.$transaction((tx) => claimRowForConfirm(tx, actor, input.rowId));

  const fromAccountId = claim.direction === "DEBIT" ? claim.financialAccountId : input.counterpartAccountId;
  const toAccountId = claim.direction === "DEBIT" ? input.counterpartAccountId : claim.financialAccountId;

  try {
    const transfer = await db.$transaction(async (tx) => {
      const created = await createTransferInTransaction(tx, actor, {
        fromAccountId,
        toAccountId,
        // bkz. confirmBankImportRowAsSettlement — Decimal doğrudan geçirilir.
        amount: claim.amount as Prisma.Decimal,
        transferDate: claim.transactionDate as Date,
        description: `Banka içe aktarımından transfer mutabakatı (BankImportRow ${claim.id})`,
        idempotencyKey: `bank-import-row:${claim.id}`,
      });

      await tx.bankImportRow.update({
        where: { id: claim.id },
        data: {
          status: "RECONCILED",
          reconciliationType: "TRANSFER",
          matchedTransferId: created.id,
          confirmedById: actor.id,
          confirmedAt: new Date(),
        },
      });

      await writeAuditLog(tx, {
        organizationId: actor.organizationId,
        actorId: actor.id,
        action: "bank_import_row.reconcile_transfer",
        entityType: "BankImportRow",
        entityId: claim.id,
        after: { transferId: created.id, fromAccountId, toAccountId },
      });

      return created;
    });

    return { transferId: transfer.id, alreadyConfirmed: false };
  } catch (err) {
    await rollbackClaimedRow(claim.id, actor.organizationId);
    throw err;
  }
}

/** Kullanıcının bilinçli olarak dışladığı satır — asla hiçbir finansal etkiye sahip olamaz, ileride yanlışlıkla mutabık kılınamaz. */
export async function ignoreBankImportRow(actor: SessionUser, rowId: string) {
  if (!canManageAccounts(actor.role)) throw forbidden();

  return db.$transaction(async (tx) => {
    const row = await lockBankImportRow(tx, actor.organizationId, rowId);
    if (row.status === "IGNORED") return row;
    if (row.status !== "IMPORTED") {
      throw conflict("Bu satır yalnızca içe aktarılmış (henüz mutabık kalınmamış) durumdayken yok sayılabilir");
    }

    const updated = await tx.bankImportRow.update({
      where: { id: row.id },
      data: { status: "IGNORED", ignoredById: actor.id, ignoredAt: new Date() },
    });

    await writeAuditLog(tx, {
      organizationId: actor.organizationId,
      actorId: actor.id,
      action: "bank_import_row.ignore",
      entityType: "BankImportRow",
      entityId: row.id,
    });

    return updated;
  });
}
