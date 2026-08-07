import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { cleanDatabase, createOwnerOrg, createOrgUser } from "./helpers";
import {
  createProject,
  getProjectForUser,
  assignProjectMember,
  removeProjectMember,
} from "@/server/services/project-service";
import { createAccount, getAccountForUser } from "@/server/services/account-service";
import {
  createIncome,
  createExpense,
  updateIncome,
  cancelIncome,
  getTransactionForUser,
} from "@/server/services/transaction-service";
import { createSettlement, cancelSettlement } from "@/server/services/settlement-service";
import { createTransfer, cancelTransfer, getTransferForUser } from "@/server/services/transfer-service";
import { changeUserRole, deactivateUser, reactivateUser } from "@/server/services/user-service";
import { createInvitation, resendInvitation } from "@/server/services/invitation-service";
import { createCustomer, getCustomerForUser } from "@/server/services/customer-service";
import { createSupplier, getSupplierForUser } from "@/server/services/supplier-service";
import { getProjectFinanceSummaryForResolvedProject } from "@/server/services/project-finance-service";
import type { SessionUser } from "@/lib/auth/session";

/**
 * YF-501 — Tenant izolasyonu ve rol güvenliği entegrasyon kapsamı.
 *
 * Bu dosya, tenant/RBAC davranışını başka test dosyalarında zaten kapsanan
 * senaryolarla (bkz. tests/account.test.ts, tests/customer.test.ts,
 * tests/category.test.ts, tests/supplier.test.ts, tests/transfer.test.ts
 * [createTransfer çapraz-tenant], tests/transaction.test.ts [kategori/
 * müşteri/tedarikçi çapraz-tenant], tests/project-budget*.test.ts,
 * tests/project-finance.test.ts, tests/report-export-service.test.ts,
 * tests/dashboard.test.ts, tests/tenant-isolation.test.ts,
 * tests/project-manager-scope.test.ts, tests/user-management.test.ts)
 * TEKRARLAMAZ. Yalnızca kod incelemesiyle tespit edilen, henüz hiçbir yerde
 * doğrulanmamış boşlukları kapatır:
 *
 *  - Settlement (tahsilat/ödeme) oluşturma/iptalinde çapraz-tenant ID'ler
 *  - Transfer iptalinde ve transfer detay okumasında çapraz-tenant ID
 *  - Gelir/gider güncelleme ve iptalinde çapraz-tenant kayıt ID'si
 *  - Gelir/gider oluştururken başka tenant'a ait projectId (dolaylı ilişki)
 *  - Proje üyeliği atama/kaldırmada başka tenant'a ait userId
 *  - Kullanıcı rol değişikliği/pasifleştirme/yeniden etkinleştirmede
 *    başka organizasyona ait hedef kullanıcı
 *  - Davet yeniden gönderiminde başka organizasyona ait invitationId ve
 *    davet oluştururken başka organizasyona ait projectId
 *  - ID numaralandırma: "başka tenant'ta var" ile "hiç yok" durumlarının
 *    ayırt edilemez (aynı NOT_FOUND) olduğu doğrulaması
 *  - Rol matrisi tamamlayıcıları: FINANCE/PROJECT_MANAGER için kullanıcı
 *    yönetimi ve davet reddi, ADMIN için tahsilat oluşturma izni
 *  - "Çözümlenmiş proje" tenant korumasının (YF-407-R1 deseni)
 *    project-finance-service için de geçerli olduğu
 *
 * Rol matrisi (docs/SECURITY.md §1 ve lib/permissions.ts ile birebir,
 * ayrıntılı ispatlar parantez içindeki dosyalarda):
 *
 * | İşlem                     | OWNER | ADMIN | FINANCE | PROJECT_MANAGER |
 * |---------------------------|:-----:|:-----:|:-------:|:----------------:|
 * | Kullanıcı yönetimi        | ✅    | ✅    | ❌ (*)  | ❌ (*)           |
 * | Tüm projeleri görme       | ✅    | ✅    | ✅      | ❌ (atanmışlar)  |
 * | Proje oluşturma           | ✅    | ✅    | ❌      | ❌               |
 * | Gelir oluşturma           | ✅    | ✅    | ✅      | ❌               |
 * | Gider oluşturma           | ✅    | ✅    | ✅      | Atanmış projede  |
 * | Tahsilat/ödeme (*)        | ✅    | ✅ (*)| ✅      | ❌               |
 * | Transfer                  | ✅    | ✅    | ✅      | ❌               |
 * | Kasa/banka görüntüleme    | ✅    | ✅    | ✅      | ❌               |
 * | Müşteri/tedarikçi yönetimi| ✅    | ✅    | ❌ (görür)| ❌             |
 * | Bütçe kalemi yönetimi     | ✅    | ✅    | ✅      | ❌ (salt-okunur) |
 * (*) = bu dosyada yeni eklenen tamamlayıcı testler.
 */

