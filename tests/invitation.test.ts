import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { cleanDatabase, createOwnerOrg, createOrgUser } from "./helpers";
import { acceptInvitation, createInvitation } from "@/server/services/invitation-service";
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
