import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { cleanDatabase, createOwnerOrg, createOrgUser, toSessionUser } from "./helpers";
import { changeUserRole, deactivateUser, reactivateUser } from "@/server/services/user-service";

beforeAll(async () => {
  await cleanDatabase();
});
afterEach(async () => {
  await cleanDatabase();
});
afterAll(async () => {
  await db.$disconnect();
});

describe("kullanıcı ve rol yönetimi", () => {
  it("kullanıcı kendi rolünü değiştiremez", async () => {
    const { owner } = await createOwnerOrg();
    await expect(changeUserRole(owner, owner.id, "ADMIN")).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("kullanıcı kendini pasifleştiremez", async () => {
    const { owner } = await createOwnerOrg();
    await expect(deactivateUser(owner, owner.id)).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("ADMIN, OWNER üzerinde işlem yapamaz", async () => {
    const { owner } = await createOwnerOrg();
    const admin = await createOrgUser(owner.organizationId, "ADMIN");

    await expect(changeUserRole(admin, owner.id, "FINANCE")).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(deactivateUser(admin, owner.id)).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("yalnızca OWNER, başka bir kullanıcıyı OWNER yapabilir", async () => {
    const { owner } = await createOwnerOrg();
    const adminA = await createOrgUser(owner.organizationId, "ADMIN");
    const adminB = await createOrgUser(owner.organizationId, "ADMIN");

    await expect(changeUserRole(adminA, adminB.id, "OWNER")).rejects.toMatchObject({ code: "FORBIDDEN" });

    const promoted = await changeUserRole(owner, adminA.id, "OWNER");
    expect(promoted.role).toBe("OWNER");
  });

  it("son firma sahibi pasifleştirilemez veya rolü değiştirilemez", async () => {
    const { owner, organizationId } = await createOwnerOrg();
    const secondOwnerUser = await createOrgUser(organizationId, "ADMIN");
    const secondOwner = await toSessionUser((await changeUserRole(owner, secondOwnerUser.id, "OWNER")).id);

    // Şimdi organizasyonda 2 OWNER var: owner ve secondOwner.
    // secondOwner'ı ADMIN'e indirmek serbest olmalı (owner hâlâ kalıyor).
    await changeUserRole(owner, secondOwner.id, "ADMIN");

    const remainingOwners = await db.user.count({ where: { organizationId, role: "OWNER", status: "ACTIVE" } });
    expect(remainingOwners).toBe(1);
  });

  it("pasifleştirilen kullanıcının tüm oturumları sonlandırılır", async () => {
    const { owner, organizationId } = await createOwnerOrg();
    const finance = await createOrgUser(organizationId, "FINANCE");
    await db.session.create({
      data: {
        userId: finance.id,
        tokenHash: `test-${finance.id}`,
        expiresAt: new Date(Date.now() + 60_000),
      },
    });

    await deactivateUser(owner, finance.id);

    const sessions = await db.session.count({ where: { userId: finance.id } });
    expect(sessions).toBe(0);
    const updated = await db.user.findUniqueOrThrow({ where: { id: finance.id } });
    expect(updated.status).toBe("SUSPENDED");
  });

  it("rol değişikliği tam olarak bir audit kaydı üretir; aktör ve hedef ID'leriyle, e-posta olmadan", async () => {
    const { owner, organizationId } = await createOwnerOrg();
    const finance = await createOrgUser(organizationId, "FINANCE");

    await changeUserRole(owner, finance.id, "ADMIN");

    const logs = await db.auditLog.findMany({ where: { entityType: "User", entityId: finance.id } });
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({
      organizationId,
      actorId: owner.id,
      action: "user.role_change",
      entityId: finance.id,
    });
    expect(logs[0].beforeJson).toMatchObject({ role: "FINANCE" });
    expect(logs[0].afterJson).toMatchObject({ role: "ADMIN" });
    expect(JSON.stringify(logs[0].beforeJson)).not.toContain("@");
    expect(JSON.stringify(logs[0].afterJson)).not.toContain("@");
  });

  it("pasifleştirme tam olarak bir audit kaydı üretir; hassas veri içermez", async () => {
    const { owner, organizationId } = await createOwnerOrg();
    const finance = await createOrgUser(organizationId, "FINANCE");

    await deactivateUser(owner, finance.id);

    const logs = await db.auditLog.findMany({ where: { entityType: "User", entityId: finance.id } });
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({
      organizationId,
      actorId: owner.id,
      action: "user.deactivate",
      entityId: finance.id,
    });
    expect(logs[0].beforeJson).toBeNull();
    expect(logs[0].afterJson).toBeNull();
  });

  it("yeniden etkinleştirme tam olarak bir audit kaydı üretir", async () => {
    const { owner, organizationId } = await createOwnerOrg();
    const finance = await createOrgUser(organizationId, "FINANCE");
    await deactivateUser(owner, finance.id);

    await reactivateUser(owner, finance.id);

    const logs = await db.auditLog.findMany({
      where: { entityType: "User", entityId: finance.id, action: "user.reactivate" },
    });
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ organizationId, actorId: owner.id });

    const updated = await db.user.findUniqueOrThrow({ where: { id: finance.id } });
    expect(updated.status).toBe("ACTIVE");
  });
});
