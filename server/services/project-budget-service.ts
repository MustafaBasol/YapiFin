import { db } from "@/lib/db";
import { writeAuditLog } from "@/lib/audit";
import { canManageProjectBudget } from "@/lib/permissions";
import { getProjectForUser } from "@/server/services/project-service";
import { getProjectFinanceSummary } from "@/server/services/project-finance-service";
import { getBudgetStatus, type BudgetStatus } from "@/server/services/budget-report-service";
import { toDecimal, ZERO } from "@/server/services/ledger";
import { ServiceError, forbidden, notFound, conflict } from "@/server/services/errors";
import type { SessionUser } from "@/lib/auth/session";
import type {
  CreateProjectBudgetItemInput,
  UpdateProjectBudgetItemInput,
} from "@/lib/validation/project-budget";
import type { ProjectStatus } from "@prisma/client";

/**
 * YF-406 — Proje bütçe kalemleri planlama ve yönetimi.
 *
 * `ProjectBudgetItem` (proje + kategori bazlı planlanan tutar) şemada YF-402'de
 * eklenmiş, YF-404'te yalnızca *okunmuş* (rapor amaçlı), bu görevde ilk kez
 * bir yönetim (create/update/delete) arayüzü kazanıyor (bkz. docs/ARCHITECTURE.md
 * §13.2, §13.3 "Bilinen eksikler"). Şemada zaten `@@unique([projectId, categoryId])`
 * bulunduğundan migration gerekmedi.
 *
 * Durum eşiği (`getBudgetStatus`) ve gerçekleşen gider (proje×kategori dağılımı,
 * iptal edilmiş kayıtlar hariç) YF-402/404'ten birebir yeniden kullanılır —
 * `getProjectFinanceSummary`'nin `categoryDistribution`/`totalRecordedExpense`
 * alanları burada tekrar hesaplanmaz. Bu, proje başına tek bir ek sorgu
 * (`projectBudgetItem.findMany`) + mevcut, zaten sınırlı/gruplu finans özeti
 * sorgularıyla çalışır; kalem başına ayrı sorgu yapılmaz (N+1 yok).
 */

