import { db } from "@/lib/db";
import { writeAuditLog } from "@/lib/audit";
import { canManageCustomers } from "@/lib/permissions";
import { forbidden, notFound } from "@/server/services/errors";
import type { SessionUser } from "@/lib/auth/session";
import type { CreateCustomerInput, UpdateCustomerInput } from "@/lib/validation/customer";

/**
 * Müşteriler organizasyon geneli ana kayıtlardır; PROJECT_MANAGER yalnızca
 * atandığı projelerle ilişkili müşterileri görebilir (docs/PRODUCT_REQUIREMENTS.md §3).
 */
export async function listCustomersForUser(user: SessionUser) {
  if (user.role === "PROJECT_MANAGER") {
    return db.customer.findMany({
      where: {
        organizationId: user.organizationId,
        projects: { some: { members: { some: { userId: user.id } } } },
      },
      orderBy: { name: "asc" },
      include: { _count: { select: { projects: true } } },
    });
  }

  return db.customer.findMany({
    where: { organizationId: user.organizationId },
    orderBy: { name: "asc" },
    include: { _count: { select: { projects: true } } },
  });
}

export async function getCustomerForUser(user: SessionUser, customerId: string) {
  const customer = await db.customer.findFirst({
    where: { id: customerId, organizationId: user.organizationId },
    include: { projects: { select: { id: true, code: true, name: true, status: true } } },
  });
  if (!customer) throw notFound("Müşteri bulunamadı");

  if (user.role === "PROJECT_MANAGER") {
    const projectIds = customer.projects.map((p) => p.id);
    const isMember =
      projectIds.length > 0 &&
      (await db.projectMember.findFirst({
        where: { userId: user.id, organizationId: user.organizationId, projectId: { in: projectIds } },
      }));
    if (!isMember) throw notFound("Müşteri bulunamadı");
  }

  return customer;
}

function toCustomerData(input: CreateCustomerInput) {
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

export async function createCustomer(actor: SessionUser, input: CreateCustomerInput) {
  if (!canManageCustomers(actor.role)) throw forbidden();

  return db.$transaction(async (tx) => {
    const customer = await tx.customer.create({
      data: { organizationId: actor.organizationId, ...toCustomerData(input) },
    });
    await writeAuditLog(tx, {
      organizationId: actor.organizationId,
      actorId: actor.id,
      action: "customer.create",
      entityType: "Customer",
      entityId: customer.id,
      after: { name: customer.name, type: customer.type },
    });
    return customer;
  });
}

export async function updateCustomer(actor: SessionUser, input: UpdateCustomerInput) {
  if (!canManageCustomers(actor.role)) throw forbidden();

  const existing = await db.customer.findFirst({
    where: { id: input.id, organizationId: actor.organizationId },
  });
  if (!existing) throw notFound("Müşteri bulunamadı");

  return db.$transaction(async (tx) => {
    const updated = await tx.customer.update({
      where: { id: existing.id },
      data: toCustomerData(input),
    });
    await writeAuditLog(tx, {
      organizationId: actor.organizationId,
      actorId: actor.id,
      action: "customer.update",
      entityType: "Customer",
      entityId: updated.id,
      before: { name: existing.name, type: existing.type },
      after: { name: updated.name, type: updated.type },
    });
    return updated;
  });
}

async function setCustomerActive(actor: SessionUser, customerId: string, isActive: boolean) {
  if (!canManageCustomers(actor.role)) throw forbidden();

  const existing = await db.customer.findFirst({
    where: { id: customerId, organizationId: actor.organizationId },
  });
  if (!existing) throw notFound("Müşteri bulunamadı");

  return db.$transaction(async (tx) => {
    const updated = await tx.customer.update({ where: { id: existing.id }, data: { isActive } });
    await writeAuditLog(tx, {
      organizationId: actor.organizationId,
      actorId: actor.id,
      action: isActive ? "customer.reactivate" : "customer.archive",
      entityType: "Customer",
      entityId: existing.id,
    });
    return updated;
  });
}

export const archiveCustomer = (actor: SessionUser, customerId: string) =>
  setCustomerActive(actor, customerId, false);

export const reactivateCustomer = (actor: SessionUser, customerId: string) =>
  setCustomerActive(actor, customerId, true);
