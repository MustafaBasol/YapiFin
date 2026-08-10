import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { writeAuditLog } from "@/lib/audit";
import { canManageProgressPayments } from "@/lib/permissions";
import { conflict, forbidden, notFound, ServiceError } from "@/server/services/errors";
import { getProjectForUser } from "@/server/services/project-service";
import { createIncomeInTransaction } from "@/server/services/transaction-service";
import { toDecimal, ZERO } from "@/server/services/ledger";
import type { SessionUser } from "@/lib/auth/session";
import type {
  CancelProgressPaymentInput,
  CreateExtraWorkItemInput,
  CreateProgressPaymentInput,
  ExtraWorkItemIdInput,
  ProgressPaymentIdInput,
  RejectProgressPaymentInput,
  UpdateProgressPaymentInput,
} from "@/lib/validation/progress-payment";

type Tx = Prisma.TransactionClient;

/**
 * `lockTransaction`/`lockSettlement` (server/services/ledger.ts) ile aynı
 * desen — `ProgressPayment` kasıtlı olarak ledger.ts'e DAHİL EDİLMEDİ çünkü
 * kanonik bir finansal defter tablosu değildir (bkz. prisma/schema.prisma
 * ProgressPayment modeli notu); satır kilidi yalnızca bu servisin kendi
 * durum makinesi geçişlerini (submit/approve/reject/cancel) eşzamanlılığa
 * karşı korumak içindir.
 */
