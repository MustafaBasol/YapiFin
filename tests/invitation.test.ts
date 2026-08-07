import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { cleanDatabase, createOwnerOrg, createOrgUser } from "./helpers";
import { acceptInvitation, createInvitation, resendInvitation } from "@/server/services/invitation-service";
import { createInvitationSchema } from "@/lib/validation/invitation";
import { generateToken } from "@/lib/auth/tokens";

beforeAll(async () => {
  await cleanDatabase();
});
afterEach(async () => {
  await cleanDatabase();
});
afterAll(async () => {
  await db.$disconnect();
});

async function acceptWithRawToken(invitationId: string) {
  const { raw, hash } = generateToken();
  await db.invitation.update({ where: { id: invitationId }, data: { tokenHash: hash } });
  return raw;
}

describe("davet doğrulama", () => {
  it("PROJECT_MANAGER daveti proje seçmeden reddedilir (zod)", () => {
    const result = createInvitationSchema.safeParse({
      email: "pm@example.com",
      role: "PROJECT_MANAGER",
      projectIds: [],
    });
    expect(result.success).toBe(false);
  });

  it("kullanılmış davet tekrar kullanılamaz", async () => {
    const { owner } = await createOwnerOrg();
    const invitation = await createInvitation(owner, { email: "finance@example.com", role: "FINANCE", projectIds: [] });
    const raw = await acceptWithRawToken(invitation.id);

    await acceptInvitation({ token: raw, firstName: "Fin", lastName: "Ans", password: "Sifre1234" });

    await expect(
      acceptInvitation({ token: raw, firstName: "Fin", lastName: "Ans", password: "Sifre1234" }),
    ).rejects.toMatchObject({ code: "VALIDATION" });
  });

  it("süresi dolmuş davet kabul edilemez", async () => {
    const { owner } = await createOwnerOrg();
    const invitation = await createInvitation(owner, { email: "expired@example.com", role: "FINANCE", projectIds: [] });
    const raw = await acceptWithRawToken(invitation.id);
    await db.invitation.update({ where: { id: invitation.id }, data: { expiresAt: new Date(Date.now() - 1000) } });

    await expect(
      acceptInvitation({ token: raw, firstName: "Süre", lastName: "Doldu", password: "Sifre1234" }),
    ).rejects.toMatchObject({ code: "VALIDATION" });
  });

  it("yalnızca OWNER, OWNER rolüyle davet gönderebilir", async () => {
    const { owner } = await createOwnerOrg();
    const admin = await createOrgUser(owner.organizationId, "ADMIN");

    await expect(
      createInvitation(admin, { email: "newowner@example.com", role: "OWNER", projectIds: [] }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});

describe("davet audit izi", () => {
  it("davet oluşturma tam olarak bir audit kaydı üretir; e-posta veya token metadata'da yer almaz", async () => {
    const { owner, organizationId } = await createOwnerOrg();
    const invitation = await createInvitation(owner, {
      email: "audit-create@example.com",
      role: "FINANCE",
      projectIds: [],
    });

    const logs = await db.auditLog.findMany({ where: { entityType: "Invitation", entityId: invitation.id } });
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ organizationId, actorId: owner.id, action: "invitation.create" });
    expect(logs[0].afterJson).toMatchObject({ role: "FINANCE" });
    expect(JSON.stringify(logs[0].beforeJson) + JSON.stringify(logs[0].afterJson)).not.toContain("@example.com");
  });

  it("davet yeniden gönderimi audit kaydı üretir; token hash metadata'da yer almaz", async () => {
    const { owner, organizationId } = await createOwnerOrg();
    const invitation = await createInvitation(owner, {
      email: "audit-resend@example.com",
      role: "FINANCE",
      projectIds: [],
    });
    const originalTokenHash = (await db.invitation.findUniqueOrThrow({ where: { id: invitation.id } })).tokenHash;

    await resendInvitation(owner, invitation.id);

    const logs = await db.auditLog.findMany({
      where: { entityType: "Invitation", entityId: invitation.id, action: "invitation.resend" },
    });
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ organizationId, actorId: owner.id });
    expect(JSON.stringify(logs[0].beforeJson) + JSON.stringify(logs[0].afterJson)).not.toContain(originalTokenHash);

    const updated = await db.invitation.findUniqueOrThrow({ where: { id: invitation.id } });
    expect(updated.tokenHash).not.toBe(originalTokenHash);
  });

  it("davet kabulü audit kaydı üretir; aktör yeni oluşturulan kullanıcıdır", async () => {
    const { owner } = await createOwnerOrg();
    const invitation = await createInvitation(owner, {
      email: "audit-accept@example.com",
      role: "FINANCE",
      projectIds: [],
    });
    const raw = await acceptWithRawToken(invitation.id);

    const { userId, organizationId } = await acceptInvitation({
      token: raw,
      firstName: "Kabul",
      lastName: "Testi",
      password: "Sifre1234",
    });

    const logs = await db.auditLog.findMany({
      where: { entityType: "Invitation", entityId: invitation.id, action: "invitation.accept" },
    });
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ organizationId, actorId: userId });
  });
});