export interface ProjectBudgetPlanningItem {
  id: string;
  categoryId: string;
  categoryName: string;
  categoryIsActive: boolean;
  plannedAmount: string;
  realizedExpense: string;
  remainingAmount: string;
  usagePercentage: string | null;
  status: BudgetStatus;
  description: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ProjectBudgetPlanning {
  project: {
    id: string;
    name: string;
    code: string;
    status: ProjectStatus;
    currency: string;
  };
  totalPlannedBudget: string;
  totalRealizedExpense: string;
  totalRemainingBudget: string;
  totalUsagePercentage: string | null;
  status: BudgetStatus;
  items: ProjectBudgetPlanningItem[];
  canManage: boolean;
}

export async function getProjectBudgetPlanning(actor: SessionUser, projectId: string): Promise<ProjectBudgetPlanning> {
  const project = await getProjectForUser(actor, projectId);

  const [budgetItems, financeSummary] = await Promise.all([
    db.projectBudgetItem.findMany({
      where: { projectId: project.id, organizationId: actor.organizationId },
      include: { category: { select: { id: true, name: true, isActive: true } } },
      orderBy: { createdAt: "asc" },
    }),
    getProjectFinanceSummary(actor, projectId),
  ]);

  const realizedByCategory = new Map(financeSummary.categoryDistribution.map((c) => [c.categoryId, toDecimal(c.amount)]));
  const totalRealizedExpense = toDecimal(financeSummary.totalRecordedExpense);

  const items: ProjectBudgetPlanningItem[] = budgetItems.map((item) => {
    const planned = toDecimal(item.plannedAmount);
    const realized = realizedByCategory.get(item.categoryId) ?? ZERO;
    const usagePercentage = planned.greaterThan(ZERO) ? realized.div(planned).mul(100).toDecimalPlaces(2).toString() : null;
    return {
      id: item.id,
      categoryId: item.categoryId,
      categoryName: item.category.name,
      categoryIsActive: item.category.isActive,
      plannedAmount: planned.toString(),
      realizedExpense: realized.toString(),
      remainingAmount: planned.minus(realized).toString(),
      usagePercentage,
      status: getBudgetStatus(planned, realized),
      description: item.notes,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
    };
  });

  const totalPlannedBudget = budgetItems.reduce((sum, item) => sum.plus(toDecimal(item.plannedAmount)), ZERO);
  const totalUsagePercentage = totalPlannedBudget.greaterThan(ZERO)
    ? totalRealizedExpense.div(totalPlannedBudget).mul(100).toDecimalPlaces(2).toString()
    : null;

  return {
    project: { id: project.id, name: project.name, code: project.code, status: project.status, currency: "TRY" },
    totalPlannedBudget: totalPlannedBudget.toString(),
    totalRealizedExpense: totalRealizedExpense.toString(),
    totalRemainingBudget: totalPlannedBudget.minus(totalRealizedExpense).toString(),
    totalUsagePercentage,
    status: getBudgetStatus(totalPlannedBudget, totalRealizedExpense),
    items,
    canManage: canManageProjectBudget(actor.role),
  };
}

async function resolveActiveExpenseCategory(actor: SessionUser, categoryId: string) {
  const category = await db.transactionCategory.findFirst({
    where: { id: categoryId, organizationId: actor.organizationId, type: "EXPENSE" },
  });
  if (!category) throw notFound("Gider kategorisi bulunamadı");
  if (!category.isActive) throw new ServiceError("Pasif kategori için bütçe kalemi seçilemez");
  return category;
}

export async function createProjectBudgetItem(actor: SessionUser, input: CreateProjectBudgetItemInput) {
  if (!canManageProjectBudget(actor.role)) throw forbidden();

  const project = await getProjectForUser(actor, input.projectId);
  const category = await resolveActiveExpenseCategory(actor, input.categoryId);
  const description = input.description?.trim() || null;

  return db
    .$transaction(async (tx) => {
      const item = await tx.projectBudgetItem.create({
        data: {
          organizationId: actor.organizationId,
          projectId: project.id,
          categoryId: category.id,
          plannedAmount: input.plannedAmount,
          notes: description,
        },
      });
      await writeAuditLog(tx, {
        organizationId: actor.organizationId,
        actorId: actor.id,
        action: "project_budget_item.create",
        entityType: "ProjectBudgetItem",
        entityId: item.id,
        after: { projectName: project.name, categoryName: category.name, plannedAmount: item.plannedAmount.toString() },
      });
      return item;
    })
    .catch((err) => {
      if (err?.code === "P2002") throw conflict("Bu proje için bu kategoride zaten bir bütçe kalemi var");
      throw err;
    });
}

export async function updateProjectBudgetItem(actor: SessionUser, input: UpdateProjectBudgetItemInput) {
  if (!canManageProjectBudget(actor.role)) throw forbidden();

  const existing = await db.projectBudgetItem.findFirst({
    where: { id: input.id, organizationId: actor.organizationId },
    include: { category: true },
  });
  if (!existing) throw notFound("Bütçe kalemi bulunamadı");
  // Savunma amaçlı ikinci kapsam kontrolü: proje hâlâ aktörün erişebildiği kapsamda mı.
  await getProjectForUser(actor, existing.projectId);

  const category =
    input.categoryId === existing.categoryId ? existing.category : await resolveActiveExpenseCategory(actor, input.categoryId);
  const description = input.description?.trim() || null;

  return db
    .$transaction(async (tx) => {
      const result = await tx.projectBudgetItem.updateMany({
        where: { id: existing.id, organizationId: actor.organizationId },
        data: { categoryId: category.id, plannedAmount: input.plannedAmount, notes: description },
      });
      if (result.count === 0) throw notFound("Bütçe kalemi bulunamadı");
      await writeAuditLog(tx, {
        organizationId: actor.organizationId,
        actorId: actor.id,
        action: "project_budget_item.update",
        entityType: "ProjectBudgetItem",
        entityId: existing.id,
        before: { plannedAmount: existing.plannedAmount.toString(), categoryName: existing.category.name },
        after: { plannedAmount: input.plannedAmount, categoryName: category.name },
      });
      return tx.projectBudgetItem.findUniqueOrThrow({ where: { id: existing.id } });
    })
    .catch((err) => {
      if (err?.code === "P2002") throw conflict("Bu proje için bu kategoride zaten bir bütçe kalemi var");
      throw err;
    });
}

export async function deleteProjectBudgetItem(actor: SessionUser, itemId: string) {
  if (!canManageProjectBudget(actor.role)) throw forbidden();

  const existing = await db.projectBudgetItem.findFirst({
    where: { id: itemId, organizationId: actor.organizationId },
    include: { project: { select: { id: true, name: true } }, category: { select: { name: true } } },
  });
  if (!existing) throw notFound("Bütçe kalemi bulunamadı");
  await getProjectForUser(actor, existing.projectId);

  await db.$transaction(async (tx) => {
    const result = await tx.projectBudgetItem.deleteMany({ where: { id: existing.id, organizationId: actor.organizationId } });
    if (result.count === 0) throw notFound("Bütçe kalemi bulunamadı");
    await writeAuditLog(tx, {
      organizationId: actor.organizationId,
      actorId: actor.id,
      action: "project_budget_item.delete",
      entityType: "ProjectBudgetItem",
      entityId: existing.id,
      before: {
        projectName: existing.project.name,
        categoryName: existing.category.name,
        plannedAmount: existing.plannedAmount.toString(),
      },
    });
  });

  return { projectId: existing.project.id };
}
