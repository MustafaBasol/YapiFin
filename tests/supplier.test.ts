import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { cleanDatabase, createOwnerOrg, createOrgUser } from "./helpers";
import {
  createSupplier,
  updateSupplier,
  archiveSupplier,
  reactivateSupplier,
  listSuppliersForUser,
  getSupplierForUser,
} from "@/server/services/supplier-service";

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
  type: "SUBCONTRACTOR" as const,
  name: "Demir Taşeronluk",
  identityOrTaxNumber: undefined,
  taxOffice: undefined,
  contactName: undefined,
  phone: undefined,
  email: undefined,
  city: undefined,
  district: undefined,
  address: undefined,
};

describe("tedarikçi/taşeron yönetimi", () => {
  it("OWNER ve ADMIN tedarikçi oluşturabilir, FINANCE oluşturamaz ama görebilir", async () => {
    const { owner } = await createOwnerOrg();
    const admin = await createOrgUser(owner.organizationId, "ADMIN");
    const finance = await createOrgUser(owner.organizationId, "FINANCE");

    const supplier = await createSupplier(owner, baseInput);
    expect(supplier.name).toBe(baseInput.name);
    await expect(createSupplier(admin, { ...baseInput, name: "Admin Tedarikçi" })).resolves.toMatchObject({
      name: "Admin Tedarikçi",
    });
    await expect(createSupplier(finance, baseInput)).rejects.toMatchObject({ code: "FORBIDDEN" });

    const visibleToFinance = await listSuppliersForUser(finance);
    expect(visibleToFinance.map((s) => s.id)).toContain(supplier.id);
  });

  it("PROJECT_MANAGER tedarikçi listesine ve kaydına erişemez", async () => {
    const { owner } = await createOwnerOrg();
    const supplier = await createSupplier(owner, baseInput);
    const pm = await createOrgUser(owner.organizationId, "PROJECT_MANAGER");

    await expect(listSuppliersForUser(pm)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(getSupplierForUser(pm, supplier.id)).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("organizasyon A, organizasyon B'nin tedarikçisine erişemez", async () => {
    const { owner: ownerA } = await createOwnerOrg();
    const { owner: ownerB } = await createOwnerOrg();
    const supplierA = await createSupplier(ownerA, baseInput);

    const visibleForB = await listSuppliersForUser(ownerB);
    expect(visibleForB.find((s) => s.id === supplierA.id)).toBeUndefined();
    await expect(getSupplierForUser(ownerB, supplierA.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("düzenleme ve arşivleme akışı çalışır ve audit log oluşturur", async () => {
    const { owner } = await createOwnerOrg();
    const supplier = await createSupplier(owner, baseInput);

    const updated = await updateSupplier(owner, { ...baseInput, id: supplier.id, name: "Güncellenmiş Ad" });
    expect(updated.name).toBe("Güncellenmiş Ad");

    const archived = await archiveSupplier(owner, supplier.id);
    expect(archived.isActive).toBe(false);
    const reactivated = await reactivateSupplier(owner, supplier.id);
    expect(reactivated.isActive).toBe(true);

    const logs = await db.auditLog.findMany({ where: { entityType: "Supplier", entityId: supplier.id } });
    expect(logs.map((l) => l.action)).toEqual(
      expect.arrayContaining(["supplier.create", "supplier.update", "supplier.archive", "supplier.reactivate"]),
    );
  });
});
