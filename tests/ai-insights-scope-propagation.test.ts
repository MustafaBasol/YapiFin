import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * YF-702-F8 — Önceden çözülmüş kapsamın servisler arası taşınması.
 *
 * `extractFinancialSignals` dört kanonik tüketici çağırır (bütçe, nakit akışı,
 * gerçekleşen tahsilat/ödeme toplamları, proje marj karşılaştırması). F8
 * öncesinde bu dördü kapsamı BAĞIMSIZ olarak çözüyordu; bir PROJECT_MANAGER
 * için aynı `ProjectMember.findMany` sorgusu TEK istekte 4 kez çalışıyordu. Bu
 * dosya F8'in üç ayrı sözleşmesini birlikte sabitler:
 *
 *   1. **Sorgu maliyeti** — organizasyon geneli roller (OWNER/ADMIN/FINANCE)
 *      için 0 üyelik sorgusu; PROJECT_MANAGER için TAM OLARAK 1 ve bu sayı
 *      atanmış proje sayısıyla ÖLÇEKLENMEZ.
 *   2. **Finansal denklik** — kapsamı taşıyan iç yol (`*WithScope`) ile kapsamı
 *      kendisi çözen genel yol (`getBudgetReport` vb.) BİREBİR aynı sonucu
 *      üretir. Optimizasyon hiçbir tutarı, satırı veya DTO alanını
 *      değiştirmemelidir.
 *   3. **Güvenlik** — taşınan kapsam güvenilen bir yetki durumudur;
 *      `assertResolvedScopeForActor` kapsamın kanonik çözümleyiciden geldiğini
 *      ve bu aktöre/bu filtreye ait olduğunu KANITLAR. Elle kurulmuş bir nesne,
 *      başka aktörün kapsamı, başka filtrenin kapsamı veya role uymayan bir dal
 *      REDDEDİLİR (fail-closed). Ayrıca kapsam yok = organizasyon geneli
 *      DEĞİLDİR ve başka organizasyondaki üyelik kaydı kapsamı GENİŞLETMEZ.
 *
 * Sayaç/mock mekaniği tests/report-scope-query-count.test.ts ile AYNIdır ve
 * oradan kopyalanmıştır: `vi.mock` dosya kapsamlı ve hoisted olduğundan ortak
 * bir yardımcıya çıkarılamaz. `$extends({ query: { $allOperations } })`
 * Prisma'nın DESTEKLENEN genişletme noktasıdır; model operasyonlarını VE ham
 * SQL çağrılarını sayar. İddialar tüm operasyon listesine değil, YALNIZCA
 * ilgilenilen operasyona (`ProjectMember.findMany`, `Project.findFirst`)
 * süzülerek yapılır — bu servisler çok sayıda ham SQL sorgusu da çalıştırır ve
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
const { createProject, assignProjectMember, setProjectStatus } = await import("@/server/services/project-service");
const { createIncome, createExpense } = await import("@/server/services/transaction-service");
const { createAccount } = await import("@/server/services/account-service");
const { createSettlement } = await import("@/server/services/settlement-service");
const { getDateRange, getSettlementTotalsForRange, resolveActorReportScope } = await import(
  "@/server/services/dashboard-service"
);
const { getBudgetReport, getBudgetReportWithScope } = await import("@/server/services/budget-report-service");
const { getCashFlowReport, getCashFlowReportWithScope } = await import("@/server/services/cash-flow-report-service");
const { getProjectMarginComparison, getProjectMarginComparisonWithScope } = await import(
  "@/server/services/project-margin-service"
);
const { runInsightRules } = await import("@/server/services/ai-insights-rules");
const { extractFinancialSignals } = await import("@/server/services/ai-insights-service");
const { DEFAULT_INSIGHT_THRESHOLDS } = await import("@/lib/ai/insights/thresholds");
type SessionUser = import("@/lib/auth/session").SessionUser;
type ActorReportScope = import("@/server/services/dashboard-service").ActorReportScope;
type TransactionType = import("@prisma/client").TransactionType;

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

