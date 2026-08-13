import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * YF-702-F7 — Kapsam çözümlemesinin sorgu maliyeti.
 *
 * `resolveActorReportScope` üç rapor servisinin (dashboard, bütçe, nakit
 * akışı) ORTAK kapsam girişidir. Bu dosya, kapsamın tek noktada çözülmesinin
 * ölçülebilir sözleşmesini korur:
 *
 *   - organizasyon geneli roller hiç üyelik sorgusu ÇALIŞTIRMAZ,
 *   - PROJECT_MANAGER için üyelik sorgusu TAM OLARAK BİR kez çalışır (eski
 *     yapıda dispatcher + dal aynı sorguyu tekrarlayabiliyordu),
 *   - proje filtresi yalnızca BİR doğrulama sorgusu ekler,
 *   - atanmış proje sayısı arttığında kapsam çözümlemesi ölçeklenmez.
 *
 * Mekanik olarak tests/project-margin-query-count.test.ts ile aynıdır: sayaç
 * `@/lib/db` modülünün TAMAMINI sarmalar, `vi.mock` dosya kapsamlı olduğundan
 * finansal doğruluk testleri (tests/dashboard.test.ts vb.) gerçek istemciyle,
 * bu dosya sarmalanmış istemciyle çalışır. `$extends({ query: {
 * $allOperations } })` Prisma'nın DESTEKLENEN genişletme noktasıdır ve model
 * operasyonlarını VE ham SQL çağrılarını sayar.
 *
 * İddialar tüm operasyon listesine değil, YALNIZCA ilgilenilen operasyona
 * (`ProjectMember.findMany`, `Project.findFirst`) süzülerek yapılır: bu
 * servisler çok sayıda ham SQL sorgusu (`$raw.$queryRaw`) da çalıştırır ve
 * onlara meşru bir sorgu eklenmesi bu korumayı kırılgan biçimde bozmamalıdır.
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
const { createProject, assignProjectMember } = await import("@/server/services/project-service");
const { getDashboardData } = await import("@/server/services/dashboard-service");
const { getBudgetReport } = await import("@/server/services/budget-report-service");
const { getCashFlowReport } = await import("@/server/services/cash-flow-report-service");
type SessionUser = import("@/lib/auth/session").SessionUser;

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

const DASHBOARD_FILTER = { period: "LAST_12_MONTHS" as const, projectId: undefined };
const BUDGET_FILTER = { projectId: undefined, categoryId: undefined };
const CASH_FLOW_FILTER = {
  range: "NEXT_30_DAYS" as const,
  scenario: "ON_DUE_DATE" as const,
  projectId: undefined,
  startDate: undefined,
  endDate: undefined,
};

let seq = 0;

async function seedProject(owner: SessionUser) {
  seq += 1;
  return createProject(owner, {
    code: `RQ-${seq}-${Math.floor(Math.random() * 1e6)}`,
    name: `Proje ${seq}`,
    contractAmount: 0,
    estimatedBudget: 0,
  });
}

/**
 * Yalnızca ölçülen çağrı boyunca yapılan Prisma operasyonlarını döndürür.
 * Servis sorguları `Promise.all` ile PARALEL çalıştığından tamamlanma sırası
 * deterministik DEĞİLDİR; iddia edilen şey sıra değil, operasyon SAYISI olduğu
 * için liste sıralanarak normalize edilir.
 */
async function measure<T>(run: () => Promise<T>): Promise<{ result: T; operations: string[] }> {
  operationLog.length = 0;
  const result = await run();
  return { result, operations: [...operationLog].sort() };
}

function membershipQueries(operations: string[]) {
  return operations.filter((op) => op === "ProjectMember.findMany");
}

function projectFilterQueries(operations: string[]) {
  return operations.filter((op) => op === "Project.findFirst");
}

