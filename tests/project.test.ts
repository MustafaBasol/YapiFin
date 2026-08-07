import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { cleanDatabase, createOwnerOrg, createOrgUser } from "./helpers";
import {
  createProject,
  updateProject,
  setProjectStatus,
  assignProjectMember,
  removeProjectMember,
} from "@/server/services/project-service";

beforeAll(async () => {
  await cleanDatabase();
});
afterEach(async () => {
  await cleanDatabase();
});
afterAll(async () => {
  await db.$disconnect();
});

const baseInput = {
  code: "PRJ-AUDIT-1",
  name: "Audit Test Projesi",
  contractAmount: 100000,
  estimatedBudget: 80000,
};

describe("proje kritik değişiklikleri audit izi", () => {
  it("proje oluşturma tam olarak bir audit kaydı üretir", async () => {
    const { owner, organizationId } = await createOwnerOrg();
    const project = await createProject(owner, baseInput);

    const logs = await db.auditLog.findMany({ where: { entityType: "Project", entityId: project.id } });
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ organizationId, actorId: owner.id, action: "project.create" });
  });

  it("proje güncelleme audit kaydı üretir; önceki/yeni durumu içerir", async () => {
    const { owner, organizationId } = await createOwnerOrg();
    const project = await createProject(owner, baseInput);

    await updateProject(owner, { ...baseInput, id: project.id, status: "ACTIVE" });

    const logs = await db.auditLog.findMany({
      where: { entityType: "Project", entityId: project.id, action: "project.update" },
    });
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ organizationId, actorId: owner.id });
    expect(logs[0].beforeJson).toMatchObject({ status: "DRAFT" });
    expect(logs[0].afterJson).toMatchObject({ status: "ACTIVE" });
  });

  it("proje durum değişikliği audit kaydı üretir", async () => {
    const { owner, organizationId } = await createOwnerOrg();
    const project = await createProject(owner, baseInput);

    await setProjectStatus(owner, project.id, "ON_HOLD");

    const logs = await db.auditLog.findMany({
      where: { entityType: "Project", entityId: project.id, action: "project.status_change" },
    });
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ organizationId, actorId: owner.id });
    expect(logs[0].beforeJson).toMatchObject({ status: "DRAFT" });
    expect(logs[0].afterJson).toMatchObject({ status: "ON_HOLD" });
  });

  it("proje üyeliği atama ve kaldırma, hedef kullanıcının ID'siyle audit kaydı üretir", async () => {
    const { owner, organizationId } = await createOwnerOrg();
    const project = await createProject(owner, baseInput);
    const pm = await createOrgUser(organizationId, "PROJECT_MANAGER");

    await assignProjectMember(owner, project.id, pm.id);
    await removeProjectMember(owner, project.id, pm.id);

    const logs = await db.auditLog.findMany({
      where: { entityType: "Project", entityId: project.id },
      orderBy: { createdAt: "asc" },
    });
    const memberLogs = logs.filter((l) => l.action === "project.member_add" || l.action === "project.member_remove");
    expect(memberLogs.map((l) => l.action)).toEqual(["project.member_add", "project.member_remove"]);
    for (const log of memberLogs) {
      expect(log).toMatchObject({ organizationId, actorId: owner.id });
      expect(log.afterJson).toMatchObject({ userId: pm.id });
    }
  });
});
