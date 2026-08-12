import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * YF-702-F3 — İçgörü katmanının sorgu bütçesi (N+1 regresyon koruması).
 *
 * `PROJECT_MARGIN_DETERIORATION` kuralı proje BAŞINA bir olgu üretir; naif bir
 * uygulama bunu kural gövdesinden `getProjectFinanceSummary` çağırarak
 * yapardı ve N proje için ~10N sorguya yol açardı. Bu dosya iki değişmezi
 * birlikte kanıtlar:
 *
 * 1. `extractFinancialSignals` sorgu sayısı PROJE SAYISIYLA ÖLÇEKLENMEZ.
 * 2. Kural motoru (`server/services/ai-insights-rules.ts`) hiçbir Prisma
 *    sorgusu çalıştırmaz — tüm sorgular kanonik servis çağrılarına aittir ve
 *    sinyal üretilse de üretilmese de aynı kalır.
 *
 * Sayaç/mock gerekçesi ve `$extends` seçimi için bkz.
 * tests/project-margin-query-count.test.ts modül başlığı — aynı desen.
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
const { cleanDatabase, createOwnerOrg } = await import("./helpers");
const { createIncome, createExpense } = await import("@/server/services/transaction-service");
const { createProject } = await import("@/server/services/project-service");
const { extractFinancialSignals } = await import("@/server/services/ai-insights-service");
type SessionUser = import("@/lib/auth/session").SessionUser;
type TransactionType = import("@prisma/client").TransactionType;

const DAY_MS = 24 * 60 * 60 * 1000;
const { getPriorDateRange } = await import("@/server/services/dashboard-service");
/** Cari dönem içinde kesin olan an. */
const IN_CURRENT = new Date();
/** Önceki eşdeğer dönemin 2. günü — testin çalıştığı takvim ayından bağımsız. */
const IN_PRIOR = new Date(getPriorDateRange("CURRENT_MONTH", IN_CURRENT).start.getTime() + DAY_MS);

beforeAll(async () => {
  await cleanDatabase();
});
afterEach(async () => {
  await cleanDatabase();
});
afterAll(async () => {
  await (db as unknown as { $disconnect?: () => Promise<void> }).$disconnect?.();
});

let seq = 0;

async function seedCategory(owner: SessionUser, type: TransactionType) {
  seq += 1;
  return db.transactionCategory.create({
    data: { organizationId: owner.organizationId, type, name: `Kategori ${seq}` },
  });
}

/** Marjı %40'tan %15'e düşen bir proje — kural her seferinde sinyal üretir. */
async function seedDeterioratingProject(owner: SessionUser) {
  seq += 1;
  const project = await createProject(owner, {
    code: `AIQC-${seq}-${Math.floor(Math.random() * 1e6)}`,
    name: `Proje ${seq}`,
    contractAmount: 0,
    estimatedBudget: 0,
  });
  const incomeCategory = await seedCategory(owner, "INCOME");
  const expenseCategory = await seedCategory(owner, "EXPENSE");
  for (const [issueDate, expense] of [
    [IN_PRIOR, 60_000],
    [IN_CURRENT, 85_000],
  ] as const) {
    await createIncome(owner, {
      categoryId: incomeCategory.id,
      projectId: project.id,
      description: "Dönem geliri",
      issueDate,
      subtotal: 100_000,
      taxRate: 0,
    });
    await createExpense(owner, {
      categoryId: expenseCategory.id,
      projectId: project.id,
      description: "Dönem gideri",
      issueDate,
      subtotal: expense,
      taxRate: 0,
    });
  }
  return project;
}

async function measure<T>(run: () => Promise<T>): Promise<{ result: T; operations: string[] }> {
  operationLog.length = 0;
  const result = await run();
  return { result, operations: [...operationLog].sort() };
}

describe("YF-702-F3 — içgörü katmanı sorgu bütçesi", () => {
  it("sinyal üreten proje sayısı artınca sorgu sayısı DEĞİŞMEZ", async () => {
    const { owner } = await createOwnerOrg();
    for (let i = 0; i < 2; i += 1) await seedDeterioratingProject(owner);

    const small = await measure(() => extractFinancialSignals(owner));
    expect(small.result.filter((s) => s.type === "PROJECT_MARGIN_DETERIORATION")).toHaveLength(2);
    expect(small.operations.length).toBeGreaterThan(0);

    // 5 kat daha fazla sinyal üreten proje.
    for (let i = 0; i < 8; i += 1) await seedDeterioratingProject(owner);

    const large = await measure(() => extractFinancialSignals(owner));
    // Üst sınır (maxProjectMarginSignals) uygulanır; sorgu sayısı yine de sabittir.
    expect(large.result.filter((s) => s.type === "PROJECT_MARGIN_DETERIORATION")).toHaveLength(5);
    expect(large.operations).toEqual(small.operations);
  });

  it("marj karşılaştırması sabit sayıda ek operasyon getirir (proje başına sorgu yok)", async () => {
    const { owner } = await createOwnerOrg();
    await seedDeterioratingProject(owner);

    const { operations } = await measure(() => extractFinancialSignals(owner));

    // F2 servisinin payı: projeler + iki dönem grubu.
    expect(operations.filter((op) => op === "Project.findMany").length).toBeGreaterThanOrEqual(1);
    expect(operations.filter((op) => op === "FinancialTransaction.groupBy").length).toBeGreaterThanOrEqual(2);
  });
});
