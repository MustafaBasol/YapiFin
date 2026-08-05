import { db } from "@/lib/db";
import { writeAuditLog } from "@/lib/audit";
import { canManageSuppliers, canViewSuppliers } from "@/lib/permissions";
import { forbidden, notFound } from "@/server/services/errors";
import type { SessionUser } from "@/lib/auth/session";
import type { CreateSupplierInput, UpdateSupplierInput } from "@/lib/validation/supplier";

/**
 * Tedarikçi/taşeronlar organizasyon geneli ana kayıtlardır ve proje bazlı bir
 * ilişkiye sahip değildir (docs/DATA_MODEL.md); PROJECT_MANAGER erişemez.
 */
export async function listSuppliersForUser(actor: SessionUser) {
  if (!canViewSuppliers(actor.role)) throw forbidden();

  return db.supplier.findMany({
    where: { organizationId: actor.organizationId },
    orderBy: { name: "asc" },
  });
}

export async function getSupplierForUser(actor: SessionUser, supplierId: string) {
  if (!canViewSuppliers(actor.role)) throw forbidden();

  const supplier = await db.supplier.findFirst({
    where: { id: supplierId, organizationId: actor.organizationId },
  });
  if (!supplier) throw notFound("Tedarikçi bulunamadı");
  return supplier;
}

function toSupplierData(input: CreateSupplierInput) {
  return {
    type: input.type,
    name: input.name,
    identityOrTaxNumber: input.identityOrTaxNumber || null,
    taxOffice: input.taxOffice || null,
    contactName: input.contactName || null,
    phone: input.phone || null,
    email: input.email || null,
    city: input.city || null,
    district: input.district || null,
    address: input.address || null,
  };
}

export async function createSupplier(actor: SessionUser, input: CreateSupplierInput) {
  if (!canManageSuppliers(actor.role)) throw forbidden();

  return db.$transaction(async (tx) => {
    const supplier = await tx.supplier.create({
      data: { organizationId: actor.organizationId, ...toSupplierData(input) },
    });
    await writeAuditLog(tx, {
      organizationId: actor.organizationId,
      actorId: actor.id,
      action: "supplier.create",
      entityType: "Supplier",
      entityId: supplier.id,
      after: { name: supplier.name, type: supplier.type },
    });
    return supplier;
  });
}

export async function updateSupplier(actor: SessionUser, input: UpdateSupplierInput) {
  if (!canManageSuppliers(actor.role)) throw forbidden();

  const existing = await db.supplier.findFirst({
    where: { id: input.id, organizationId: actor.organizationId },
  });
  if (!existing) throw notFound("Tedarikçi bulunamadı");

  return db.$transaction(async (tx) => {
    const updated = await tx.supplier.update({
      where: { id: existing.id },
      data: toSupplierData(input),
    });
    await writeAuditLog(tx, {
      organizationId: actor.organizationId,
      actorId: actor.id,
      action: "supplier.update",
      entityType: "Supplier",
      entityId: updated.id,
      before: { name: existing.name, type: existing.type },
      after: { name: updated.name, type: updated.type },
    });
    return updated;
  });
}

async function setSupplierActive(actor: SessionUser, supplierId: string, isActive: boolean) {
  if (!canManageSuppliers(actor.role)) throw forbidden();

  const existing = await db.supplier.findFirst({
    where: { id: supplierId, organizationId: actor.organizationId },
  });
  if (!existing) throw notFound("Tedarikçi bulunamadı");

  return db.$transaction(async (tx) => {
    const updated = await tx.supplier.update({ where: { id: existing.id }, data: { isActive } });
    await writeAuditLog(tx, {
      organizationId: actor.organizationId,
      actorId: actor.id,
      action: isActive ? "supplier.reactivate" : "supplier.archive",
      entityType: "Supplier",
      entityId: existing.id,
    });
    return updated;
  });
}

export const archiveSupplier = (actor: SessionUser, supplierId: string) =>
  setSupplierActive(actor, supplierId, false);

export const reactivateSupplier = (actor: SessionUser, supplierId: string) =>
  setSupplierActive(actor, supplierId, true);
