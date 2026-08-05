import { db } from "@/lib/db";
import { hashPassword } from "@/lib/auth/password";
import { generateToken, hashToken } from "@/lib/auth/tokens";
import { sendInvitationEmail } from "@/lib/email/mailer";
import { writeAuditLog } from "@/lib/audit";
import { canManageUsers } from "@/lib/permissions";
import { forbidden, notFound, conflict, ServiceError } from "@/server/services/errors";
import type { SessionUser } from "@/lib/auth/session";
import type { CreateInvitationInput } from "@/lib/validation/invitation";
import type { AcceptInvitationInput } from "@/lib/validation/auth";

const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 gün

export async function createInvitation(actor: SessionUser, input: CreateInvitationInput) {
  if (!canManageUsers(actor.role)) throw forbidden();
  if (input.role === "OWNER" && actor.role !== "OWNER") {
    throw forbidden("Yalnızca firma sahibi başka bir firma sahibi davet edebilir");
  }

  const existingUser = await db.user.findFirst({
    where: { organizationId: actor.organizationId, email: input.email },
  });
  if (existingUser) throw conflict("Bu e-posta ile organizasyonda zaten bir kullanıcı var");

  if (input.projectIds.length > 0) {
    const count = await db.project.count({
      where: { organizationId: actor.organizationId, id: { in: input.projectIds } },
    });
    if (count !== input.projectIds.length) throw notFound("Seçilen projelerden biri bulunamadı");
  }

  const { raw } = generateToken();
  const invitation = await db.$transaction(async (tx) => {
    await tx.invitation.deleteMany({
      where: { organizationId: actor.organizationId, email: input.email, acceptedAt: null },
    });
    const created = await tx.invitation.create({
      data: {
        organizationId: actor.organizationId,
        email: input.email,
        role: input.role,
        projectIds: input.projectIds,
        tokenHash: hashToken(raw),
        expiresAt: new Date(Date.now() + INVITATION_TTL_MS),
        invitedById: actor.id,
      },
    });
    await writeAuditLog(tx, {
      organizationId: actor.organizationId,
      actorId: actor.id,
      action: "invitation.create",
      entityType: "Invitation",
      entityId: created.id,
      after: { email: input.email, role: input.role },
    });
    return created;
  });

  await sendInvitationEmail(
    input.email,
    raw,
    actor.organizationName,
    `${actor.firstName} ${actor.lastName}`,
  );

  return invitation;
}

export async function resendInvitation(actor: SessionUser, invitationId: string) {
  if (!canManageUsers(actor.role)) throw forbidden();
  const invitation = await db.invitation.findFirst({
    where: { id: invitationId, organizationId: actor.organizationId },
  });
  if (!invitation) throw notFound();
  if (invitation.acceptedAt) throw new ServiceError("Davet zaten kabul edilmiş", "CONFLICT");

  const { raw } = generateToken();
  await db.invitation.update({
    where: { id: invitation.id },
    data: { tokenHash: hashToken(raw), expiresAt: new Date(Date.now() + INVITATION_TTL_MS) },
  });
  await sendInvitationEmail(
    invitation.email,
    raw,
    actor.organizationName,
    `${actor.firstName} ${actor.lastName}`,
  );
}

export async function acceptInvitation(input: AcceptInvitationInput) {
  const invitation = await db.invitation.findUnique({ where: { tokenHash: hashToken(input.token) } });
  if (!invitation || invitation.acceptedAt || invitation.expiresAt < new Date()) {
    throw new ServiceError("Davet bağlantısı geçersiz, kullanılmış veya süresi dolmuş", "VALIDATION");
  }

  const existingUser = await db.user.findFirst({
    where: { organizationId: invitation.organizationId, email: invitation.email },
  });
  if (existingUser) throw conflict("Bu e-posta ile organizasyonda zaten bir kullanıcı var");

  const passwordHash = await hashPassword(input.password);

  const userId = await db.$transaction(async (tx) => {
    const user = await tx.user.create({
      data: {
        organizationId: invitation.organizationId,
        firstName: input.firstName,
        lastName: input.lastName,
        email: invitation.email,
        passwordHash,
        role: invitation.role,
        status: "ACTIVE",
        emailVerifiedAt: new Date(),
      },
    });

    if (invitation.role === "PROJECT_MANAGER" && invitation.projectIds.length > 0) {
      await tx.projectMember.createMany({
        data: invitation.projectIds.map((projectId) => ({
          organizationId: invitation.organizationId,
          projectId,
          userId: user.id,
        })),
        skipDuplicates: true,
      });
    }

    await tx.invitation.update({ where: { id: invitation.id }, data: { acceptedAt: new Date() } });

    await writeAuditLog(tx, {
      organizationId: invitation.organizationId,
      actorId: user.id,
      action: "invitation.accept",
      entityType: "Invitation",
      entityId: invitation.id,
      after: { userId: user.id },
    });

    return user.id;
  });

  return { userId, organizationId: invitation.organizationId };
}

export async function lookupInvitationByToken(token: string) {
  const invitation = await db.invitation.findUnique({
    where: { tokenHash: hashToken(token) },
    include: { organization: { select: { name: true, tradeName: true } } },
  });
  if (!invitation) return null;
  return {
    email: invitation.email,
    role: invitation.role,
    organizationName: invitation.organization.tradeName ?? invitation.organization.name,
    expired: invitation.expiresAt < new Date(),
    accepted: Boolean(invitation.acceptedAt),
  };
}

export async function listPendingInvitations(actor: SessionUser) {
  if (!canManageUsers(actor.role)) throw forbidden();
  return db.invitation.findMany({
    where: { organizationId: actor.organizationId, acceptedAt: null },
    orderBy: { createdAt: "desc" },
  });
}
