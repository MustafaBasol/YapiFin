import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { cleanDatabase, createOwnerOrg, createOrgUser } from "./helpers";
import { createProject, getProjectForUser, listProjectsForUser } from "@/server/services/project-service";
import { acceptInvitation, createInvitation } from "@/server/services/invitation-service";
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

describe("PROJECT_MANAGER kapsam kontrolü", () => {
  it("yalnızca atandığı projeleri görür ve atanmadığı projeye erişemez", async () => {
    const { owner } = await createOwnerOrg();

    const p1 = await createProject(owner, { code: "P-1", name: "Proje 1", contractAmount: 0, estimatedBudget: 0 });
    const p2 = await createProject(owner, { code: "P-2", name: "Proje 2", contractAmount: 0, estimatedBudget: 0 });

    const pm = await createOrgUser(owner.organizationId, "PROJECT_MANAGER");
    await db.projectMember.create({
      data: { organizationId: owner.organizationId, projectId: p1.id, userId: pm.id },
    });

    const visible = await listProjectsForUser(pm);
    expect(visible.map((p) => p.id)).toEqual([p1.id]);

    await expect(getProjectForUser(pm, p2.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(getProjectForUser(pm, p1.id)).resolves.toMatchObject({ id: p1.id });
  });

  it("PROJECT_MANAGER proje oluşturamaz", async () => {
    const { owner } = await createOwnerOrg();
    const pm = await createOrgUser(owner.organizationId, "PROJECT_MANAGER");

    await expect(
      createProject(pm, { code: "P-3", name: "Proje 3", contractAmount: 0, estimatedBudget: 0 }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("davet kabul edildiğinde PROJECT_MANAGER, davette seçilen projelere otomatik atanır", async () => {
    const { owner } = await createOwnerOrg();
    const p1 = await createProject(owner, { code: "P-4", name: "Proje 4", contractAmount: 0, estimatedBudget: 0 });

    const invitation = await createInvitation(owner, {
      email: "pm3@example.com",
      role: "PROJECT_MANAGER",
      projectIds: [p1.id],
    });

    // acceptInvitation, gönderilen e-postadaki ham token'ın hash'iyle eşleşen
    // daveti arar. Ham token yalnızca e-posta gövdesinde bulunduğundan (DB'de
    // sadece hash saklanır), testte bilinen bir ham değer üretip DB kaydını buna
    // göre güncelliyoruz — böylece servis kodu değişmeden uçtan uca doğrulanır.
    const { raw, hash } = generateToken();
    await db.invitation.update({ where: { id: invitation.id }, data: { tokenHash: hash } });

    const { userId } = await acceptInvitation({
      token: raw,
      firstName: "Proje",
      lastName: "Yöneticisi",
      password: "Sifre1234",
    });

    const memberships = await db.projectMember.findMany({ where: { userId } });
    expect(memberships.map((m) => m.projectId)).toEqual([p1.id]);
  });
});