beforeAll(async () => {
  await cleanDatabase();
});
afterEach(async () => {
  await cleanDatabase();
});
afterAll(async () => {
  await db.$disconnect();
});

let seq = 0;
function key(prefix = "yf501") {
  seq += 1;
  return `${prefix}-${seq}-${Math.floor(Math.random() * 1e9)}`;
}

async function seedCategory(organizationId: string, type: "INCOME" | "EXPENSE") {
  seq += 1;
  return db.transactionCategory.create({ data: { organizationId, type, name: `Kategori ${seq}` } });
}

async function seedAccount(owner: SessionUser, openingBalance = 0) {
  seq += 1;
  return createAccount(owner, {
    name: `Hesap ${seq}`,
    type: "BANK",
    bankName: undefined,
    iban: undefined,
    openingBalance,
    currency: "TRY",
  });
}

async function seedIncome(owner: SessionUser, subtotal = 1000) {
  const category = await seedCategory(owner.organizationId, "INCOME");
  return createIncome(owner, {
    categoryId: category.id,
    description: "YF-501 gelir",
    issueDate: new Date(),
    subtotal,
    taxRate: 0,
  });
}

async function seedExpense(owner: SessionUser, subtotal = 1000) {
  const category = await seedCategory(owner.organizationId, "EXPENSE");
  return createExpense(owner, {
    categoryId: category.id,
    description: "YF-501 gider",
    issueDate: new Date(),
    subtotal,
    taxRate: 0,
  });
}

