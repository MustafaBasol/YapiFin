import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * YF-702-F2 — N+1 regresyon koruması.
 *
 * `getProjectMarginComparison` bu görevin VAROLUŞ NEDENİdir: proje başına
 * servis çağrısı yapan `getProjectFinanceSummary` N proje için ~10N sorgu
 * üretir. Bu dosya, yeni servisin sorgu sayısının proje sayısıyla
 * ÖLÇEKLENMEDİĞİNİ kanıtlar.
 *
 * ## Neden ayrı bir dosya ve neden modül mock'u
 *
 * Sayaç `@/lib/db` modülünün TAMAMINI sarmalar; `vi.mock` dosya kapsamlıdır,
 * bu yüzden finansal doğruluk testleri (tests/project-margin.test.ts) gerçek
 * istemciyle, bu dosya ise sarmalanmış istemciyle çalışır.
 *
 * Alternatif olarak `vi.spyOn(db.project, "findMany")` denendi ve KULLANILAMAZ:
 * Prisma istemcisi ve her model delegate'i birer Proxy'dir; vitest orijinal
 * metodu geri yazdığında proxy çözümlemesinin önüne geçen bir "own property"
 * kalır ve sonraki testler `db.project.findFirst is not a function` /
 * `tx.$queryRaw is not a function` hatasıyla patlar.
 *
 * `$extends({ query: { $allOperations } })` ise Prisma'nın DESTEKLENEN
 * genişletme noktasıdır: model operasyonlarını VE ham SQL çağrılarını
 * (`$queryRaw`) sayar — yani ham SQL ile yazılmış bir döngü de bu korumadan
 * kaçamaz.
 *
 * İddia, sabit bir sayı değil "proje sayısını 6 katına çıkarmak sorgu
 * sayısını DEĞİŞTİRMEZ"dir; bu, N+1'in doğrudan tanımıdır ve servise meşru
 * bir sorgu eklendiğinde kırılgan biçimde bozulmaz.
 */

const { operationLog } = vi.hoisted(() => ({ operationLog: [] as string[] }));

vi.mock("@/lib/db", async () => {
  const { PrismaClient } = await import("@prisma/client");
  const client = new PrismaClient();
  const counted = client.$extends({
    query: {
      async $allOperations({ model, operation, args, query }) {
        operationLog.push(`${model ?? "$raw"}.${operation}`);
        return query(args);
      },
    },
  });
  return { db: counted, __rawClient: client };
});

const { db } = await import("@/lib/db");
const { cleanDatabase, createOwnerOrg, createOrgUser } = await import("./helpers");
const { createIncome, createExpense } = await import("@/server/services/transaction-service");
const { createProject } = await import("@/server/services/project-service");
const { getProjectMarginComparison } = await import("@/server/services/project-margin-service");
type SessionUser = import("@/lib/auth/session").SessionUser;
type TransactionType = import("@prisma/client").TransactionType;

const NOW = new Date("2026-06-15T09:00:00.000Z");
const IN_CURRENT = new Date("2026-06-10T12:00:00.000Z");
const IN_PRIOR = new Date("2026-05-10T12:00:00.000Z");

beforeAll(async () => {
  await cleanDatabase();
});
afterEach(async () => {
  await cleanDatabase();
});
afterAll(async () => {
  // `$extends` ile üretilmiş istemcinin tipi `$disconnect`'i garanti etmez;
  // bağlantı temizliği yine de yapılmalıdır (bkz. mock fabrikası).
  await (db as unknown as { $disconnect?: () => Promise<void> }).$disconnect?.();
});

let seq = 0;

async function seedProject(owner: SessionUser) {
  seq += 1;
  return createProject(owner, {
    code: `QC-${seq}-${Math.floor(Math.random() * 1e6)}`,
    name: `Proje ${seq}`,
    customerId: undefined,
    city: "",
    district: "",
    address: "",
    startDate: undefined,
    plannedEndDate: undefined,
    contractAmount: 0,
    estimatedBudget: 0,
    notes: "",
  });
}

