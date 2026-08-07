import { db } from "@/lib/db";
import { writeAuditLog } from "@/lib/audit";
import {
  canCancelFinancialRecord,
  canCreateExpense,
  canCreateIncome,
  canManageExpenses,
  canManageIncome,
} from "@/lib/permissions";
import { forbidden, notFound, conflict } from "@/server/services/errors";
import { computeTax, deriveTransactionStatus, lockTransaction, toDecimal, ZERO } from "@/server/services/ledger";
import type { SessionUser } from "@/lib/auth/session";
import type {
  CancelTransactionInput,
  CreateExpenseInput,
  CreateIncomeInput,
  UpdateExpenseInput,
  UpdateIncomeInput,
} from "@/lib/validation/transaction";
import type { FinancialTransaction, Prisma, TransactionType } from "@prisma/client";

type Tx = Prisma.TransactionClient;

/**
 * Gelir ve gider kayıtları aynı FinancialTransaction modelini paylaşır
 * (docs/DATA_MODEL.md); bu servis TransactionType ile ayrıştırır. Bu şemada
 * DRAFT durumu yoktur (bkz. docs/ARCHITECTURE.md §6 durum listesi) — her
 * kayıt oluşturulduğu anda OPEN olarak "postalanır"; bu nedenle taslak/arşiv
 * akışı uygulanmaz, yalnızca iptal (ters kayıt) vardır.
 */

export async function attachComputed<T extends FinancialTransaction>(records: T[]) {
  if (records.length === 0) return [];
  const settlementSums = await db.settlement.groupBy({
    by: ["transactionId"],
    where: { transactionId: { in: records.map((r) => r.id) }, status: "ACTIVE" },
    _sum: { amount: true },
  });
  const settledByTx = new Map(settlementSums.map((s) => [s.transactionId, toDecimal(s._sum.amount ?? ZERO)]));

  return records.map((record) => {
    const settledAmount = settledByTx.get(record.id) ?? ZERO;
    const totalAmount = toDecimal(record.totalAmount);
    const status = deriveTransactionStatus({
      totalAmount,
      settledAmount,
      dueDate: record.dueDate,
      cancelled: record.status === "CANCELLED",
    });
    return {
      ...record,
      settledAmount,
      remainingAmount: status === "CANCELLED" ? ZERO : totalAmount.minus(settledAmount),
      status,
    };
  });
}

async function assertProjectMemberOrThrow(organizationId: string, userId: string, projectId: string) {
  const membership = await db.projectMember.findFirst({ where: { organizationId, userId, projectId } });
  if (!membership) throw notFound("Proje bulunamadı");
}

export async function listTransactionsForUser(user: SessionUser, type: TransactionType) {
  if (user.role === "PROJECT_MANAGER") {
    const records = await db.financialTransaction.findMany({
      where: {
        organizationId: user.organizationId,
        type,
        project: { members: { some: { userId: user.id } } },
      },
      orderBy: { issueDate: "desc" },
      include: { category: true, customer: true, supplier: true, project: true },
    });
    return attachComputed(records);
  }

  const records = await db.financialTransaction.findMany({
    where: { organizationId: user.organizationId, type },
    orderBy: { issueDate: "desc" },
    include: { category: true, customer: true, supplier: true, project: true },
  });
  return attachComputed(records);
}

export async function getTransactionForUser(user: SessionUser, id: string, type: TransactionType) {
  const record = await db.financialTransaction.findFirst({
    where: { id, organizationId: user.organizationId, type },
    include: {
      category: true,
      customer: true,
      supplier: true,
      project: true,
      settlements: { orderBy: { settlementDate: "desc" }, include: { financialAccount: true } },
    },
  });
  if (!record) throw notFound("Kayıt bulunamadı");

  if (user.role === "PROJECT_MANAGER") {
    if (!record.projectId) throw notFound("Kayıt bulunamadı");
    const isMember = await db.projectMember.findFirst({
      where: { organizationId: user.organizationId, userId: user.id, projectId: record.projectId },
    });
    if (!isMember) throw notFound("Kayıt bulunamadı");
  }

  const [computed] = await attachComputed([record]);
  return { ...record, ...computed };
}

async function assertRelatedRecordsInOrg(
  organizationId: string,
  type: TransactionType,
  input: { projectId?: string; customerId?: string; supplierId?: string; categoryId: string },
) {
  if (input.projectId) {
    const project = await db.project.findFirst({ where: { id: input.projectId, organizationId } });
    if (!project) throw notFound("Proje bulunamadı");
  }
  if (input.customerId) {
    const customer = await db.customer.findFirst({ where: { id: input.customerId, organizationId } });
    if (!customer) throw notFound("Müşteri bulunamadı");
  }
  if (input.supplierId) {
    const supplier = await db.supplier.findFirst({ where: { id: input.supplierId, organizationId } });
    if (!supplier) throw notFound("Tedarikçi bulunamadı");
  }
  const category = await db.transactionCategory.findFirst({
    where: { id: input.categoryId, organizationId, type },
  });
  if (!category) throw notFound("Kategori bulunamadı");
}