const BUDGET_FILTER = { projectId: undefined, categoryId: undefined };
const CASH_FLOW_FILTER = {
  range: "NEXT_30_DAYS" as const,
  scenario: "ON_DUE_DATE" as const,
  projectId: undefined,
  startDate: undefined,
  endDate: undefined,
};

/**
 * Tüm dosya boyunca SABİT "şimdi". Tohumlanan kayıtlar da bu anı kullanır;
 * böylece dönem sınırına (ay başı/sonu) denk gelen bir çalıştırma testleri
 * kırılgan hâle getirmez ve marj karşılaştırmasının iki çağrısı ASLA farklı
 * dönemlere düşemez.
 */
const FIXED_NOW = new Date();

let seq = 0;
function key(prefix: string) {
  seq += 1;
  return `${prefix}-${seq}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
}

async function seedCategory(owner: SessionUser, type: TransactionType) {
  seq += 1;
  return db.transactionCategory.create({
    data: { organizationId: owner.organizationId, type, name: `Kategori ${seq}` },
  });
}

async function seedProject(owner: SessionUser, estimatedBudget = 0) {
  seq += 1;
  const project = await createProject(owner, {
    code: `F8-${seq}-${Math.floor(Math.random() * 1e6)}`,
    name: `Proje ${seq}`,
    contractAmount: 0,
    estimatedBudget,
  });
  await setProjectStatus(owner, project.id, "ACTIVE");
  return project;
}

/**
 * Bütçesini aşan, geliri ve gideri olan bir proje — hem `BUDGET_OVERRUN`
 * sinyali hem de marj/nakit akışı satırları üretir.
 */
async function seedOverBudgetProject(owner: SessionUser, opts: { budget: number; income: number; expense: number }) {
  const project = await seedProject(owner, opts.budget);
  const incomeCategory = await seedCategory(owner, "INCOME");
  const expenseCategory = await seedCategory(owner, "EXPENSE");
  await createIncome(owner, {
    categoryId: incomeCategory.id,
    projectId: project.id,
    description: "Proje geliri",
    issueDate: FIXED_NOW,
    subtotal: opts.income,
    taxRate: 0,
  });
  await createExpense(owner, {
    categoryId: expenseCategory.id,
    projectId: project.id,
    description: "Proje gideri",
    issueDate: FIXED_NOW,
    subtotal: opts.expense,
    taxRate: 0,
  });
  return project;
}

/** Gerçekleşen (settlement) tahsilat/ödeme — tahsilat/ödeme dengesizliği sinyalinin girdisi. */
async function seedRealizedPayment(owner: SessionUser, opts: { amount: number; projectId?: string }) {
  seq += 1;
  const account = await createAccount(owner, {
    name: `Hesap ${seq}`,
    type: "BANK",
    bankName: undefined,
    iban: undefined,
    openingBalance: 1_000_000,
    currency: "TRY",
  });
  const category = await seedCategory(owner, "EXPENSE");
  const expense = await createExpense(owner, {
    categoryId: category.id,
    projectId: opts.projectId,
    description: "Ödenen gider",
    issueDate: FIXED_NOW,
    subtotal: opts.amount,
    taxRate: 0,
  });
  await createSettlement(owner, {
    transactionId: expense.id,
    financialAccountId: account.id,
    amount: opts.amount,
    settlementDate: FIXED_NOW,
    paymentMethod: "HAVALE_EFT",
    idempotencyKey: key("settle"),
  });
  return expense;
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

describe("YF-702-F8 — kapsam çözümlemesi istek başına tek kez", () => {
  it("OWNER için hiç üyelik ve hiç proje doğrulama sorgusu çalıştırılmaz", async () => {
    const { owner } = await createOwnerOrg();
    await seedOverBudgetProject(owner, { budget: 1_000, income: 5_000, expense: 4_000 });

    const { operations } = await measure(() => extractFinancialSignals(owner));

    expect(membershipQueries(operations)).toHaveLength(0);
    expect(projectFilterQueries(operations)).toHaveLength(0);
  });

  it("ADMIN için hiç üyelik ve hiç proje doğrulama sorgusu çalıştırılmaz", async () => {
    const { owner, organizationId } = await createOwnerOrg();
    const admin = await createOrgUser(organizationId, "ADMIN");
    await seedOverBudgetProject(owner, { budget: 1_000, income: 5_000, expense: 4_000 });

    const { operations } = await measure(() => extractFinancialSignals(admin));

    expect(membershipQueries(operations)).toHaveLength(0);
    expect(projectFilterQueries(operations)).toHaveLength(0);
  });

  it("FINANCE için hiç üyelik ve hiç proje doğrulama sorgusu çalıştırılmaz", async () => {
    const { owner, organizationId } = await createOwnerOrg();
    const finance = await createOrgUser(organizationId, "FINANCE");
    await seedOverBudgetProject(owner, { budget: 1_000, income: 5_000, expense: 4_000 });

    const { operations } = await measure(() => extractFinancialSignals(finance));

    expect(membershipQueries(operations)).toHaveLength(0);
    expect(projectFilterQueries(operations)).toHaveLength(0);
  });

  it("PROJECT_MANAGER için üyelik sorgusu TAM OLARAK bir kez çalışır (F8 öncesi 4'tü)", async () => {
    const { owner, organizationId } = await createOwnerOrg();
    const pm = await createOrgUser(organizationId, "PROJECT_MANAGER");
    const assigned = await seedOverBudgetProject(owner, { budget: 1_000, income: 5_000, expense: 4_000 });
    const unassigned = await seedOverBudgetProject(owner, { budget: 1_000, income: 9_000, expense: 8_000 });
    await assignProjectMember(owner, assigned.id, pm.id);

    const { result: signals, operations } = await measure(() => extractFinancialSignals(pm));

    expect(membershipQueries(operations)).toHaveLength(1);
    expect(projectFilterQueries(operations)).toHaveLength(0);

    // Kapsam doğru daraltılmış olmalı: yalnızca atanmış projenin sinyalleri.
    expect(signals.some((s) => s.affectedProjectId === assigned.id)).toBe(true);
    expect(signals.some((s) => s.affectedProjectId === unassigned.id)).toBe(false);
  });

  it("atanmış proje sayısı 1'den 6'ya çıkınca üyelik sorgu sayısı DEĞİŞMEZ", async () => {
    const { owner, organizationId } = await createOwnerOrg();
    const pm = await createOrgUser(organizationId, "PROJECT_MANAGER");
    const first = await seedOverBudgetProject(owner, { budget: 1_000, income: 5_000, expense: 4_000 });
    await assignProjectMember(owner, first.id, pm.id);

    const small = await measure(() => extractFinancialSignals(pm));

    for (let i = 0; i < 5; i += 1) {
      const extra = await seedOverBudgetProject(owner, { budget: 1_000, income: 5_000, expense: 4_000 });
      await assignProjectMember(owner, extra.id, pm.id);
    }

    const large = await measure(() => extractFinancialSignals(pm));

    // Aynı testte karşılaştırılır: proje sayısıyla ölçeklenmediği ancak iki
    // ölçüm birlikte iddia edilerek kanıtlanabilir.
    expect(membershipQueries(large.operations)).toHaveLength(membershipQueries(small.operations).length);
    expect(membershipQueries(large.operations)).toHaveLength(1);
    expect(membershipQueries(small.operations)).toHaveLength(1);
  });
});

describe("YF-702-F8 — fail-closed kapsam", () => {
  it("atanmış projesi olmayan PROJECT_MANAGER organizasyon geneline DÜŞMEZ (tek üyelik sorgusu)", async () => {
    const { owner, organizationId } = await createOwnerOrg();
    const pm = await createOrgUser(organizationId, "PROJECT_MANAGER");
    // PM'in ATANMADIĞI, veri dolu bir proje: sızıntı olsaydı rakamları görünürdü.
    const foreign = await seedOverBudgetProject(owner, { budget: 10_000, income: 250_000, expense: 180_000 });
    await seedRealizedPayment(owner, { amount: 120_000, projectId: foreign.id });

    const { result: signals, operations } = await measure(() => extractFinancialSignals(pm));

    expect(membershipQueries(operations)).toHaveLength(1);
    expect(signals).toEqual([]);

    const scope = await resolveActorReportScope(pm, undefined);
    // Kritik değişmez: BOŞ DİZİ, `undefined` (= tüm organizasyon) DEĞİLDİR.
    expect(scope.assignedProjectIds).toEqual([]);
    expect(scope.assignedProjectIds).not.toBeUndefined();

    const budget = await getBudgetReportWithScope(pm, BUDGET_FILTER, scope);
    expect(budget.scope).toBe("PROJECT_MANAGER");
    expect(budget.projectComparison).toEqual([]);
    expect(budget.overBudgetProjects).toEqual([]);
    expect(budget.metrics.totalRealizedExpenses).toBe("0");
    expect(budget.metrics.totalProjectBudget).toBe("0");

    const margin = await getProjectMarginComparisonWithScope(pm, { now: FIXED_NOW }, scope);
    expect(margin.rows).toEqual([]);

    // Tahsilat/ödeme toplamları da sıfırdır — `getRealizedSettlementTotals`
    // tam olarak bu alanı (`assignedProjectIds`) kullanır.
    const range = getDateRange("CURRENT_MONTH", FIXED_NOW);
    const totals = await getSettlementTotalsForRange(pm.organizationId, range, scope.assignedProjectIds);
    expect(totals.collected.toString()).toBe("0");
    expect(totals.paid.toString()).toBe("0");
  });

  it("başka organizasyondaki üyelik kaydı kapsamı GENİŞLETMEZ", async () => {
    const { owner: ownerA, organizationId: organizationIdA } = await createOwnerOrg();
    const { owner: ownerB, organizationId: organizationIdB } = await createOwnerOrg();
    const pmA = await createOrgUser(organizationIdA, "PROJECT_MANAGER");
    const projectB = await seedOverBudgetProject(ownerB, { budget: 10_000, income: 300_000, expense: 260_000 });
    await seedRealizedPayment(ownerB, { amount: 150_000, projectId: projectB.id });

    // KENDİ organizasyonunda, pmA'nın ATANMADIĞI veri dolu bir proje. Bu şart:
    // aşağıdaki rapor iddiaları yalnızca org A'da görünebilecek bir veri varsa
    // anlamlıdır — aksi hâlde kapsam organizasyon geneline genişlese BİLE tüm
    // sorgular `organizationId: A` ile kesiştiği için sonuç yine boş çıkar ve
    // iddialar sessizce boşa düşerdi.
    const unassignedA = await seedOverBudgetProject(ownerA, { budget: 5_000, income: 200_000, expense: 170_000 });
    await seedRealizedPayment(ownerA, { amount: 90_000, projectId: unassignedA.id });

    // Servis katmanı organizasyonlar arası atama YAPMAZ (bkz.
    // `assignProjectMember`); sızıntı senaryosunu üretmek için üyelik kaydı
    // doğrudan yazılır — kapsam çözümlemesinin `organizationId` süzgecine
    // gerçekten güvenilebildiği ancak böyle kanıtlanabilir.
    await db.projectMember.create({
      data: { organizationId: organizationIdB, projectId: projectB.id, userId: pmA.id },
    });

    const { result: signals, operations } = await measure(() => extractFinancialSignals(pmA));

    expect(membershipQueries(operations)).toHaveLength(1);
    expect(signals).toEqual([]);
    expect(signals.some((s) => s.affectedProjectId === projectB.id)).toBe(false);

    const scope = await resolveActorReportScope(pmA, undefined);
    // Asıl yük burada: org B üyelik kaydı okunmuş OLSAYDI dizi boş olmazdı.
    expect(scope.assignedProjectIds).toEqual([]);

    const budget = await getBudgetReportWithScope(pmA, BUDGET_FILTER, scope);
    expect(budget.projectComparison).toEqual([]);
    expect(budget.metrics.totalRealizedExpenses).toBe("0");

    const margin = await getProjectMarginComparisonWithScope(pmA, { now: FIXED_NOW }, scope);
    expect(margin.rows).toEqual([]);

    // Kontrol (negatif ispat): org A'nın KENDİ sahibi aynı çağrılarda org A
    // verisini GÖRÜR. Yukarıdaki boş sonuçlar bu yüzden "veri yoktu" değil,
    // "kapsam genişlemedi" anlamına gelir.
    const ownerScopeA = await resolveActorReportScope(ownerA, undefined);
    const ownerBudget = await getBudgetReportWithScope(ownerA, BUDGET_FILTER, ownerScopeA);
    expect(ownerBudget.projectComparison.map((r) => r.projectId)).toContain(unassignedA.id);
    expect(ownerBudget.metrics.totalRealizedExpenses).not.toBe("0");
    const ownerMargin = await getProjectMarginComparisonWithScope(ownerA, { now: FIXED_NOW }, ownerScopeA);
    expect(ownerMargin.rows.map((r) => r.projectId)).toContain(unassignedA.id);
  });
});

describe("YF-702-F8 — taşınan kapsam ile genel yol finansal olarak AYNIDIR", () => {
  it("OWNER: bütçe, nakit akışı ve marj raporları iki yolda BİREBİR aynıdır", async () => {
    const { owner } = await createOwnerOrg();
    await seedOverBudgetProject(owner, { budget: 1_000, income: 50_000, expense: 40_000 });
    await seedRealizedPayment(owner, { amount: 90_000 });

    const scope = await resolveActorReportScope(owner, undefined);

    expect(await getBudgetReportWithScope(owner, BUDGET_FILTER, scope)).toEqual(await getBudgetReport(owner, BUDGET_FILTER));
    expect(await getCashFlowReportWithScope(owner, CASH_FLOW_FILTER, scope)).toEqual(
      await getCashFlowReport(owner, CASH_FLOW_FILTER),
    );
    expect(await getProjectMarginComparisonWithScope(owner, { now: FIXED_NOW }, scope)).toEqual(
      await getProjectMarginComparison(owner, { now: FIXED_NOW }),
    );
  });

  it("PROJECT_MANAGER: bütçe, nakit akışı ve marj raporları iki yolda BİREBİR aynıdır", async () => {
    const { owner, organizationId } = await createOwnerOrg();
    const pm = await createOrgUser(organizationId, "PROJECT_MANAGER");
    const assigned = await seedOverBudgetProject(owner, { budget: 1_000, income: 50_000, expense: 40_000 });
    await seedOverBudgetProject(owner, { budget: 1_000, income: 70_000, expense: 60_000 });
    await assignProjectMember(owner, assigned.id, pm.id);

    const scope = await resolveActorReportScope(pm, undefined);

    expect(await getBudgetReportWithScope(pm, BUDGET_FILTER, scope)).toEqual(await getBudgetReport(pm, BUDGET_FILTER));
    expect(await getCashFlowReportWithScope(pm, CASH_FLOW_FILTER, scope)).toEqual(
      await getCashFlowReport(pm, CASH_FLOW_FILTER),
    );
    expect(await getProjectMarginComparisonWithScope(pm, { now: FIXED_NOW }, scope)).toEqual(
      await getProjectMarginComparison(pm, { now: FIXED_NOW }),
    );
  });

  /**
   * Sinyal denkliği İKİ ayrı yoldan kanıtlanır:
   *
   *   a) `extractFinancialSignals` çıktısı, BAĞIMSIZ olarak genel yoldan
   *      çekilmiş dört rapor girdisiyle kural motorunun ürettiği sinyallerle
   *      birebir aynıdır (kural motoru saf bir fonksiyondur, bkz.
   *      server/services/ai-insights-rules.ts — Prisma sorgusu yoktur),
   *   b) art arda iki çağrı birebir aynı çıktıyı verir (kapsamın taşınması
   *      çağrılar arası durum bırakmaz).
   */
  it("içgörü sinyalleri, genel yoldan bağımsız çekilen raporlarla üretilen sinyallerle aynıdır", async () => {
    const { owner } = await createOwnerOrg();
    await seedOverBudgetProject(owner, { budget: 1_000, income: 50_000, expense: 40_000 });
    await seedRealizedPayment(owner, { amount: 120_000 });

    const [budget, cashFlow, projectMargin] = await Promise.all([
      getBudgetReport(owner, BUDGET_FILTER),
      getCashFlowReport(owner, CASH_FLOW_FILTER),
      getProjectMarginComparison(owner),
    ]);
    const range = getDateRange("CURRENT_MONTH", FIXED_NOW);
    const totals = await getSettlementTotalsForRange(owner.organizationId, range, undefined);
    const expected = runInsightRules({
      budget,
      cashFlow,
      projectMargin,
      settlement: {
        collected: totals.collected.toString(),
        paid: totals.paid.toString(),
        net: totals.net.toString(),
        rangeStart: range.start,
        rangeEnd: range.end,
      },
      thresholds: DEFAULT_INSIGHT_THRESHOLDS,
    });

    const signals = await extractFinancialSignals(owner);
    expect(signals).toEqual(expected);
    expect(await extractFinancialSignals(owner)).toEqual(signals);
  });
});

describe("YF-702-F8 — açık projectId ile denklik", () => {
  it("YETKİLİ projectId: taşınan kapsam ile genel yol aynı raporu üretir", async () => {
    const { owner, organizationId } = await createOwnerOrg();
    const pm = await createOrgUser(organizationId, "PROJECT_MANAGER");
    const assigned = await seedOverBudgetProject(owner, { budget: 1_000, income: 50_000, expense: 40_000 });
    await seedOverBudgetProject(owner, { budget: 1_000, income: 70_000, expense: 60_000 });
    await assignProjectMember(owner, assigned.id, pm.id);

    const budgetFilter = { ...BUDGET_FILTER, projectId: assigned.id };
    const cashFlowFilter = { ...CASH_FLOW_FILTER, projectId: assigned.id };

    const scope = await resolveActorReportScope(pm, assigned.id);
    expect(scope.projectFilter).toEqual({ id: assigned.id, name: assigned.name });

    expect(await getBudgetReportWithScope(pm, budgetFilter, scope)).toEqual(await getBudgetReport(pm, budgetFilter));
    expect(await getCashFlowReportWithScope(pm, cashFlowFilter, scope)).toEqual(await getCashFlowReport(pm, cashFlowFilter));
  });

  it("YETKİSİZ projectId: sessiz geri düşüş sözleşmesi korunur ve iki yol yine aynıdır", async () => {
    const { owner, organizationId } = await createOwnerOrg();
    const pm = await createOrgUser(organizationId, "PROJECT_MANAGER");
    const assigned = await seedOverBudgetProject(owner, { budget: 1_000, income: 50_000, expense: 40_000 });
    const unassigned = await seedOverBudgetProject(owner, { budget: 1_000, income: 70_000, expense: 60_000 });
    await assignProjectMember(owner, assigned.id, pm.id);

    const budgetFilter = { ...BUDGET_FILTER, projectId: unassigned.id };
    const cashFlowFilter = { ...CASH_FLOW_FILTER, projectId: unassigned.id };

    const scope = await resolveActorReportScope(pm, unassigned.id);

    // KASITLI sözleşme (bkz. resolveActorReportScope doküman notu): yetkisiz
    // projectId HATA DEĞİLDİR ve sonucu SIFIRLAMAZ; filtre düşer, aktör KENDİ
    // kapsamında kalır. Bu davranış F8 ile DEĞİŞMEMİŞTİR.
    expect(scope.projectFilter).toBeNull();
    expect(scope.moneyScope).toEqual([assigned.id]);

    const budget = await getBudgetReportWithScope(pm, budgetFilter, scope);
    expect(budget).toEqual(await getBudgetReport(pm, budgetFilter));
    expect(budget.projectFilter).toBeNull();
    expect(budget.projectComparison.map((r) => r.projectId)).toEqual([assigned.id]);

    const cashFlow = await getCashFlowReportWithScope(pm, cashFlowFilter, scope);
    expect(cashFlow).toEqual(await getCashFlowReport(pm, cashFlowFilter));
    expect(cashFlow.projectFilter).toBeNull();
  });
});

describe("YF-702-F8 — güvenlik: assertResolvedScopeForActor reddeder", () => {
  it("elle kurulmuş kapsam nesnesi (köken yok) REDDEDİLİR", async () => {
    const { owner } = await createOwnerOrg();
    await seedOverBudgetProject(owner, { budget: 1_000, income: 50_000, expense: 40_000 });

    // Alanların TAMAMI "doğru" değerlerdedir; tek eksik, nesnenin kanonik
    // çözümleyiciden gelmemesidir (bkz. `resolvedScopeRegistry`).
    const forged: ActorReportScope = {
      scope: "ORGANIZATION",
      assignedProjectIds: undefined,
      projectFilter: null,
      moneyScope: undefined,
      actorId: owner.id,
      organizationId: owner.organizationId,
      requestedProjectId: undefined,
    };

    await expect(getBudgetReportWithScope(owner, BUDGET_FILTER, forged)).rejects.toThrow();
    await expect(getCashFlowReportWithScope(owner, CASH_FLOW_FILTER, forged)).rejects.toThrow();
    await expect(getProjectMarginComparisonWithScope(owner, { now: FIXED_NOW }, forged)).rejects.toThrow();
  });

  it("çözümlenmiş kapsam DONDURULMUŞTUR: kayıt sonrası genişletilemez", async () => {
    const { owner, organizationId } = await createOwnerOrg();
    const pm = await createOrgUser(organizationId, "PROJECT_MANAGER");
    const assigned = await seedOverBudgetProject(owner, { budget: 1_000, income: 50_000, expense: 40_000 });
    const unassigned = await seedOverBudgetProject(owner, { budget: 1_000, income: 70_000, expense: 60_000 });
    await assignProjectMember(owner, assigned.id, pm.id);

    const scope = await resolveActorReportScope(pm, undefined);
    expect(Object.isFrozen(scope)).toBe(true);
    expect(Object.isFrozen(scope.assignedProjectIds)).toBe(true);
    expect(Object.isFrozen(scope.moneyScope)).toBe(true);

    // Köken kaydı yalnızca NESNE KİMLİĞİNİ saklar; dondurma olmasaydı beş
    // doğrulamadan da geçen bir kapsam yerinde genişletilebilirdi.
    expect(() => (scope.assignedProjectIds as string[]).push(unassigned.id)).toThrow();
    expect(() => (scope.moneyScope as string[]).push(unassigned.id)).toThrow();
    expect(() => {
      (scope as { moneyScope: string[] | undefined }).moneyScope = [unassigned.id];
    }).toThrow();

    // Kapsam gerçekten daralmış hâlde kalır.
    const budget = await getBudgetReportWithScope(pm, BUDGET_FILTER, scope);
    expect(budget.projectComparison.map((r) => r.projectId)).toEqual([assigned.id]);
  });

  it("aynı organizasyondaki BAŞKA bir aktör için çözülmüş kapsam REDDEDİLİR", async () => {
    const { owner, organizationId } = await createOwnerOrg();
    const admin = await createOrgUser(organizationId, "ADMIN");
    await seedOverBudgetProject(owner, { budget: 1_000, income: 50_000, expense: 40_000 });

    // Rol dalı (ORGANIZATION) ve organizasyon AYNI; ayrışan tek şey `actorId`.
    const adminScope = await resolveActorReportScope(admin, undefined);

    await expect(getBudgetReportWithScope(owner, BUDGET_FILTER, adminScope)).rejects.toThrow();
    await expect(getCashFlowReportWithScope(owner, CASH_FLOW_FILTER, adminScope)).rejects.toThrow();
    await expect(getProjectMarginComparisonWithScope(owner, { now: FIXED_NOW }, adminScope)).rejects.toThrow();
  });

  it("BAŞKA bir projectId için çözülmüş kapsam REDDEDİLİR", async () => {
    const { owner } = await createOwnerOrg();
    const project = await seedOverBudgetProject(owner, { budget: 1_000, income: 50_000, expense: 40_000 });

    const filteredScope = await resolveActorReportScope(owner, project.id);
    const unfilteredScope = await resolveActorReportScope(owner, undefined);

    // Filtreli kapsam, filtresiz bir isteğe iliştirilemez...
    await expect(getBudgetReportWithScope(owner, BUDGET_FILTER, filteredScope)).rejects.toThrow();
    await expect(getCashFlowReportWithScope(owner, CASH_FLOW_FILTER, filteredScope)).rejects.toThrow();
    // ...ve marj servisi (proje filtresi olmayan) filtreli kapsamı ASLA kabul etmez.
    await expect(getProjectMarginComparisonWithScope(owner, { now: FIXED_NOW }, filteredScope)).rejects.toThrow();

    // ...tersi de geçerlidir: filtresiz kapsam filtreli bir isteğe iliştirilemez.
    await expect(
      getBudgetReportWithScope(owner, { ...BUDGET_FILTER, projectId: project.id }, unfilteredScope),
    ).rejects.toThrow();
    await expect(
      getCashFlowReportWithScope(owner, { ...CASH_FLOW_FILTER, projectId: project.id }, unfilteredScope),
    ).rejects.toThrow();
  });

  it("OWNER'ın ORGANIZATION kapsamı bir PROJECT_MANAGER aktöre iliştirilemez", async () => {
    const { owner, organizationId } = await createOwnerOrg();
    const pm = await createOrgUser(organizationId, "PROJECT_MANAGER");
    const project = await seedOverBudgetProject(owner, { budget: 1_000, income: 50_000, expense: 40_000 });
    await assignProjectMember(owner, project.id, pm.id);

    const ownerScope = await resolveActorReportScope(owner, undefined);

    await expect(getBudgetReportWithScope(pm, BUDGET_FILTER, ownerScope)).rejects.toThrow();
    await expect(getCashFlowReportWithScope(pm, CASH_FLOW_FILTER, ownerScope)).rejects.toThrow();
    await expect(getProjectMarginComparisonWithScope(pm, { now: FIXED_NOW }, ownerScope)).rejects.toThrow();

    // Yukarıdaki üç iddiada `actorId` de ayrıştığı için tek başına rol↔dal
    // kontrolünü KANITLAMAZ. Aşağıdaki aktörde kimlik, organizasyon ve filtre
    // alanlarının TAMAMI eşleşir; ayrışan TEK şey roldür — kontrolü yalın
    // biçimde kanıtlayan budur. (Gerçek bir aktör rolünü değiştiremez; bu
    // yüzden aktör nesnesi testte türetilir.) Üç giriş noktası için de
    // doğrulanır: kural servise özel DEĞİLDİR.
    const roleSwappedActor: SessionUser = { ...owner, role: "PROJECT_MANAGER" };
    await expect(getBudgetReportWithScope(roleSwappedActor, BUDGET_FILTER, ownerScope)).rejects.toThrow();
    await expect(getCashFlowReportWithScope(roleSwappedActor, CASH_FLOW_FILTER, ownerScope)).rejects.toThrow();
    await expect(
      getProjectMarginComparisonWithScope(roleSwappedActor, { now: FIXED_NOW }, ownerScope),
    ).rejects.toThrow();
  });
});