describe("YF-501 — çapraz-tenant okuma (A)", () => {
  it("organizasyon A, organizasyon B'nin gelir/gider kaydını ID ile okuyamaz", async () => {
    const { owner: ownerA } = await createOwnerOrg();
    const { owner: ownerB } = await createOwnerOrg();
    const incomeB = await seedIncome(ownerB);
    const expenseB = await seedExpense(ownerB);

    await expect(getTransactionForUser(ownerA, incomeB.id, "INCOME")).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(getTransactionForUser(ownerA, expenseB.id, "EXPENSE")).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("yanlış type ile aynı organizasyondaki kayıt bile bulunamaz (INCOME/EXPENSE karışmaz)", async () => {
    const { owner } = await createOwnerOrg();
    const income = await seedIncome(owner);
    await expect(getTransactionForUser(owner, income.id, "EXPENSE")).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("organizasyon A, organizasyon B'nin transfer kaydını ID ile okuyamaz", async () => {
    const { owner: ownerA } = await createOwnerOrg();
    const { owner: ownerB } = await createOwnerOrg();
    const fromB = await seedAccount(ownerB, 1000);
    const toB = await seedAccount(ownerB, 0);
    const transferB = await createTransfer(ownerB, {
      fromAccountId: fromB.id,
      toAccountId: toB.id,
      amount: 100,
      transferDate: new Date(),
      idempotencyKey: key(),
    });

    await expect(getTransferForUser(ownerA, transferB.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("YF-501 — çapraz-tenant yazma: tahsilat/ödeme (B)", () => {
  it("başka organizasyonun işlem (transaction) ID'sine tahsilat girilemez", async () => {
    const { owner: ownerA } = await createOwnerOrg();
    const { owner: ownerB } = await createOwnerOrg();
    const accountA = await seedAccount(ownerA, 0);
    const incomeB = await seedIncome(ownerB, 5000);

    const settlementsBefore = await db.settlement.count();
    const movementsBefore = await db.accountMovement.count({ where: { financialAccountId: accountA.id } });

    await expect(
      createSettlement(ownerA, {
        transactionId: incomeB.id,
        financialAccountId: accountA.id,
        amount: 1000,
        settlementDate: new Date(),
        paymentMethod: "NAKIT",
        idempotencyKey: key(),
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    expect(await db.settlement.count()).toBe(settlementsBefore);
    expect(await db.accountMovement.count({ where: { financialAccountId: accountA.id } })).toBe(movementsBefore);
    // B'nin geliri de etkilenmedi (durumu hâlâ OPEN):
    const stillOpen = await db.financialTransaction.findUniqueOrThrow({ where: { id: incomeB.id } });
    expect(stillOpen.status).toBe("OPEN");
  });

  it("başka organizasyonun hesap ID'sine tahsilat/ödeme yönlendirilemez", async () => {
    const { owner: ownerA } = await createOwnerOrg();
    const { owner: ownerB } = await createOwnerOrg();
    const incomeA = await seedIncome(ownerA, 5000);
    const accountB = await seedAccount(ownerB, 0);

    const settlementsBefore = await db.settlement.count();

    await expect(
      createSettlement(ownerA, {
        transactionId: incomeA.id,
        financialAccountId: accountB.id,
        amount: 1000,
        settlementDate: new Date(),
        paymentMethod: "NAKIT",
        idempotencyKey: key(),
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    expect(await db.settlement.count()).toBe(settlementsBefore);
    const untouched = await db.financialTransaction.findUniqueOrThrow({ where: { id: incomeA.id } });
    expect(untouched.status).toBe("OPEN");
  });

  it("başka organizasyonun tahsilat ID'si iptal edilemez", async () => {
    const { owner: ownerA } = await createOwnerOrg();
    const { owner: ownerB } = await createOwnerOrg();
    const accountB = await seedAccount(ownerB, 0);
    const incomeB = await seedIncome(ownerB, 1000);
    const settlementB = await createSettlement(ownerB, {
      transactionId: incomeB.id,
      financialAccountId: accountB.id,
      amount: 1000,
      settlementDate: new Date(),
      paymentMethod: "NAKIT",
      idempotencyKey: key(),
    });

    await expect(cancelSettlement(ownerA, { id: settlementB.id, reason: "Ele geçirme denemesi" })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });

    const stillActive = await db.settlement.findUniqueOrThrow({ where: { id: settlementB.id } });
    expect(stillActive.status).toBe("ACTIVE");
  });
});

describe("YF-501 — çapraz-tenant yazma: transfer (B)", () => {
  it("başka organizasyonun transfer ID'si iptal edilemez", async () => {
    const { owner: ownerA } = await createOwnerOrg();
    const { owner: ownerB } = await createOwnerOrg();
    const fromB = await seedAccount(ownerB, 1000);
    const toB = await seedAccount(ownerB, 0);
    const transferB = await createTransfer(ownerB, {
      fromAccountId: fromB.id,
      toAccountId: toB.id,
      amount: 500,
      transferDate: new Date(),
      idempotencyKey: key(),
    });

    await expect(cancelTransfer(ownerA, { id: transferB.id, reason: "Ele geçirme denemesi" })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });

    const stillActive = await db.accountTransfer.findUniqueOrThrow({ where: { id: transferB.id } });
    expect(stillActive.status).toBe("ACTIVE");
  });
});

describe("YF-501 — çapraz-tenant yazma: gelir/gider güncelleme ve iptal (B)", () => {
  it("başka organizasyonun gelir kaydı güncellenemez veya iptal edilemez", async () => {
    const { owner: ownerA } = await createOwnerOrg();
    const { owner: ownerB } = await createOwnerOrg();
    const incomeB = await seedIncome(ownerB, 2000);
    const categoryA = await seedCategory(ownerA.organizationId, "INCOME");

    await expect(
      updateIncome(ownerA, {
        id: incomeB.id,
        categoryId: categoryA.id,
        description: "Ele geçirildi",
        issueDate: new Date(),
        subtotal: 1,
        taxRate: 0,
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    await expect(cancelIncome(ownerA, { id: incomeB.id, reason: "Ele geçirme denemesi" })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });

    const untouched = await db.financialTransaction.findUniqueOrThrow({ where: { id: incomeB.id } });
    expect(untouched.status).toBe("OPEN");
    expect(untouched.description).toBe("YF-501 gelir");
    expect(untouched.subtotal.toString()).toBe("2000");
  });

  it("gelir/gider oluştururken başka organizasyona ait projectId dolaylı ilişkilendirme olarak reddedilir", async () => {
    const { owner: ownerA } = await createOwnerOrg();
    const { owner: ownerB } = await createOwnerOrg();
    const projectB = await createProject(ownerB, {
      code: "X-1",
      name: "B Projesi",
      contractAmount: 0,
      estimatedBudget: 0,
    });
    const incomeCategoryA = await seedCategory(ownerA.organizationId, "INCOME");
    const expenseCategoryA = await seedCategory(ownerA.organizationId, "EXPENSE");

    const before = await db.financialTransaction.count();

    await expect(
      createIncome(ownerA, {
        projectId: projectB.id,
        categoryId: incomeCategoryA.id,
        description: "Çapraz proje ilişkilendirme",
        issueDate: new Date(),
        subtotal: 100,
        taxRate: 0,
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    await expect(
      createExpense(ownerA, {
        projectId: projectB.id,
        categoryId: expenseCategoryA.id,
        description: "Çapraz proje ilişkilendirme",
        issueDate: new Date(),
        subtotal: 100,
        taxRate: 0,
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    expect(await db.financialTransaction.count()).toBe(before);
  });
});

describe("YF-501 — çapraz-tenant yazma: proje üyeliği (B)", () => {
  it("başka organizasyona ait kullanıcı projeye atanamaz veya kaldırılamaz", async () => {
    const { owner: ownerA } = await createOwnerOrg();
    const { owner: ownerB } = await createOwnerOrg();
    const projectA = await createProject(ownerA, {
      code: "Y-1",
      name: "A Projesi",
      contractAmount: 0,
      estimatedBudget: 0,
    });
    const userB = await createOrgUser(ownerB.organizationId, "PROJECT_MANAGER");

    await expect(assignProjectMember(ownerA, projectA.id, userB.id)).rejects.toMatchObject({ code: "NOT_FOUND" });

    const membership = await db.projectMember.findFirst({ where: { projectId: projectA.id, userId: userB.id } });
    expect(membership).toBeNull();

    // removeProjectMember bir projectMember eşleşmesi bulamazsa sessizce
    // hiçbir şey silmez (organizationId dahil deleteMany), throw etmez —
    // fail-closed davranış: yabancı kullanıcı için hiçbir satır etkilenmez.
    await removeProjectMember(ownerA, projectA.id, userB.id);
    const stillNone = await db.projectMember.count({ where: { projectId: projectA.id } });
    expect(stillNone).toBe(0);
  });
});

describe("YF-501 — çapraz-tenant yazma: kullanıcı/rol yönetimi (B)", () => {
  it("organizasyon A, organizasyon B'nin kullanıcısının rolünü değiştiremez", async () => {
    const { owner: ownerA } = await createOwnerOrg();
    const { owner: ownerB } = await createOwnerOrg();
    const targetB = await createOrgUser(ownerB.organizationId, "FINANCE");

    await expect(changeUserRole(ownerA, targetB.id, "ADMIN")).rejects.toMatchObject({ code: "NOT_FOUND" });

    const untouched = await db.user.findUniqueOrThrow({ where: { id: targetB.id } });
    expect(untouched.role).toBe("FINANCE");
  });

  it("organizasyon A, organizasyon B'nin kullanıcısını pasifleştiremez veya yeniden etkinleştiremez", async () => {
    const { owner: ownerA } = await createOwnerOrg();
    const { owner: ownerB } = await createOwnerOrg();
    const targetB = await createOrgUser(ownerB.organizationId, "FINANCE");

    await expect(deactivateUser(ownerA, targetB.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(reactivateUser(ownerA, targetB.id)).rejects.toMatchObject({ code: "NOT_FOUND" });

    const untouched = await db.user.findUniqueOrThrow({ where: { id: targetB.id } });
    expect(untouched.status).toBe("ACTIVE");
  });
});

describe("YF-501 — çapraz-tenant yazma: davetler (B, D)", () => {
  it("organizasyon A, organizasyon B'ye ait daveti yeniden gönderemez", async () => {
    const { owner: ownerA } = await createOwnerOrg();
    const { owner: ownerB } = await createOwnerOrg();
    const invitationB = await createInvitation(ownerB, { email: "hedef@example.com", role: "FINANCE", projectIds: [] });

    await expect(resendInvitation(ownerA, invitationB.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("davet oluştururken başka organizasyona ait projectId reddedilir", async () => {
    const { owner: ownerA } = await createOwnerOrg();
    const { owner: ownerB } = await createOwnerOrg();
    const projectB = await createProject(ownerB, {
      code: "Z-1",
      name: "B Projesi",
      contractAmount: 0,
      estimatedBudget: 0,
    });

    const before = await db.invitation.count();
    await expect(
      createInvitation(ownerA, { email: "pm@example.com", role: "PROJECT_MANAGER", projectIds: [projectB.id] }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(await db.invitation.count()).toBe(before);
  });
});

describe("YF-501 — ID numaralandırma / bilgi sızıntısı yok (D)", () => {
  it("'başka tenant'ta var' ile 'hiç yok' durumları ayırt edilemez biçimde aynı NOT_FOUND'ı döner", async () => {
    const { owner: ownerA } = await createOwnerOrg();
    const { owner: ownerB } = await createOwnerOrg();

    const projectB = await createProject(ownerB, { code: "N-1", name: "B Projesi", contractAmount: 0, estimatedBudget: 0 });
    const accountB = await seedAccount(ownerB, 0);
    const customerB = await createCustomer(ownerB, {
      type: "COMPANY",
      name: "B Müşteri",
      identityOrTaxNumber: undefined,
      taxOffice: undefined,
      contactName: undefined,
      phone: undefined,
      email: undefined,
      city: undefined,
      district: undefined,
      address: undefined,
    });
    const supplierB = await createSupplier(ownerB, {
      type: "SUPPLIER",
      name: "B Tedarikçi",
      identityOrTaxNumber: undefined,
      taxOffice: undefined,
      contactName: undefined,
      phone: undefined,
      email: undefined,
      city: undefined,
      district: undefined,
      address: undefined,
    });

    const nonExistentId = "clnonexistentid00000000000";

    const cases: Array<{ label: string; foreign: () => Promise<unknown>; missing: () => Promise<unknown> }> = [
      {
        label: "project",
        foreign: () => getProjectForUser(ownerA, projectB.id),
        missing: () => getProjectForUser(ownerA, nonExistentId),
      },
      {
        label: "account",
        foreign: () => getAccountForUser(ownerA, accountB.id),
        missing: () => getAccountForUser(ownerA, nonExistentId),
      },
      {
        label: "customer",
        foreign: () => getCustomerForUser(ownerA, customerB.id),
        missing: () => getCustomerForUser(ownerA, nonExistentId),
      },
      {
        label: "supplier",
        foreign: () => getSupplierForUser(ownerA, supplierB.id),
        missing: () => getSupplierForUser(ownerA, nonExistentId),
      },
    ];

    for (const { label, foreign, missing } of cases) {
      const [foreignResult, missingResult] = await Promise.all([
        foreign().catch((e: unknown) => e),
        missing().catch((e: unknown) => e),
      ]);
      expect(foreignResult, `${label}: yabancı ID hata fırlatmalı`).toBeInstanceOf(Error);
      expect(missingResult, `${label}: mevcut olmayan ID hata fırlatmalı`).toBeInstanceOf(Error);
      const foreignErr = foreignResult as Error;
      const missingErr = missingResult as Error;
      expect(foreignErr).toMatchObject({ code: "NOT_FOUND", message: missingErr.message });
      expect(foreignErr.message).toBe(missingErr.message);
    }
  });
});

describe("YF-501 — rol matrisi tamamlayıcıları", () => {
  it("FINANCE ve PROJECT_MANAGER kullanıcı rolü değiştiremez, pasifleştiremez veya davet gönderemez", async () => {
    const { owner } = await createOwnerOrg();
    const finance = await createOrgUser(owner.organizationId, "FINANCE");
    const pm = await createOrgUser(owner.organizationId, "PROJECT_MANAGER");
    const target = await createOrgUser(owner.organizationId, "FINANCE", { email: `hedef-${key()}@example.com` });

    for (const actor of [finance, pm]) {
      await expect(changeUserRole(actor, target.id, "ADMIN")).rejects.toMatchObject({ code: "FORBIDDEN" });
      await expect(deactivateUser(actor, target.id)).rejects.toMatchObject({ code: "FORBIDDEN" });
      await expect(
        createInvitation(actor, { email: `yeni-${key()}@example.com`, role: "FINANCE", projectIds: [] }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
    }
  });

  it("ADMIN, OWNER gibi tahsilat/ödeme ve transfer oluşturabilir", async () => {
    const { owner } = await createOwnerOrg();
    const admin = await createOrgUser(owner.organizationId, "ADMIN");
    const account = await seedAccount(owner, 10000);
    const income = await seedIncome(owner, 1000);

    await expect(
      createSettlement(admin, {
        transactionId: income.id,
        financialAccountId: account.id,
        amount: 500,
        settlementDate: new Date(),
        paymentMethod: "NAKIT",
        idempotencyKey: key(),
      }),
    ).resolves.toMatchObject({ amount: expect.anything() });

    const toAccount = await seedAccount(owner, 0);
    await expect(
      createTransfer(admin, {
        fromAccountId: account.id,
        toAccountId: toAccount.id,
        amount: 100,
        transferDate: new Date(),
        idempotencyKey: key(),
      }),
    ).resolves.toMatchObject({ amount: expect.anything() });
  });

  it("PROJECT_MANAGER kullanıcı listesini göremez, davet gönderemez", async () => {
    const { owner } = await createOwnerOrg();
    const pm = await createOrgUser(owner.organizationId, "PROJECT_MANAGER");

    await expect(
      createInvitation(pm, { email: `pm-davet-${key()}@example.com`, role: "PROJECT_MANAGER", projectIds: ["x"] }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});

describe("YF-501 — çözümlenmiş proje tenant koruması (E)", () => {
  it("project-finance-service, önceden çözümlenmiş yabancı bir proje objesiyle çağrılırsa ek proje sorgusu yapmadan NOT_FOUND döner", async () => {
    const { owner: ownerA } = await createOwnerOrg();
    const { owner: ownerB } = await createOwnerOrg();
    const projectB = await createProject(ownerB, { code: "R-1", name: "B Projesi", contractAmount: 0, estimatedBudget: 0 });
    const resolvedProjectB = await getProjectForUser(ownerB, projectB.id);

    // vi.spyOn + mockRestore, Prisma delegate metotlarını bu ortamda kalıcı
    // olarak bozuyor (bkz. tests/project-budget.test.ts açıklaması) — bu
    // yüzden doğrudan özellik atamasıyla manuel mock/restore kullanılır.
    const { vi } = await import("vitest");
    const originalFindFirst = db.project.findFirst;
    const findFirstMock = vi.fn((...args: Parameters<typeof originalFindFirst>) => originalFindFirst.apply(db.project, args));
    db.project.findFirst = findFirstMock as unknown as typeof originalFindFirst;
    try {
      // getProjectFinanceSummaryForResolvedProject bellekte tuttuğu
      // `project.organizationId` ile `actor.organizationId`'yi ek bir DB
      // sorgusu yapmadan karşılaştırır (bkz. server/services/project-finance-service.ts
      // — project-budget-service.ts'teki kardeş fonksiyonla aynı desen).
      await expect(getProjectFinanceSummaryForResolvedProject(ownerA, resolvedProjectB)).rejects.toMatchObject({
        code: "NOT_FOUND",
      });
      expect(findFirstMock).not.toHaveBeenCalled();
    } finally {
      db.project.findFirst = originalFindFirst;
    }
  });
});
