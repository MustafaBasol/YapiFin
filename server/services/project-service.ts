import { db } from "@/lib/db";
import { writeAuditLog } from "@/lib/audit";
import { canCreateProject, canManageProjectTeam, canViewAllProjects } from "@/lib/permissions";
import { forbidden, notFound, conflict } from "@/server/services/errors";
import type { SessionUser } from "@/lib/auth/session";
import type { CreateProjectInput, UpdateProjectInput } from "@/lib/validation/project";
import type { ProjectStatus } from "@prisma/client";

export async function listProjectsForUser(user: SessionUser) {
  if (canViewAllProjects(user.role)) {
    return db.project.findMany({
      where: { organizationId: user.organizationId },
      orderBy: { createdAt: "desc" },
      include: { customer: { select: { id: true, name: true } }, _count: { select: { members: true } } },
    });
  }

  return db.project.findMany({
    where: {
      organizationId: user.organizationId,
      members: { some: { userId: user.id } },
    },
    orderBy: { createdAt: "desc" },
    include: { customer: { select: { id: true, name: true } }, _count: { select: { members: true } } },
  });
}

export async function getProjectForUser(user: SessionUser, projectId: string) {
  const project = await db.project.findFirst({
    where: { id: projectId, organizationId: user.organizationId },
    include: {
      customer: true,
      members: { include: { user: { select: { id: true, firstName: true, lastName: true, email: true, role: true } } } },
    },
  });
  if (!project) throw notFound("Proje bulunamadı");

  if (!canViewAllProjects(user.role)) {
    const isMember = project.members.some((m) => m.userId === user.id);
    if (!isMember) throw notFound("Proje bulunamadı");
  }

  return project;
}

export async function createProject(actor: SessionUser, input: CreateProjectInput) {
  if (!canCreateProject(actor.role)) throw forbidden();

  if (input.customerId) {
    const customer = await db.customer.findFirst({
      where: { id: input.customerId, organizationId: actor.organizationId },
    });
    if (!customer) throw notFound("Müşteri bulunamadı");
  }

  return db
    .$transaction(async (tx) => {
      const project = await tx.project.create({
        data: {
          organizationId: actor.organizationId,
          code: input.code,
          name: input.name,
          customerId: input.customerId ?? null,
          city: input.city || null,
          district: input.district || null,
          address: input.address || null,
          startDate: input.startDate ?? null,
          plannedEndDate: input.plannedEndDate ?? null,
          contractAmount: input.contractAmount,
          estimatedBudget: input.estimatedBudget,
          notes: input.notes || null,
        },
      });
      await writeAuditLog(tx, {
        organizationId: actor.organizationId,
        actorId: actor.id,
        action: "project.create",
        entityType: "Project",
        entityId: project.id,
        after: { code: project.code, name: project.name },
      });
      return project;
    })
    .catch((err) => {
      if (err?.code === "P2002") throw conflict("Bu proje kodu zaten kullanılıyor");
      throw err;
    });
}

export async function updateProject(actor: SessionUser, input: UpdateProjectInput) {
  if (!canCreateProject(actor.role)) throw forbidden();

  const existing = await db.project.findFirst({
    where: { id: input.id, organizationId: actor.organizationId },
  });
  if (!existing) throw notFound("Proje bulunamadı");

  if (input.customerId) {
    const customer = await db.customer.findFirst({
      where: { id: input.customerId, organizationId: actor.organizationId },
    });
    if (!customer) throw notFound("Müşteri bulunamadı");
  }

  return db
    .$transaction(async (tx) => {
      const updated = await tx.project.update({
        where: { id: existing.id },
        data: {
          code: input.code,
          name: input.name,
          customerId: input.customerId ?? null,
          city: input.city || null,
          district: input.district || null,
          address: input.address || null,
          startDate: input.startDate ?? null,
          plannedEndDate: input.plannedEndDate ?? null,
          contractAmount: input.contractAmount,
          estimatedBudget: input.estimatedBudget,
          status: input.status,
          notes: input.notes || null,
        },
      });
      await writeAuditLog(tx, {
        organizationId: actor.organizationId,
        actorId: actor.id,
        action: "project.update",
        entityType: "Project",
        entityId: updated.id,
        before: { status: existing.status },
        after: { status: updated.status },
      });
      return updated;
    })
    .catch((err) => {
      if (err?.code === "P2002") throw conflict("Bu proje kodu zaten kullanılıyor");
      throw err;
    });
}

export async function setProjectStatus(actor: SessionUser, projectId: string, status: ProjectStatus) {
  if (!canCreateProject(actor.role)) throw forbidden();
  const existing = await db.project.findFirst({ where: { id: projectId, organizationId: actor.organizationId } });
  if (!existing) throw notFound("Proje bulunamadı");

  return db.$transaction(async (tx) => {
    const updated = await tx.project.update({ where: { id: existing.id }, data: { status } });
    await writeAuditLog(tx, {
      organizationId: actor.organizationId,
      actorId: actor.id,
      action: "project.status_change",
      entityType: "Project",
      entityId: existing.id,
      before: { status: existing.status },
      after: { status },
    });
    return updated;
  });
}

export async function assignProjectMember(actor: SessionUser, projectId: string, userId: string) {
  if (!canManageProjectTeam(actor.role)) throw forbidden();

  const [project, targetUser] = await Promise.all([
    db.project.findFirst({ where: { id: projectId, organizationId: actor.organizationId } }),
    db.user.findFirst({ where: { id: userId, organizationId: actor.organizationId } }),
  ]);
  if (!project) throw notFound("Proje bulunamadı");
  if (!targetUser) throw notFound("Kullanıcı bulunamadı");

  await db.$transaction(async (tx) => {
    await tx.projectMember.upsert({
      where: { projectId_userId: { projectId, userId } },
      create: { organizationId: actor.organizationId, projectId, userId },
      update: {},
    });
    await writeAuditLog(tx, {
      organizationId: actor.organizationId,
      actorId: actor.id,
      action: "project.member_add",
      entityType: "Project",
      entityId: projectId,
      after: { userId },
    });
  });
}

export async function removeProjectMember(actor: SessionUser, projectId: string, userId: string) {
  if (!canManageProjectTeam(actor.role)) throw forbidden();

  const project = await db.project.findFirst({ where: { id: projectId, organizationId: actor.organizationId } });
  if (!project) throw notFound("Proje bulunamadı");

  await db.$transaction(async (tx) => {
    const removed = await tx.projectMember.deleteMany({
      where: { projectId, userId, organizationId: actor.organizationId },
    });
    // Zaten üye olmayan bir kullanıcı için çağrı sessizce hiçbir şey silmez
    // (fail-closed, throw etmez — bkz. tests/tenant-role-security.test.ts);
    // gerçekte hiçbir satır etkilenmediyse yanıltıcı bir "başarılı kaldırma"
    // audit kaydı yaratılmamalı.
    if (removed.count === 0) return;
    await writeAuditLog(tx, {
      organizationId: actor.organizationId,
      actorId: actor.id,
      action: "project.member_remove",
      entityType: "Project",
      entityId: projectId,
      after: { userId },
    });
  });
}