async function lockProgressPayment(tx: Tx, organizationId: string, id: string) {
  const rows = await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM "ProgressPayment" WHERE id = ${id} AND "organizationId" = ${organizationId} FOR UPDATE
  `;
  if (rows.length === 0) throw notFound("Kayıt bulunamadı");
  return tx.progressPayment.findUniqueOrThrow({ where: { id } });
}

async function assertIncomeCategoryInOrg(client: Tx | typeof db, organizationId: string, categoryId: string) {
  const category = await client.transactionCategory.findFirst({
    where: { id: categoryId, organizationId, type: "INCOME" },
  });
  if (!category) throw notFound("Kategori bulunamadı");
  return category;
}

function computeNetAmount(grossAmount: Prisma.Decimal.Value, deductionAmount: Prisma.Decimal.Value) {
  const gross = toDecimal(grossAmount).toDecimalPlaces(2);
  const deduction = toDecimal(deductionAmount).toDecimalPlaces(2);
  const net = gross.minus(deduction);
  if (net.lessThan(ZERO)) throw new ServiceError("Kesinti tutarı brüt hakediş tutarını aşamaz");
  return { grossAmount: gross, deductionAmount: deduction, netAmount: net };
}

export async function listProgressPaymentsForProject(actor: SessionUser, projectId: string) {
  const project = await getProjectForUser(actor, projectId);

  const records = await db.progressPayment.findMany({
    where: { organizationId: actor.organizationId, projectId: project.id },
    orderBy: { sequenceNo: "desc" },
  });

  const categoryIds = [...new Set(records.map((r) => r.categoryId))];
  const categories = categoryIds.length
    ? await db.transactionCategory.findMany({
        where: { id: { in: categoryIds }, organizationId: actor.organizationId },
      })
    : [];
  const categoryNameById = new Map(categories.map((c) => [c.id, c.name]));

  return {
    project,
    canManage: canManageProgressPayments(actor.role),
    records: records.map((r) => ({ ...r, categoryName: categoryNameById.get(r.categoryId) ?? "—" })),
  };
}

/**
 * Tekil hakediş erişimi `getTransactionForUser` (server/services/transaction-service.ts)
 * ile aynı desen izler: kayıt önce organizationId ile bulunur, PROJECT_MANAGER
 * için ayrıca proje üyeliği kontrol edilir — cross-project/cross-org id'ler
 * tek tip NOT_FOUND ile fail-closed reddedilir (sızıntı yok).
 */
export async function getProgressPaymentForUser(actor: SessionUser, id: string) {
  const record = await db.progressPayment.findFirst({
    where: { id, organizationId: actor.organizationId },
    include: { extraWorkItems: { orderBy: { createdAt: "asc" } } },
  });
  if (!record) throw notFound("Kayıt bulunamadı");

  if (actor.role === "PROJECT_MANAGER") {
    const isMember = await db.projectMember.findFirst({
      where: { organizationId: actor.organizationId, userId: actor.id, projectId: record.projectId },
    });
    if (!isMember) throw notFound("Kayıt bulunamadı");
  }

  const [project, category, financialTransaction] = await Promise.all([
    db.project.findFirst({ where: { id: record.projectId, organizationId: actor.organizationId } }),
    db.transactionCategory.findFirst({ where: { id: record.categoryId, organizationId: actor.organizationId } }),
    record.financialTransactionId
      ? db.financialTransaction.findFirst({
          where: { id: record.financialTransactionId, organizationId: actor.organizationId },
          include: { settlements: { where: { status: "ACTIVE" } } },
        })
      : null,
  ]);

  return { ...record, project, categoryName: category?.name ?? "—", financialTransaction };
}

export async function createProgressPayment(actor: SessionUser, input: CreateProgressPaymentInput) {
  if (!canManageProgressPayments(actor.role)) throw forbidden();

  const project = await getProjectForUser(actor, input.projectId);
  await assertIncomeCategoryInOrg(db, actor.organizationId, input.categoryId);
  const amounts = computeNetAmount(input.grossAmount, input.deductionAmount);

  return db
    .$transaction(async (tx) => {
      const last = await tx.progressPayment.aggregate({
        where: { organizationId: actor.organizationId, projectId: project.id },
        _max: { sequenceNo: true },
      });
      const sequenceNo = (last._max.sequenceNo ?? 0) + 1;

      const record = await tx.progressPayment.create({
        data: {
          organizationId: actor.organizationId,
          projectId: project.id,
          customerId: project.customerId ?? null,
          categoryId: input.categoryId,
          sequenceNo,
          periodStartDate: input.periodStartDate,
          periodEndDate: input.periodEndDate,
          dueDate: input.dueDate ?? null,
          grossAmount: amounts.grossAmount,
          deductionAmount: amounts.deductionAmount,
          netAmount: amounts.netAmount,
          notes: input.notes || null,
          status: "DRAFT",
          createdById: actor.id,
        },
      });

      await writeAuditLog(tx, {
        organizationId: actor.organizationId,
        actorId: actor.id,
        action: "progress_payment.create",
        entityType: "ProgressPayment",
        entityId: record.id,
        after: { projectId: project.id, sequenceNo, netAmount: amounts.netAmount.toString() },
      });

      return record;
    })
    .catch((err) => {
      if (err?.code === "P2002") throw conflict("Bu proje için hakediş numarası çakıştı, lütfen tekrar deneyin");
      throw err;
    });
}

export async function updateProgressPayment(actor: SessionUser, input: UpdateProgressPaymentInput) {
  if (!canManageProgressPayments(actor.role)) throw forbidden();

  const existing = await db.progressPayment.findFirst({
    where: { id: input.id, organizationId: actor.organizationId },
  });
  if (!existing) throw notFound("Kayıt bulunamadı");
  if (existing.status !== "DRAFT") throw conflict("Yalnızca taslak hakedişler düzenlenebilir");

  await assertIncomeCategoryInOrg(db, actor.organizationId, input.categoryId);
  const amounts = computeNetAmount(input.grossAmount, input.deductionAmount);

  return db.$transaction(async (tx) => {
    const updated = await tx.progressPayment.update({
      where: { id: existing.id },
      data: {
        categoryId: input.categoryId,
        periodStartDate: input.periodStartDate,
        periodEndDate: input.periodEndDate,
        dueDate: input.dueDate ?? null,
        grossAmount: amounts.grossAmount,
        deductionAmount: amounts.deductionAmount,
        netAmount: amounts.netAmount,
        notes: input.notes || null,
      },
    });

    await writeAuditLog(tx, {
      organizationId: actor.organizationId,
      actorId: actor.id,
      action: "progress_payment.update",
      entityType: "ProgressPayment",
      entityId: updated.id,
      before: { netAmount: existing.netAmount.toString() },
      after: { netAmount: amounts.netAmount.toString() },
    });

    return updated;
  });
}

async function requireDraftOwnedProgressPayment(actor: SessionUser, progressPaymentId: string) {
  if (!canManageProgressPayments(actor.role)) throw forbidden();
  const record = await db.progressPayment.findFirst({
    where: { id: progressPaymentId, organizationId: actor.organizationId },
  });
  if (!record) throw notFound("Kayıt bulunamadı");
  if (record.status !== "DRAFT") throw conflict("Ek iş kalemleri yalnızca taslak hakedişlerde düzenlenebilir");
  return record;
}

export async function addExtraWorkItem(actor: SessionUser, input: CreateExtraWorkItemInput) {
  const progressPayment = await requireDraftOwnedProgressPayment(actor, input.progressPaymentId);

  return db.$transaction(async (tx) => {
    const item = await tx.progressPaymentExtraWorkItem.create({
      data: {
        organizationId: actor.organizationId,
        progressPaymentId: progressPayment.id,
        description: input.description,
        amount: toDecimal(input.amount).toDecimalPlaces(2),
      },
    });
    await writeAuditLog(tx, {
      organizationId: actor.organizationId,
      actorId: actor.id,
      action: "progress_payment.extra_work_item.create",
      entityType: "ProgressPaymentExtraWorkItem",
      entityId: item.id,
      after: { progressPaymentId: progressPayment.id, amount: item.amount.toString() },
    });
    return item;
  });
}

export async function deleteExtraWorkItem(actor: SessionUser, input: ExtraWorkItemIdInput) {
  if (!canManageProgressPayments(actor.role)) throw forbidden();

  const item = await db.progressPaymentExtraWorkItem.findFirst({
    where: { id: input.id, organizationId: actor.organizationId },
  });
  if (!item) throw notFound("Kayıt bulunamadı");

  const parent = await requireDraftOwnedProgressPayment(actor, item.progressPaymentId);

  return db.$transaction(async (tx) => {
    await tx.progressPaymentExtraWorkItem.delete({ where: { id: item.id } });
    await writeAuditLog(tx, {
      organizationId: actor.organizationId,
      actorId: actor.id,
      action: "progress_payment.extra_work_item.delete",
      entityType: "ProgressPaymentExtraWorkItem",
      entityId: item.id,
      before: { progressPaymentId: parent.id, amount: item.amount.toString() },
    });
  });
}

export async function submitProgressPayment(actor: SessionUser, input: ProgressPaymentIdInput) {
  if (!canManageProgressPayments(actor.role)) throw forbidden();
  const existing = await db.progressPayment.findFirst({
    where: { id: input.id, organizationId: actor.organizationId },
  });
  if (!existing) throw notFound("Kayıt bulunamadı");

  return db.$transaction(async (tx) => {
    const locked = await lockProgressPayment(tx, actor.organizationId, existing.id);
    if (locked.status !== "DRAFT") throw conflict("Yalnızca taslak hakedişler gönderilebilir");

    const updated = await tx.progressPayment.update({
      where: { id: locked.id },
      data: { status: "SUBMITTED", submittedAt: new Date() },
    });
    await writeAuditLog(tx, {
      organizationId: actor.organizationId,
      actorId: actor.id,
      action: "progress_payment.submit",
      entityType: "ProgressPayment",
      entityId: updated.id,
      before: { status: "DRAFT" },
      after: { status: "SUBMITTED" },
    });
    return updated;
  });
}

/**
 * Hakediş onayı — SUBMITTED -> APPROVED. Onay anında `createIncomeInTransaction`
 * (server/services/transaction-service.ts, `createExpenseInTransaction` ile
 * aynı desen) çağrılarak, mevcut kilitli transaction İÇİNDE, kanonik
 * `createIncome` akışıyla BİREBİR AYNI doğrulama/normalizasyon/audit
 * kurallarını uygulayan TEK bir `FinancialTransaction` (type=INCOME)
 * oluşturulur — ikinci bir FinancialTransaction oluşturma kural kümesi burada
 * asla tutulmaz; gelir toplamı, alacak bakiyesi ve tahsilat mantığı burada
 * asla yeniden yazılmaz — o andan itibaren gerçeği taşıyan kayıt budur.
 *
 * İdempotenslik: satır `SELECT ... FOR UPDATE` ile kilitlenir ve durum kilit
 * ALTINDA yeniden okunur (bkz. `lockTransaction` ile aynı ilke,
 * server/services/ledger.ts). Kayıt zaten APPROVED ise hiçbir yeni kayıt
 * oluşturulmadan mevcut bağlı `FinancialTransaction` döndürülür — eşzamanlı
 * iki onay çağrısı asla iki kanonik kayıt üretemez, çünkü ikinci çağrı ilk
 * çağrının commit'ini bekler ve ardından "zaten onaylanmış" dalına düşer.
 * `financialTransactionId` üzerindeki DB @@unique kısıtı bunun ikinci bir
 * savunma katmanıdır.
 */
export async function approveProgressPayment(actor: SessionUser, input: ProgressPaymentIdInput) {
  if (!canManageProgressPayments(actor.role)) throw forbidden();
  const existing = await db.progressPayment.findFirst({
    where: { id: input.id, organizationId: actor.organizationId },
  });
  if (!existing) throw notFound("Kayıt bulunamadı");

  return db.$transaction(async (tx) => {
    const locked = await lockProgressPayment(tx, actor.organizationId, existing.id);

    if (locked.status === "APPROVED") {
      const linked = locked.financialTransactionId
        ? await tx.financialTransaction.findUnique({ where: { id: locked.financialTransactionId } })
        : null;
      return { progressPayment: locked, financialTransaction: linked };
    }
    if (locked.status !== "SUBMITTED") {
      throw conflict("Yalnızca gönderilmiş hakedişler onaylanabilir");
    }

    const project = await tx.project.findFirst({ where: { id: locked.projectId, organizationId: actor.organizationId } });
    if (!project) throw notFound("Proje bulunamadı");
    await assertIncomeCategoryInOrg(tx, actor.organizationId, locked.categoryId);

    const netAmount = toDecimal(locked.netAmount);
    const sequenceLabel = String(locked.sequenceNo).padStart(3, "0");

    const financialTransaction = await createIncomeInTransaction(tx, actor, {
      projectId: project.id,
      customerId: project.customerId ?? undefined,
      categoryId: locked.categoryId,
      documentNumber: `HK-${project.code}-${sequenceLabel}`,
      description: `Hakediş No ${locked.sequenceNo} — ${project.name}`,
      issueDate: locked.periodEndDate,
      dueDate: locked.dueDate ?? undefined,
      subtotal: netAmount.toNumber(),
      taxRate: 0,
    });

    const updated = await tx.progressPayment.update({
      where: { id: locked.id },
      data: {
        status: "APPROVED",
        approvedAt: new Date(),
        approvedById: actor.id,
        financialTransactionId: financialTransaction.id,
      },
    });

    await writeAuditLog(tx, {
      organizationId: actor.organizationId,
      actorId: actor.id,
      action: "progress_payment.approve",
      entityType: "ProgressPayment",
      entityId: updated.id,
      before: { status: "SUBMITTED" },
      after: { status: "APPROVED", financialTransactionId: financialTransaction.id },
    });

    return { progressPayment: updated, financialTransaction };
  });
}

export async function rejectProgressPayment(actor: SessionUser, input: RejectProgressPaymentInput) {
  if (!canManageProgressPayments(actor.role)) throw forbidden();
  const existing = await db.progressPayment.findFirst({
    where: { id: input.id, organizationId: actor.organizationId },
  });
  if (!existing) throw notFound("Kayıt bulunamadı");

  return db.$transaction(async (tx) => {
    const locked = await lockProgressPayment(tx, actor.organizationId, existing.id);
    if (locked.status !== "SUBMITTED") throw conflict("Yalnızca gönderilmiş hakedişler reddedilebilir");

    const updated = await tx.progressPayment.update({
      where: { id: locked.id },
      data: { status: "REJECTED", rejectedAt: new Date(), rejectedById: actor.id, rejectionReason: input.reason },
    });
    await writeAuditLog(tx, {
      organizationId: actor.organizationId,
      actorId: actor.id,
      action: "progress_payment.reject",
      entityType: "ProgressPayment",
      entityId: updated.id,
      before: { status: "SUBMITTED" },
      after: { status: "REJECTED", reason: input.reason },
    });
    return updated;
  });
}

/**
 * DRAFT/SUBMITTED hakedişler iptal edilebilir. APPROVED bir hakediş burada
 * KASITLI OLARAK reddedilir — onaylanmış bir hakediş artık kanonik bir
 * `FinancialTransaction`a bağlıdır ve iptali mevcut `cancelIncome`
 * (server/services/transaction-service.ts) akışı üzerinden yapılmalıdır;
 * aksi halde hakediş durumu ile bağlı finansal kaydın durumu birbirinden
 * sapabilir (bkz. görev talimatı "deletion of financially-linked approved
 * records should be prohibited or handled through existing reversal
 * semantics").
 */
export async function cancelProgressPayment(actor: SessionUser, input: CancelProgressPaymentInput) {
  if (!canManageProgressPayments(actor.role)) throw forbidden();
  const existing = await db.progressPayment.findFirst({
    where: { id: input.id, organizationId: actor.organizationId },
  });
  if (!existing) throw notFound("Kayıt bulunamadı");

  return db.$transaction(async (tx) => {
    const locked = await lockProgressPayment(tx, actor.organizationId, existing.id);
    if (locked.status !== "DRAFT" && locked.status !== "SUBMITTED") {
      throw conflict(
        "Yalnızca taslak veya gönderilmiş hakedişler iptal edilebilir; onaylanmış bir hakedişi iptal etmek için ilişkili gelir kaydını iptal edin",
      );
    }

    const updated = await tx.progressPayment.update({
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
      action: "progress_payment.cancel",
      entityType: "ProgressPayment",
      entityId: updated.id,
      before: { status: locked.status },
      after: { status: "CANCELLED", reason: input.reason },
    });
    return updated;
  });
}
