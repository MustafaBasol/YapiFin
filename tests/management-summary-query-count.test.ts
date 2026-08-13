import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * YF-704 — Yönetim özetinin sorgu bütçesi (N+1 regresyon koruması).
 *
 * Özet, kapsamdaki TÜM projelerin haftalık gelir/gider karşılaştırmasını
 * içerir. Naif bir uygulama bunu proje başına `getProjectFinanceSummary`
 * çağırarak yapardı (~10N sorgu). Bu dosya, olgu paketinin sorgu sayısının
 * PROJE SAYISIYLA ÖLÇEKLENMEDİĞİNİ kanıtlar.
 *
 * Sayaç/`$extends` gerekçesi için bkz. tests/ai-insights-query-count.test.ts
 * ve tests/project-margin-query-count.test.ts — aynı desen.
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
const { getWeeklySummaryRanges } = await import("@/server/services/dashboard-service");
const { getManagementSummary } = await import("@/server/services/management-summary-service");
const { createFakeAiProvider } = await import("@/lib/ai/providers/fake-provider");
type SessionUser = import("@/lib/auth/session").SessionUser;
type TransactionType = import("@prisma/client").TransactionType;

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = new Date();
const RANGES = getWeeklySummaryRanges(NOW);
const IN_CURRENT = new Date(RANGES.current.start.getTime() + DAY_MS);
const IN_PREVIOUS = new Date(RANGES.previous.start.getTime() + DAY_MS);

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

/** Her iki dönemde de hareketi olan, bütçesi aşılan bir proje — kurallar sinyal üretsin diye. */
async function seedProjectWithMovement(owner: SessionUser) {
  seq += 1;
  const project = await createProject(owner, {
    code: `MSQ-${seq}`,
    name: `Sorgu Sayımı Projesi ${seq}`,
    contractAmount: 0,
    estimatedBudget: 10_000,
  });
  await setProjectStatus(owner, project.id, "ACTIVE");

  const incomeCategory = await seedCategory(owner, "INCOME");
  const expenseCategory = await seedCategory(owner, "EXPENSE");

  for (const [issueDate, revenue, expense] of [
    [IN_CURRENT, 40_000, 30_000],
    [IN_PREVIOUS, 50_000, 20_000],
  ] as const) {
    await createIncome(owner, {
      categoryId: incomeCategory.id,
      projectId: project.id,
      description: "Gelir",
      issueDate,
      subtotal: revenue,
      taxRate: 0,
    });
    await createExpense(owner, {
      categoryId: expenseCategory.id,
      projectId: project.id,
      description: "Gider",
      issueDate,
      subtotal: expense,
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
  return owner;
}

/** Sağlayıcı çağrısı sorgu üretmez ama kota defteri yazar; sayım yalnızca OLGU toplama aşamasını ölçer. */
const PROVIDER = createFakeAiProvider({ response: "geçersiz json — yedek yola düşer, olgular değişmez" });

async function countQueriesForSummary(owner: SessionUser): Promise<number> {
  operationLog.length = 0;
  await getManagementSummary(owner, { provider: PROVIDER, now: NOW });
  return operationLog.length;
}

describe("YF-704 — sorgu bütçesi", () => {
  it("sorgu sayısı proje sayısıyla ÖLÇEKLENMEZ", async () => {
    const ownerA = await aiEnabledOrg();
    await seedProjectWithMovement(ownerA);
    const withOneProject = await countQueriesForSummary(ownerA);

    const ownerB = await aiEnabledOrg();
    for (let i = 0; i < 6; i += 1) {
      await seedProjectWithMovement(ownerB);
    }
    const withSixProjects = await countQueriesForSummary(ownerB);

    // Proje sayısı 6 katına çıkarken sorgu sayısı SABİT kalmalıdır. Küçük bir
    // tolerans bırakılır (kota defteri yazımları kural motoruna değil, YF-711
    // rezervasyon akışına aittir ve proje sayısından bağımsızdır).
    expect(withSixProjects).toBeLessThanOrEqual(withOneProject + 2);
  });

  it("mutlak sorgu bütçesi bir tavanın ALTINDA kalır (yeni sorgu kaynağı tripwire'ı)", async () => {
    const owner = await aiEnabledOrg();
    await seedProjectWithMovement(owner);
    const total = await countQueriesForSummary(owner);
    // Toplam, ezici çoğunlukla NAKİT AKIŞI raporuna aittir (vade listeleri,
    // kova toplamları, aylık projeksiyon), ayrıca bütçe raporu, 2 settlement
    // toplamı, 3 marj sorgusu, yetki kontrolü ve YF-711 kota defteri
    // işlemleri sayılır. Ölçülen değer bu kurguda ~56'dır; tavan, gerçek bir
    // regresyonu (yeni ve beklenmeyen bir sorgu kaynağı) yakalayacak kadar
    // dar, gürültüye takılmayacak kadar geniş seçilmiştir. Asıl N+1
    // değişmezi yukarıdaki ÖLÇEKLENME testidir.
    expect(total).toBeLessThan(70);
  });
});