export async function createIncome(actor: SessionUser, input: CreateIncomeInput) {
  if (!canCreateIncome(actor.role)) throw forbidden();
  await assertRelatedRecordsInOrg(actor.organizationId, "INCOME", input);

  const { subtotal, taxAmount, totalAmount } = computeTax(input.subtotal, input.taxRate);

  return db.$transaction(async (tx) => {
    const record = await tx.financialTransaction.create({
      data: {
        organizationId: actor.organizationId,
        projectId: input.projectId ?? null,
        type: "INCOME",
        customerId: input.customerId ?? null,
        categoryId: input.categoryId,
        documentNumber: input.documentNumber || null,
        description: input.description,
        issueDate: input.issueDate,
        dueDate: input.dueDate ?? null,
        subtotal,
        taxRate: input.taxRate,
        taxAmount,
        totalAmount,
        status: "OPEN",
        createdById: actor.id,
      },
    });
    await writeAuditLog(tx, {
      organizationId: actor.organizationId,
      actorId: actor.id,
      action: "income.create",
      entityType: "FinancialTransaction",
      entityId: record.id,
      after: { description: record.description, totalAmount: totalAmount.toString() },
    });
    return record;
  });
}

async function assertExpenseCreatable(actor: SessionUser, input: CreateExpenseInput) {
  if (!canCreateExpense(actor.role)) throw forbidden();

  if (actor.role === "PROJECT_MANAGER") {
    if (!input.projectId) throw forbidden("Proje yöneticisi yalnızca bir projeye bağlı gider girebilir");
    await assertProjectMemberOrThrow(actor.organizationId, actor.id, input.projectId);
  }

  await assertRelatedRecordsInOrg(actor.organizationId, "EXPENSE", input);
}

async function writeExpenseRecord(tx: Tx, actor: SessionUser, input: CreateExpenseInput) {
  const { subtotal, taxAmount, totalAmount } = computeTax(input.subtotal, input.taxRate);

  const record = await tx.financialTransaction.create({
    data: {
      organizationId: actor.organizationId,
      projectId: input.projectId ?? null,
      type: "EXPENSE",
      supplierId: input.supplierId ?? null,
      categoryId: input.categoryId,
      documentNumber: input.documentNumber || null,
      description: input.description,
      issueDate: input.issueDate,
      dueDate: input.dueDate ?? null,
      subtotal,
      taxRate: input.taxRate,
      taxAmount,
      totalAmount,
      status: "OPEN",
      createdById: actor.id,
    },
  });
  await writeAuditLog(tx, {
    organizationId: actor.organizationId,
    actorId: actor.id,
    action: "expense.create",
    entityType: "FinancialTransaction",
    entityId: record.id,
    after: { description: record.description, totalAmount: totalAmount.toString() },
  });
  return record;
}

export async function createExpense(actor: SessionUser, input: CreateExpenseInput) {
  await assertExpenseCreatable(actor, input);
  return db.$transaction((tx) => writeExpenseRecord(tx, actor, input));
}

/**
 * `createExpense`'in aynı yetki/tenant/ilişkili-kayıt/KDV kurallarını
 * uygulayan, ancak yazmayı ÇAĞIRANIN transaction'ı içinde yapan sürümü —
 * gider oluşturmanın başka bir atomik işlemin (örn. OCR onayı finalize
 * adımı) parçası olması gerektiğinde kullanılır, iş kuralı tekrarlanmaz.
 */
export async function createExpenseInTransaction(tx: Tx, actor: SessionUser, input: CreateExpenseInput) {
  await assertExpenseCreatable(actor, input);
  return writeExpenseRecord(tx, actor, input);
}

async function assertEditable(organizationId: string, id: string, type: TransactionType) {
  const existing = await db.financialTransaction.findFirst({ where: { id, organizationId, type } });
  if (!existing) throw notFound("Kayıt bulunamadı");
  if (existing.status === "CANCELLED") throw conflict("İptal edilmiş kayıt düzenlenemez");

  const settled = await db.settlement.aggregate({
    where: { transactionId: id, status: "ACTIVE" },
    _sum: { amount: true },
  });
  const settledAmount = toDecimal(settled._sum.amount ?? ZERO);
  if (settledAmount.greaterThan(ZERO)) {
    throw conflict("Tahsilat/ödeme yapılmış kayıt düzenlenemez");
  }
  return existing;
}