describe("YF-702-F7 — kapsam çözümleme sorgu sayısı", () => {
  it("organizasyon geneli aktör için hiç üyelik sorgusu çalıştırılmaz", async () => {
    const { owner } = await createOwnerOrg();
    await seedProject(owner);

    const dashboard = await measure(() => getDashboardData(owner, DASHBOARD_FILTER));
    const budget = await measure(() => getBudgetReport(owner, BUDGET_FILTER));
    const cashFlow = await measure(() => getCashFlowReport(owner, CASH_FLOW_FILTER));

    expect(dashboard.result.scope).toBe("ORGANIZATION");
    expect(budget.result.scope).toBe("ORGANIZATION");
    expect(cashFlow.result.scope).toBe("ORGANIZATION");
    expect(membershipQueries(dashboard.operations)).toHaveLength(0);
    expect(membershipQueries(budget.operations)).toHaveLength(0);
    expect(membershipQueries(cashFlow.operations)).toHaveLength(0);
  });

  it("PROJECT_MANAGER için tam olarak bir üyelik sorgusu çalıştırılır (çift sorgu yok)", async () => {
    const { owner, organizationId } = await createOwnerOrg();
    const manager = await createOrgUser(organizationId, "PROJECT_MANAGER");
    const project = await seedProject(owner);
    await assignProjectMember(owner, project.id, manager.id);

    const dashboard = await measure(() => getDashboardData(manager, DASHBOARD_FILTER));
    const budget = await measure(() => getBudgetReport(manager, BUDGET_FILTER));
    const cashFlow = await measure(() => getCashFlowReport(manager, CASH_FLOW_FILTER));

    expect(dashboard.result.scope).toBe("PROJECT_MANAGER");
    expect(budget.result.scope).toBe("PROJECT_MANAGER");
    expect(cashFlow.result.scope).toBe("PROJECT_MANAGER");
    expect(membershipQueries(dashboard.operations)).toHaveLength(1);
    expect(membershipQueries(budget.operations)).toHaveLength(1);
    expect(membershipQueries(cashFlow.operations)).toHaveLength(1);
  });

  it("explicit projectId verildiğinde tam olarak bir proje doğrulama sorgusu çalışır", async () => {
    const { owner, organizationId } = await createOwnerOrg();
    const manager = await createOrgUser(organizationId, "PROJECT_MANAGER");
    const project = await seedProject(owner);
    await assignProjectMember(owner, project.id, manager.id);

    const withoutFilter = await measure(() => getDashboardData(owner, DASHBOARD_FILTER));
    expect(projectFilterQueries(withoutFilter.operations)).toHaveLength(0);

    const dashboard = await measure(() => getDashboardData(owner, { ...DASHBOARD_FILTER, projectId: project.id }));
    const budget = await measure(() => getBudgetReport(owner, { ...BUDGET_FILTER, projectId: project.id }));
    const cashFlow = await measure(() => getCashFlowReport(owner, { ...CASH_FLOW_FILTER, projectId: project.id }));

    expect(projectFilterQueries(dashboard.operations)).toHaveLength(1);
    expect(projectFilterQueries(budget.operations)).toHaveLength(1);
    expect(projectFilterQueries(cashFlow.operations)).toHaveLength(1);

    // PROJECT_MANAGER dalında da doğrulama tek sorgudur; üyelik sorgusu buna
    // eklenir, onun yerine geçmez.
    const managerDashboard = await measure(() =>
      getDashboardData(manager, { ...DASHBOARD_FILTER, projectId: project.id }),
    );
    expect(projectFilterQueries(managerDashboard.operations)).toHaveLength(1);
    expect(membershipQueries(managerDashboard.operations)).toHaveLength(1);
  });

  it("atanmış proje sayısı artınca kapsam çözümleme sorgu sayısı ARTMAZ (N+1 yok)", async () => {
    const { owner, organizationId } = await createOwnerOrg();
    const manager = await createOrgUser(organizationId, "PROJECT_MANAGER");
    const first = await seedProject(owner);
    await assignProjectMember(owner, first.id, manager.id);

    const smallDashboard = await measure(() => getDashboardData(manager, DASHBOARD_FILTER));
    const smallBudget = await measure(() => getBudgetReport(manager, BUDGET_FILTER));
    const smallCashFlow = await measure(() => getCashFlowReport(manager, CASH_FLOW_FILTER));

    for (let i = 0; i < 5; i += 1) {
      const project = await seedProject(owner);
      await assignProjectMember(owner, project.id, manager.id);
    }

    const largeDashboard = await measure(() => getDashboardData(manager, DASHBOARD_FILTER));
    const largeBudget = await measure(() => getBudgetReport(manager, BUDGET_FILTER));
    const largeCashFlow = await measure(() => getCashFlowReport(manager, CASH_FLOW_FILTER));

    if (largeDashboard.result.scope !== "PROJECT_MANAGER") throw new Error("beklenmeyen kapsam");
    expect(largeDashboard.result.kpis.totalProjectCount).toBe(6);

    expect(membershipQueries(largeDashboard.operations)).toHaveLength(membershipQueries(smallDashboard.operations).length);
    expect(membershipQueries(largeBudget.operations)).toHaveLength(membershipQueries(smallBudget.operations).length);
    expect(membershipQueries(largeCashFlow.operations)).toHaveLength(membershipQueries(smallCashFlow.operations).length);
    expect(membershipQueries(largeDashboard.operations)).toHaveLength(1);
    expect(membershipQueries(largeBudget.operations)).toHaveLength(1);
    expect(membershipQueries(largeCashFlow.operations)).toHaveLength(1);
  });
});
