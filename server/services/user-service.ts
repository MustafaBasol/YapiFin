import { db } from "@/lib/db";
import { writeAuditLog } from "@/lib/audit";
import { canManageUsers } from "@/lib/permissions";
import { forbidden, notFound, ServiceError } from "@/server/services/errors";
import type { SessionUser } from "@/lib/auth/session";
import type { UserRole } from "@prisma/client";

export async function listUsers(actor: SessionUser) {
  if (!canManageUsers(actor.role)) throw forbidden();
  return db.user.findMany({
    where: { organizationId: actor.organizationId },
    orderBy: { createdAt: "asc" },
    include: { projectMemberships: { include: { project: { select: { id: true, name: true } } } } },
  });
}

async function getTenantScopedUser(actor: SessionUser, targetUserId: string) {
  const target = await db.user.findFirst({
    where: { id: targetUserId, organizationId: actor.organizationId },
  });
  if (!target) throw notFound();
  return target;
}

async function assertOtherOwnerRemains(organizationId: string, excludingUserId: string) {
  const remaining = await db.user.count({
    where: { organizationId, role: "OWNER", status: "ACTIVE", id: { not: excludingUserId } },
  });
  if (remaining === 0) throw new ServiceError("Son firma sahibi için bu işlem yapılamaz", "CONFLICT");
}

export async function changeUserRole(actor: SessionUser, targetUserId: string, newRole: UserRole) {
  if (!canManageUsers(actor.role)) throw forbidden();
  if (actor.id === targetUserId) throw forbidden("Kendi rolünüzü değiştiremezsiniz");

  const target = await getTenantScopedUser(actor, targetUserId);
  if (target.role === "OWNER" && actor.role !== "OWNER") {
    throw forbidden("Yönetici, firma sahibi üzerinde işlem yapamaz");
  }
  if (newRole === "OWNER" && actor.role !== "OWNER") {
    throw forbidden("Yalnızca firma sahibi başka bir kullanıcıyı firma sahibi yapabilir");
  }
  if (target.role === "OWNER" && newRole !== "OWNER") {
    await assertOtherOwnerRemains(actor.organizationId, target.id);
  }

  const updated = await db.$transaction(async (tx) => {
    const user = await tx.user.update({ where: { id: target.id }, data: { role: newRole } });
    await writeAuditLog(tx, {
      organizationId: actor.organizationId,
      actorId: actor.id,
      action: "user.role_change",
      entityType: "User",
      entityId: target.id,
      before: { role: target.role },
      after: { role: newRole },
    });
    return user;
  });

  return updated;
}

export async function deactivateUser(actor: SessionUser, targetUserId: string) {
  if (!canManageUsers(actor.role)) throw forbidden();
  if (actor.id === targetUserId) throw forbidden("Kendinizi pasifleştiremezsiniz");

  const target = await getTenantScopedUser(actor, targetUserId);
  if (target.role === "OWNER" && actor.role !== "OWNER") {
    throw forbidden("Yönetici, firma sahibi üzerinde işlem yapamaz");
  }
  if (target.role === "OWNER") {
    await assertOtherOwnerRemains(actor.organizationId, target.id);
  }

  await db.$transaction(async (tx) => {
    await tx.user.update({ where: { id: target.id }, data: { status: "SUSPENDED" } });
    await tx.session.deleteMany({ where: { userId: target.id } });
    await writeAuditLog(tx, {
      organizationId: actor.organizationId,
      actorId: actor.id,
      action: "user.deactivate",
      entityType: "User",
      entityId: target.id,
    });
  });
}

export async function reactivateUser(actor: SessionUser, targetUserId: string) {
  if (!canManageUsers(actor.role)) throw forbidden();
  const target = await getTenantScopedUser(actor, targetUserId);
  if (target.role === "OWNER" && actor.role !== "OWNER") {
    throw forbidden("Yönetici, firma sahibi üzerinde işlem yapamaz");
  }

  await db.$transaction(async (tx) => {
    await tx.user.update({ where: { id: target.id }, data: { status: "ACTIVE" } });
    await writeAuditLog(tx, {
      organizationId: actor.organizationId,
      actorId: actor.id,
      action: "user.reactivate",
      entityType: "User",
      entityId: target.id,
    });
  });
}
