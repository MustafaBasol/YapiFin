import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * YF-705 — Nakit akışı senaryosunun sorgu bütçesi (N+1 regresyon koruması).
 *
 * Dokuz hücre (3 senaryo × 3 ufuk) TEK satır kümesinden bellek içinde
 * türetilir. Naif bir uygulama senaryo/ufuk/tür başına ayrı bir toplam sorgusu
 * çalıştırırdı (3 × 3 × 2 = 18 sorgu) ve proje bazlı bir varyant bunu `18 + N`
 * yapardı. Bu dosya sorgu sayısının NE proje sayısıyla NE de senaryo/ufuk
 * sayısıyla ölçeklenmediğini kanıtlar.
 *
 * Sayaç/`$extends` gerekçesi için bkz. tests/management-summary-query-count.test.ts.
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
const { cleanDatabase, createOwnerOrg, createTestPlan } = await import("./helpers");
const { createIncome, createExpense } = await import("@/server/services/transaction-service");
const { createProject, setProjectStatus } = await import("@/server/services/project-service");
const { createAccount } = await import("@/server/services/account-service");
const { getCashFlowScenarios } = await import("@/server/services/cash-flow-scenario-service");
const { createFakeAiProvider } = await import("@/lib/ai/providers/fake-provider");
const { startOfIstanbulDay, addIstanbulDays } = await import("@/lib/dates");
type SessionUser = import("@/lib/auth/session").SessionUser;
type TransactionType = import("@prisma/client").TransactionType;

const NOW = new Date();
const TODAY_START = startOfIstanbulDay(NOW);
function dueIn(days: number): Date {
  return new Date(addIstanbulDays(TODAY_START, days).getTime() + 6 * 60 * 60 * 1000);
}

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

/** Her ufka düşen vadeleri olan bir proje — dokuz hücrenin tamamı dolsun diye. */
async function seedProjectWithDatedRecords(owner: SessionUser) {
  seq += 1;
  const project = await createProject(owner, {
    code: `CFSQ-${seq}`,
    name: `Sorgu Sayımı Projesi ${seq}`,
    contractAmount: 0,
    estimatedBudget: 100_000,
  });
  await setProjectStatus(owner, project.id, "ACTIVE");

  const incomeCategory = await seedCategory(owner, "INCOME");
  const expenseCategory = await seedCategory(owner, "EXPENSE");

  for (const offset of [-10, 5, 40, 75]) {
    await createIncome(owner, {
      categoryId: incomeCategory.id,
      projectId: project.id,
      description: "Alacak",
      issueDate: NOW,
      dueDate: dueIn(offset),
      subtotal: 10_000,
      taxRate: 0,
    });
    await createExpense(owner, {
      categoryId: expenseCategory.id,
      projectId: project.id,
      description: "Borç",
      issueDate: NOW,
      dueDate: dueIn(offset),
      subtotal: 6_000,
      taxRate: 0,
    });
  }
  return project;
}

async function aiEnabledOrg() {
  const { owner, organizationId } = await createOwnerOrg();
  const plan = await createTestPlan({
    limits: { "ai.monthly_quota": 10_000, "projects.active": null },
    capabilities: { "ai.features": true },
  });
  await db.organization.update({ where: { id: organizationId }, data: { planId: plan.id } });
  seq += 1;
  await createAccount(owner, {
    name: `Hesap ${seq}`,
    type: "BANK",
    bankName: undefined,
    iban: undefined,
    openingBalance: 500_000,
    currency: "TRY",
  });
  return owner;
}

/** Sağlayıcı çağrısı sorgu üretmez ama kota defteri yazar. */
const PROVIDER = createFakeAiProvider({ response: "geçersiz json — yedek yola düşer, olgular değişmez" });

async function countQueries(owner: SessionUser): Promise<number> {
  operationLog.length = 0;
  await getCashFlowScenarios(owner, { provider: PROVIDER, now: NOW });
  return operationLog.length;
}

describe("YF-705 — sorgu bütçesi", () => {
  it("sorgu sayısı proje sayısıyla ÖLÇEKLENMEZ", async () => {
    const ownerA = await aiEnabledOrg();
    await seedProjectWithDatedRecords(ownerA);
    const withOneProject = await countQueries(ownerA);

    const ownerB = await aiEnabledOrg();
    for (let i = 0; i < 8; i += 1) {
      await seedProjectWithDatedRecords(ownerB);
    }
    const withEightProjects = await countQueries(ownerB);

    expect(withEightProjects).toBeLessThanOrEqual(withOneProject + 2);
  });

  it("mutlak sorgu bütçesi dar bir tavanın ALTINDA kalır", async () => {
    const owner = await aiEnabledOrg();
    await seedProjectWithDatedRecords(owner);
    const total = await countQueries(owner);

    // Beklenen kaynaklar: yetki kontrolü, kapsam çözümlemesi, vadeli satır
    // sorgusu, vadesiz kapsam sorgusu, açılış bakiyesi, kredi kartı sayımı ve
    // YF-711 kota defteri işlemleri (rezervasyon/commit, serializable
    // transaction adımları dahil). Ölçülen değer bu kurguda 21'dir.
    //
    // Dokuz hücrenin tamamı TEK satır kümesinden bellek içinde türetilir —
    // hücre başına sorgu YOKTUR. Tavan, hücre başına sorgu ekleyen bir
    // regresyonu (en az +9, naif yaklaşımda +18) kesin olarak yakalayacak
    // kadar dardır.
    expect(total).toBeLessThan(26);
  });
});
