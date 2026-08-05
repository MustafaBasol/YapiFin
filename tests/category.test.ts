import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { cleanDatabase, createOwnerOrg, createOrgUser } from "./helpers";
import {
  listCategoriesForUser,
  createCategory,
  renameCategory,
  archiveCategory,
  reactivateCategory,
} from "@/server/services/category-service";

beforeAll(async () => {
  await cleanDatabase();
});
afterEach(async () => {
  await cleanDatabase();
});
afterAll(async () => {
  await db.$disconnect();
});

describe("gelir/gider kategori yönetimi", () => {
  it("firma kaydında varsayılan kategoriler isSystem=true olarak oluşur", async () => {
    const { owner } = await createOwnerOrg();
    const categories = await listCategoriesForUser(owner);
    expect(categories.length).toBeGreaterThan(0);
    expect(categories.every((c) => c.isSystem)).toBe(true);
  });

  it("varsayılan kategoriler düzenlenemez veya pasifleştirilemez", async () => {
    const { owner } = await createOwnerOrg();
    const [systemCategory] = await listCategoriesForUser(owner);

    await expect(renameCategory(owner, { id: systemCategory.id, name: "Yeni ad" })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await expect(archiveCategory(owner, systemCategory.id)).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("OWNER/ADMIN özel kategori oluşturabilir, FINANCE ve PROJECT_MANAGER oluşturamaz", async () => {
    const { owner } = await createOwnerOrg();
    const finance = await createOrgUser(owner.organizationId, "FINANCE");
    const pm = await createOrgUser(owner.organizationId, "PROJECT_MANAGER");

    const custom = await createCategory(owner, { type: "EXPENSE", name: "Özel Gider Kalemi" });
    expect(custom.isSystem).toBe(false);

    await expect(createCategory(finance, { type: "EXPENSE", name: "Finans Kategorisi" })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await expect(listCategoriesForUser(pm)).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("FINANCE kategori listesini görebilir ama yönetemez", async () => {
    const { owner } = await createOwnerOrg();
    const finance = await createOrgUser(owner.organizationId, "FINANCE");
    const custom = await createCategory(owner, { type: "INCOME", name: "Ekstra Gelir" });

    const visible = await listCategoriesForUser(finance);
    expect(visible.map((c) => c.id)).toContain(custom.id);

    await expect(renameCategory(finance, { id: custom.id, name: "Değişti" })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await expect(archiveCategory(finance, custom.id)).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("aynı organizasyon ve türde aynı isimde ikinci kategori reddedilir", async () => {
    const { owner } = await createOwnerOrg();
    await createCategory(owner, { type: "EXPENSE", name: "Tekrarsız Kategori" });

    await expect(createCategory(owner, { type: "EXPENSE", name: "Tekrarsız Kategori" })).rejects.toMatchObject({
      code: "CONFLICT",
    });
  });

  it("aynı isim farklı türde serbesttir", async () => {
    await createOwnerOrg().then(async ({ owner }) => {
      await createCategory(owner, { type: "EXPENSE", name: "Ortak İsim" });
      await expect(createCategory(owner, { type: "INCOME", name: "Ortak İsim" })).resolves.toMatchObject({
        name: "Ortak İsim",
      });
    });
  });

  it("özel kategori yeniden adlandırılabilir, arşivlenebilir ve etkinleştirilebilir", async () => {
    const { owner } = await createOwnerOrg();
    const custom = await createCategory(owner, { type: "EXPENSE", name: "Deneme Kategorisi" });

    const renamed = await renameCategory(owner, { id: custom.id, name: "Deneme Kategorisi v2" });
    expect(renamed.name).toBe("Deneme Kategorisi v2");

    const archived = await archiveCategory(owner, custom.id);
    expect(archived.isActive).toBe(false);
    const reactivated = await reactivateCategory(owner, custom.id);
    expect(reactivated.isActive).toBe(true);

    const logs = await db.auditLog.findMany({ where: { entityType: "TransactionCategory", entityId: custom.id } });
    expect(logs.map((l) => l.action)).toEqual(
      expect.arrayContaining(["category.create", "category.update", "category.archive", "category.reactivate"]),
    );
  });

  it("organizasyon A, organizasyon B'nin kategorisini düzenleyemez", async () => {
    const { owner: ownerA } = await createOwnerOrg();
    const { owner: ownerB } = await createOwnerOrg();
    const categoryA = await createCategory(ownerA, { type: "EXPENSE", name: "A Org Kategorisi" });

    await expect(renameCategory(ownerB, { id: categoryA.id, name: "Ele geçirildi" })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });
});