export async function updateIncome(actor: SessionUser, input: UpdateIncomeInput) {
  if (!canManageIncome(actor.role)) throw forbidden();
  const existing = await assertEditable(actor.organizationId, input.id, "INCOME");
  await assertRelatedRecordsInOrg(actor.organizationId, "INCOME", input);

  const { subtotal, taxAmount, totalAmount } = computeTax(input.subtotal, input.taxRate);

  return db.$transaction(async (tx) => {
    const updated = await tx.financialTransaction.update({
      where: { id: existing.id },
      data: {
        projectId: input.projectId ?? null,
        customerId: input.customerId ?? null,
        categoryId: input.categoryId,
        documentNumber: input.documentNumber || null,
        description: input.description,
        issueDate: input.issueDate,
        dueDate: input.dueDate ?? null,
        subtotal,
        taxRate: input.taxRate,
        taxAmount,
        totalAmount,
      },
    });
    await writeAuditLog(tx, {
      organizationId: actor.organizationId,
      actorId: actor.id,
      action: "income.update",
      entityType: "FinancialTransaction",
      entityId: updated.id,
      before: { totalAmount: existing.totalAmount.toString() },
      after: { totalAmount: totalAmount.toString() },
    });
    return updated;
  });
}

export async function updateExpense(actor: SessionUser, input: UpdateExpenseInput) {
  if (!canManageExpenses(actor.role)) throw forbidden();
  const existing = await assertEditable(actor.organizationId, input.id, "EXPENSE");
  await assertRelatedRecordsInOrg(actor.organizationId, "EXPENSE", input);

  const { subtotal, taxAmount, totalAmount } = computeTax(input.subtotal, input.taxRate);

  return db.$transaction(async (tx) => {
    const updated = await tx.financialTransaction.update({
      where: { id: existing.id },
      data: {
        projectId: input.projectId ?? null,
        supplierId: input.supplierId ?? null,
        categoryId: input.categoryId,
        documentNumber: input.documentNumber || null,
        description: input.description,
        issueDate: input.issueDate,
        dueDate: input.dueDate ?? null,
        subtotal,
        taxRate: input.taxRate,
        taxAmount,
        totalAmount,
      },
    });
    await writeAuditLog(tx, {
      organizationId: actor.organizationId,
      actorId: actor.id,
      action: "expense.update",
      entityType: "FinancialTransaction",
      entityId: updated.id,
      before: { totalAmount: existing.totalAmount.toString() },
      after: { totalAmount: totalAmount.toString() },
    });
    return updated;
  });
}

async function cancelTransaction(actor: SessionUser, input: CancelTransactionInput, type: TransactionType) {
  if (!canCancelFinancialRecord(actor.role)) throw forbidden();

  const existing = await db.financialTransaction.findFirst({
    where: { id: input.id, organizationId: actor.organizationId, type },
  });
  if (!existing) throw notFound("Kayıt bulunamadı");
  if (existing.status === "CANCELLED") throw conflict("Kayıt zaten iptal edilmiş");

  const settled = await db.settlement.aggregate({
    where: { transactionId: existing.id, status: "ACTIVE" },
    _sum: { amount: true },
  });
  const settledAmount = toDecimal(settled._sum.amount ?? ZERO);
  if (settledAmount.greaterThan(ZERO)) {
    throw conflict(
      "Tahsilat/ödeme kaydı olan bir kayıt doğrudan iptal edilemez; önce ilgili hareketleri ters kayıtla düzeltin",
    );
  }

  return db.$transaction(async (tx) => {
    // Satır kilidi altında durumu yeniden oku — bkz. settlement-service.ts
    // cancelSettlement ile aynı gerekçe: kilitsiz `findFirst` ile buradaki
    // kilit arasındaki pencerede aynı kayda karşı eşzamanlı ikinci bir iptal
    // isteği, burada beklemeden geçip mükerrer "cancel" audit log kaydı
    // üretebiliyordu (bkz. YF-502 regresyon testi). Para hareketi
    // oluşturmadığı için bakiye etkisi yoktur, ama denetlenebilir geçmişin
    // gerçek durumu yansıtması gerekir.
    const locked = await lockTransaction(tx, actor.organizationId, existing.id);
    if (locked.status === "CANCELLED") throw conflict("Kayıt zaten iptal edilmiş");

    const updated = await tx.financialTransaction.update({
      where: { id: locked.id },
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
      action: type === "INCOME" ? "income.cancel" : "expense.cancel",
      entityType: "FinancialTransaction",
      entityId: updated.id,
      before: { status: locked.status },
      after: { status: "CANCELLED", reason: input.reason },
    });
    return updated;
  });
}

export const cancelIncome = (actor: SessionUser, input: CancelTransactionInput) =>
  cancelTransaction(actor, input, "INCOME");
export const cancelExpense = (actor: SessionUser, input: CancelTransactionInput) =>
  cancelTransaction(actor, input, "EXPENSE");