async function seedCategory(owner: SessionUser, type: TransactionType) {
  seq += 1;
  return db.transactionCategory.create({
    data: { organizationId: owner.organizationId, type, name: `Kategori ${seq}` },
  });
}

async function seedProjectWithActivity(owner: SessionUser) {
  const project = await seedProject(owner);
  const incomeCategory = await seedCategory(owner, "INCOME");
  const expenseCategory = await seedCategory(owner, "EXPENSE");
  await createIncome(owner, {
    categoryId: incomeCategory.id,
    projectId: project.id,
    description: "Cari dönem geliri",
    issueDate: IN_CURRENT,
    subtotal: 10000,
    taxRate: 0,
  });
  await createExpense(owner, {
    categoryId: expenseCategory.id,
    projectId: project.id,
    description: "Cari dönem gideri",
    issueDate: IN_CURRENT,
    subtotal: 4000,
    taxRate: 0,
  });
  await createIncome(owner, {
    categoryId: incomeCategory.id,
    projectId: project.id,
    description: "Önceki dönem geliri",
    issueDate: IN_PRIOR,
    subtotal: 8000,
    taxRate: 0,
  });
  return project;
}

/**
 * Yalnızca ölçülen çağrı boyunca yapılan Prisma operasyonlarını döndürür.
 * Servis sorguları `Promise.all` ile PARALEL çalıştığından tamamlanma sırası
 * deterministik DEĞİLDİR; iddia edilen şey sıra değil, operasyon KÜMESİ ve
 * SAYISI olduğu için liste sıralanarak normalize edilir.
 */
async function measure<T>(run: () => Promise<T>): Promise<{ result: T; operations: string[] }> {
  operationLog.length = 0;
  const result = await run();
  return { result, operations: [...operationLog].sort() };
}

describe("YF-702-F2 — performans (N+1 regresyonu)", () => {
  it("sorgu sayısı proje sayısıyla birlikte artmaz", async () => {
    const { owner } = await createOwnerOrg();
    for (let i = 0; i < 2; i += 1) await seedProjectWithActivity(owner);

    const small = await measure(() => getProjectMarginComparison(owner, { period: "CURRENT_MONTH", now: NOW }));
    expect(small.result.rows).toHaveLength(2);
    expect(small.operations.length).toBeGreaterThan(0);

    // Aynı organizasyona 10 proje daha eklenir (toplam 12 = 6 katı).
    for (let i = 0; i < 10; i += 1) await seedProjectWithActivity(owner);

    const large = await measure(() => getProjectMarginComparison(owner, { period: "CURRENT_MONTH", now: NOW }));
    expect(large.result.rows).toHaveLength(12);

    expect(large.operations).toEqual(small.operations);
    // Sabit bütçe: projeler + iki dönem grubu (organizasyon geneli aktör).
    expect(large.operations.length).toBeLessThanOrEqual(4);
  });

  it("organizasyon geneli aktör için sorgu bütçesi 3 operasyondur", async () => {
    const { owner } = await createOwnerOrg();
    await seedProjectWithActivity(owner);

    const { operations } = await measure(() => getProjectMarginComparison(owner, { period: "CURRENT_MONTH", now: NOW }));

    expect(operations).toEqual([
      "FinancialTransaction.groupBy",
      "FinancialTransaction.groupBy",
      "Project.findMany",
    ]);
  });

  it("atanmış projesi olmayan PROJECT_MANAGER için hiç finansal sorgu çalıştırılmaz", async () => {
    const { owner, organizationId } = await createOwnerOrg();
    await seedProjectWithActivity(owner);
    const manager = await createOrgUser(organizationId, "PROJECT_MANAGER");

    const { result, operations } = await measure(() =>
      getProjectMarginComparison(manager, { period: "CURRENT_MONTH", now: NOW }),
    );

    expect(result.rows).toEqual([]);
    // Yalnızca kapsam çözümlemesi; sonrasında kısa devre (fail-closed).
    expect(operations).toEqual(["ProjectMember.findMany"]);
  });
});
