import { db } from "@/lib/db";
import { writeAuditLog } from "@/lib/audit";
import { canManageCategories, canViewCategories } from "@/lib/permissions";
import { forbidden, notFound, conflict } from "@/server/services/errors";
import type { SessionUser } from "@/lib/auth/session";
import type { CreateCategoryInput, RenameCategoryInput } from "@/lib/validation/category";

/**
 * Gelir/gider kategorileri organizasyon geneli ana kayıtlardır; PROJECT_MANAGER
 * erişemez (docs/SECURITY.md §1). Varsayılan (isSystem) kategoriler firma
 * kaydında otomatik oluşturulur (server/services/organization-service.ts) ve
 * bu servis üzerinden değiştirilemez/pasifleştirilemez — CLAUDE.md "sistem
 * kategorilerini koru" ilkesi.
 */
export async function listCategoriesForUser(actor: SessionUser) {
  if (!canViewCategories(actor.role)) throw forbidden();

  return db.transactionCategory.findMany({
    where: { organizationId: actor.organizationId },
    orderBy: [{ type: "asc" }, { name: "asc" }],
    include: { _count: { select: { transactions: true, budgetItems: true } } },
  });
}

async function assertNoDuplicateName(
  organizationId: string,
  type: CreateCategoryInput["type"],
  name: string,
  parentId: string | null,
  excludeId?: string,
) {
  // Postgres unique kısıtları NULL'ları birbirinden farklı sayar, bu yüzden
  // parentId=null olan (üst düzey) kategoriler için DB @@unique tek başına
  // yeterli değildir — burada açıkça kontrol edilir.
  const duplicate = await db.transactionCategory.findFirst({
    where: { organizationId, type, name, parentId, ...(excludeId ? { id: { not: excludeId } } : {}) },
  });
  if (duplicate) throw conflict("Bu isimde bir kategori zaten var");
}

export async function createCategory(actor: SessionUser, input: CreateCategoryInput) {
  if (!canManageCategories(actor.role)) throw forbidden();

  if (input.parentId) {
    const parent = await db.transactionCategory.findFirst({
      where: { id: input.parentId, organizationId: actor.organizationId, type: input.type },
    });
    if (!parent) throw notFound("Üst kategori bulunamadı");
  }
  await assertNoDuplicateName(actor.organizationId, input.type, input.name, input.parentId ?? null);

  return db
    .$transaction(async (tx) => {
      const category = await tx.transactionCategory.create({
        data: {
          organizationId: actor.organizationId,
          type: input.type,
          name: input.name,
          parentId: input.parentId ?? null,
          isSystem: false,
        },
      });
      await writeAuditLog(tx, {
        organizationId: actor.organizationId,
        actorId: actor.id,
        action: "category.create",
        entityType: "TransactionCategory",
        entityId: category.id,
        after: { name: category.name, type: category.type },
      });
      return category;
    })
    .catch((err) => {
      if (err?.code === "P2002") throw conflict("Bu isimde bir kategori zaten var");
      throw err;
    });
}

export async function renameCategory(actor: SessionUser, input: RenameCategoryInput) {
  if (!canManageCategories(actor.role)) throw forbidden();

  const existing = await db.transactionCategory.findFirst({
    where: { id: input.id, organizationId: actor.organizationId },
  });
  if (!existing) throw notFound("Kategori bulunamadı");
  if (existing.isSystem) throw forbidden("Varsayılan kategoriler düzenlenemez");
  await assertNoDuplicateName(actor.organizationId, existing.type, input.name, existing.parentId, existing.id);

  return db
    .$transaction(async (tx) => {
      const updated = await tx.transactionCategory.update({
        where: { id: existing.id },
        data: { name: input.name },
      });
      await writeAuditLog(tx, {
        organizationId: actor.organizationId,
        actorId: actor.id,
        action: "category.update",
        entityType: "TransactionCategory",
        entityId: updated.id,
        before: { name: existing.name },
        after: { name: updated.name },
      });
      return updated;
    })
    .catch((err) => {
      if (err?.code === "P2002") throw conflict("Bu isimde bir kategori zaten var");
      throw err;
    });
}

async function setCategoryActive(actor: SessionUser, categoryId: string, isActive: boolean) {
  if (!canManageCategories(actor.role)) throw forbidden();

  const existing = await db.transactionCategory.findFirst({
    where: { id: categoryId, organizationId: actor.organizationId },
  });
  if (!existing) throw notFound("Kategori bulunamadı");
  if (existing.isSystem) throw forbidden("Varsayılan kategoriler pasifleştirilemez");

  return db.$transaction(async (tx) => {
    const updated = await tx.transactionCategory.update({ where: { id: existing.id }, data: { isActive } });
    await writeAuditLog(tx, {
      organizationId: actor.organizationId,
      actorId: actor.id,
      action: isActive ? "category.reactivate" : "category.archive",
      entityType: "TransactionCategory",
      entityId: existing.id,
    });
    return updated;
  });
}

export const archiveCategory = (actor: SessionUser, categoryId: string) =>
  setCategoryActive(actor, categoryId, false);

export const reactivateCategory = (actor: SessionUser, categoryId: string) =>
  setCategoryActive(actor, categoryId, true);
