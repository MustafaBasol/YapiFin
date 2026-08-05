import { Prisma } from "@prisma/client";
import type { TransactionStatus, TransactionType } from "@prisma/client";
import { notFound } from "@/server/services/errors";

/**
 * Kasa/banka bakiyeleri ve gelir/gider kalan tutarları yalnızca bu modül
 * üzerinden, Prisma.Decimal ile hesaplanır — JS number aritmetiği ile para
 * hesabı yapılmaz (bkz. CLAUDE.md, docs/ARCHITECTURE.md §8).
 */
type Tx = Prisma.TransactionClient;

export const ZERO = new Prisma.Decimal(0);

export function toDecimal(value: Prisma.Decimal.Value): Prisma.Decimal {
  return new Prisma.Decimal(value);
}

export function computeTax(subtotal: Prisma.Decimal.Value, taxRate: Prisma.Decimal.Value) {
  const sub = toDecimal(subtotal).toDecimalPlaces(2);
  const rate = toDecimal(taxRate);
  const taxAmount = sub.mul(rate).div(100).toDecimalPlaces(2);
  const totalAmount = sub.plus(taxAmount).toDecimalPlaces(2);
  return { subtotal: sub, taxAmount, totalAmount };
}

/** Satır kilidi alır (SELECT ... FOR UPDATE); eşzamanlı tahsilat/ödeme/transfer yarışlarını önler. */
export async function lockAccount(tx: Tx, organizationId: string, accountId: string) {
  const rows = await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM "FinancialAccount" WHERE id = ${accountId} AND "organizationId" = ${organizationId} FOR UPDATE
  `;
  if (rows.length === 0) throw notFound("Hesap bulunamadı");
  return tx.financialAccount.findUniqueOrThrow({ where: { id: accountId } });
}

export async function lockTransaction(tx: Tx, organizationId: string, transactionId: string) {
  const rows = await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM "FinancialTransaction" WHERE id = ${transactionId} AND "organizationId" = ${organizationId} FOR UPDATE
  `;
  if (rows.length === 0) throw notFound("Kayıt bulunamadı");
  return tx.financialTransaction.findUniqueOrThrow({ where: { id: transactionId } });
}

export async function getAccountBalance(tx: Tx, accountId: string): Promise<Prisma.Decimal> {
  const sums = await tx.accountMovement.groupBy({
    by: ["direction"],
    where: { financialAccountId: accountId },
    _sum: { amount: true },
  });
  const credit = toDecimal(sums.find((s) => s.direction === "CREDIT")?._sum.amount ?? ZERO);
  const debit = toDecimal(sums.find((s) => s.direction === "DEBIT")?._sum.amount ?? ZERO);
  return credit.minus(debit);
}

export async function getSettledAmount(tx: Tx, transactionId: string): Promise<Prisma.Decimal> {
  const result = await tx.settlement.aggregate({
    where: { transactionId, status: "ACTIVE" },
    _sum: { amount: true },
  });
  return toDecimal(result._sum.amount ?? ZERO);
}

/**
 * Açık ve vadesi geçen alacak/borç toplamlarını tek bir sınırlı (bounded)
 * veritabanı sorgusuyla hesaplar — YF-401. Kalan tutar (remaining) her kayıt
 * için `totalAmount - Σ(aktif settlement)` şeklinde satır bazında türetilmesi
 * gerektiğinden (iptal edilmiş/ters kaydı düzeltilmiş settlement'lar `status
 * != 'ACTIVE'` olduğundan otomatik dışlanır), tüm kayıtları uygulama
 * belleğine çekmek yerine bu hesap doğrudan PostgreSQL içinde, tek sorguda
 * yapılır (bkz. görev talimatları "Prefer bounded database aggregate
 * queries"). `OVERDUE`, kalan > 0 ve vade tarihi geçmişse (gelecek tarihli
 * kayıtlar hariç) sayılır — deriveTransactionStatus ile aynı kural.
 * `CANCELLED` kayıtlar tamamen hariç tutulur.
 */
export async function getOpenAndOverdueTotals(
  tx: Tx,
  params: { organizationId: string; type: TransactionType; projectIds?: string[] },
): Promise<{ open: Prisma.Decimal; overdue: Prisma.Decimal }> {
  const { organizationId, type, projectIds } = params;
  if (projectIds && projectIds.length === 0) {
    return { open: ZERO, overdue: ZERO };
  }

  const projectFilter = projectIds ? Prisma.sql`AND ft."projectId" = ANY(${projectIds})` : Prisma.sql``;

  const rows = await tx.$queryRaw<{ open_amount: string; overdue_amount: string }[]>(Prisma.sql`
    SELECT
      COALESCE(SUM(CASE WHEN remaining > 0 THEN remaining ELSE 0 END), 0)::text AS open_amount,
      COALESCE(SUM(CASE WHEN remaining > 0 AND due_date IS NOT NULL AND due_date < NOW() THEN remaining ELSE 0 END), 0)::text AS overdue_amount
    FROM (
      SELECT
        ft.id,
        ft."dueDate" AS due_date,
        ft."totalAmount" - COALESCE(s.settled, 0) AS remaining
      FROM "FinancialTransaction" ft
      LEFT JOIN (
        SELECT "transactionId", SUM(amount) AS settled
        FROM "Settlement"
        WHERE status = 'ACTIVE'
        GROUP BY "transactionId"
      ) s ON s."transactionId" = ft.id
      WHERE ft."organizationId" = ${organizationId}
        AND ft.type = ${type}::"TransactionType"
        AND ft.status != 'CANCELLED'
        ${projectFilter}
    ) sub
  `);

  const row = rows[0];
  return {
    open: toDecimal(row?.open_amount ?? "0"),
    overdue: toDecimal(row?.overdue_amount ?? "0"),
  };
}

export function deriveTransactionStatus(params: {
  totalAmount: Prisma.Decimal;
  settledAmount: Prisma.Decimal;
  dueDate: Date | null;
  cancelled: boolean;
}): TransactionStatus {
  if (params.cancelled) return "CANCELLED";
  if (params.settledAmount.greaterThanOrEqualTo(params.totalAmount)) return "PAID";
  const isOverdue = params.dueDate != null && params.dueDate.getTime() < Date.now();
  if (isOverdue) return "OVERDUE";
  if (params.settledAmount.greaterThan(ZERO)) return "PARTIALLY_PAID";
  return "OPEN";
}
