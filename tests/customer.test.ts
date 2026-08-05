import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { cleanDatabase, createOwnerOrg, createOrgUser } from "./helpers";
import {
  createCustomer,
  updateCustomer,
  archiveCustomer,
  reactivateCustomer,
  listCustomersForUser,
  getCustomerForUser,
} from "@/server/services/customer-service";
import { createProject } from "@/server/services/project-service";

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
  type: "COMPANY" as const,
  name: "ABC İnşaat Ltd.",
  identityOrTaxNumber: undefined,
  taxOffice: undefined,
  contactName: undefined,
  phone: undefined,
  email: undefined,
  city: undefined,
  district: undefined,
  address: undefined,
};

describe("müşteri yönetimi", () => {
  it("OWNER ve ADMIN müşteri oluşturabilir, FINANCE ve PROJECT_MANAGER oluşturamaz", async () => {
    const { owner } = await createOwnerOrg();
    const admin = await createOrgUser(owner.organizationId, "ADMIN");
    const finance = await createOrgUser(owner.organizationId, "FINANCE");
    const pm = await createOrgUser(owner.organizationId, "PROJECT_MANAGER");

    await expect(createCustomer(owner, baseInput)).resolves.toMatchObject({ name: baseInput.name });
    await expect(createCustomer(admin, { ...baseInput, name: "Admin Müşteri" })).resolves.toMatchObject({
      name: "Admin Müşteri",
    });
    await expect(createCustomer(finance, baseInput)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(createCustomer(pm, baseInput)).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("FINANCE müşteri listesini görebilir ama düzenleyemez veya arşivleyemez", async () => {
    const { owner } = await createOwnerOrg();
    const finance = await createOrgUser(owner.organizationId, "FINANCE");
    const customer = await createCustomer(owner, baseInput);

    const visible = await listCustomersForUser(finance);
    expect(visible.map((c) => c.id)).toContain(customer.id);

    await expect(updateCustomer(finance, { ...baseInput, id: customer.id, name: "Değişti" })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await expect(archiveCustomer(finance, customer.id)).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("organizasyon A, organizasyon B'nin müşterisine erişemez", async () => {
    const { owner: ownerA } = await createOwnerOrg();
    const { owner: ownerB } = await createOwnerOrg();
    const customerA = await createCustomer(ownerA, baseInput);

    const visibleForB = await listCustomersForUser(ownerB);
    expect(visibleForB.find((c) => c.id === customerA.id)).toBeUndefined();
    await expect(getCustomerForUser(ownerB, customerA.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("PROJECT_MANAGER yalnızca atandığı projeye bağlı müşterileri görür", async () => {
    const { owner } = await createOwnerOrg();
    const linkedCustomer = await createCustomer(owner, { ...baseInput, name: "Bağlı Müşteri" });
    const otherCustomer = await createCustomer(owner, { ...baseInput, name: "Bağlı Olmayan Müşteri" });

    const project = await createProject(owner, {
      code: "C-1",
      name: "Proje C-1",
      customerId: linkedCustomer.id,
      contractAmount: 0,
      estimatedBudget: 0,
    });

    const pm = await createOrgUser(owner.organizationId, "PROJECT_MANAGER");
    await db.projectMember.create({
      data: { organizationId: owner.organizationId, projectId: project.id, userId: pm.id },
    });

    const visible = await listCustomersForUser(pm);
    expect(visible.map((c) => c.id)).toEqual([linkedCustomer.id]);

    await expect(getCustomerForUser(pm, linkedCustomer.id)).resolves.toMatchObject({ id: linkedCustomer.id });
    await expect(getCustomerForUser(pm, otherCustomer.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("arşivleme ve yeniden etkinleştirme isActive alanını günceller ve audit log oluşturur", async () => {
    const { owner } = await createOwnerOrg();
    const customer = await createCustomer(owner, baseInput);

    const archived = await archiveCustomer(owner, customer.id);
    expect(archived.isActive).toBe(false);

    const reactivated = await reactivateCustomer(owner, customer.id);
    expect(reactivated.isActive).toBe(true);

    const logs = await db.auditLog.findMany({ where: { entityType: "Customer", entityId: customer.id } });
    expect(logs.map((l) => l.action)).toEqual(
      expect.arrayContaining(["customer.create", "customer.archive", "customer.reactivate"]),
    );
  });
});
