import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { cleanDatabase, createOwnerOrg } from "./helpers";
import { createProject, getProjectForUser, listProjectsForUser } from "@/server/services/project-service";
import { listUsers } from "@/server/services/user-service";
import { ServiceError } from "@/server/services/errors";

beforeAll(async () => {
  await cleanDatabase();
});
afterEach(async () => {
  await cleanDatabase();
});
afterAll(async () => {
  await db.$disconnect();
});

describe("tenant izolasyonu", () => {
  it("organizasyon A, organizasyon B'nin projelerini listeleyemez", async () => {
    const { owner: ownerA } = await createOwnerOrg();
    const { owner: ownerB } = await createOwnerOrg();

    const projectA = await createProject(ownerA, {
      code: "A-1",
      name: "A Projesi",
      contractAmount: 0,
      estimatedBudget: 0,
    });

    const projectsForB = await listProjectsForUser(ownerB);
    expect(projectsForB.find((p) => p.id === projectA.id)).toBeUndefined();
  });

  it("bilinen bir başka tenant proje ID'sine doğrudan erişim NOT_FOUND döner", async () => {
    const { owner: ownerA } = await createOwnerOrg();
    const { owner: ownerB } = await createOwnerOrg();

    const projectA = await createProject(ownerA, {
      code: "A-2",
      name: "A Projesi 2",
      contractAmount: 0,
      estimatedBudget: 0,
    });

    await expect(getProjectForUser(ownerB, projectA.id)).rejects.toMatchObject({
      code: "NOT_FOUND",
    } satisfies Partial<ServiceError>);
  });

  it("organizasyon B kullanıcıları, organizasyon A'nın kullanıcı listesinde görünmez", async () => {
    const { owner: ownerA } = await createOwnerOrg();
    const { owner: ownerB } = await createOwnerOrg();

    const usersForA = await listUsers(ownerA);
    expect(usersForA.every((u) => u.id !== ownerB.id)).toBe(true);
    expect(usersForA).toHaveLength(1);
  });
});
