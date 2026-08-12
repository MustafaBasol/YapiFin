import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { cleanDatabase, createOwnerOrg, createOrgUser, createTestPlan } from "./helpers";
import { cancelExpense, createIncome, createExpense } from "@/server/services/transaction-service";
import { createAccount } from "@/server/services/account-service";
import { cancelSettlement, createSettlement } from "@/server/services/settlement-service";
import {
  getDateRange,
  getPriorDateRange,
  getSettlementTotalsForRange,
  resolveActorProjectScope,
} from "@/server/services/dashboard-service";
import { getProjectMarginComparison } from "@/server/services/project-margin-service";
import { createProject, assignProjectMember, setProjectStatus } from "@/server/services/project-service";
import { getBudgetReport } from "@/server/services/budget-report-service";
import { getCashFlowReport } from "@/server/services/cash-flow-report-service";
import { budgetFilterSchema, cashFlowFilterSchema } from "@/lib/validation/reports";
import { extractFinancialSignals, getAiInsights, type FinancialSignal } from "@/server/services/ai-insights-service";
import { AiEntitlementError, createEntitlementAiUsageReporter } from "@/server/services/ai-usage-reporting-service";
import { AiError } from "@/lib/ai";
import { createFakeAiProvider } from "@/lib/ai/providers/fake-provider";
import type { AiProvider } from "@/lib/ai/provider";
import { ServiceError } from "@/server/services/errors";
import { mapAiInsightsError } from "@/app/api/ai/insights/route";
import type { SessionUser } from "@/lib/auth/session";

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
function key(prefix = "ai-insights") {
  seq += 1;
  return `${prefix}-${seq}-${Date.now()}`;
}

const DAY_MS = 24 * 60 * 60 * 1000;
function daysFromNow(days: number) {
  return new Date(Date.now() + days * DAY_MS);
}

async function seedCategory(owner: SessionUser, type: "INCOME" | "EXPENSE") {
  seq += 1;
  return db.transactionCategory.create({ data: { organizationId: owner.organizationId, type, name: `Kategori ${seq}` } });
}

async function seedActiveProject(owner: SessionUser, estimatedBudget: number) {
  seq += 1;
  const project = await createProject(owner, { code: `AII-${seq}`, name: `AI Proje ${seq}`, contractAmount: 0, estimatedBudget });
  await setProjectStatus(owner, project.id, "ACTIVE");
  return project;
}

async function seedExpense(owner: SessionUser, opts: { subtotal: number; projectId?: string; dueDate?: Date }) {
  const category = await seedCategory(owner, "EXPENSE");
  return createExpense(owner, {
    categoryId: category.id,
    projectId: opts.projectId,
    description: "Test gideri",
    issueDate: new Date(),
    dueDate: opts.dueDate,
    subtotal: opts.subtotal,
    taxRate: 0,
  });
}

async function seedIncome(owner: SessionUser, opts: { subtotal: number; projectId?: string; dueDate?: Date }) {
  const category = await seedCategory(owner, "INCOME");
  return createIncome(owner, {
    categoryId: category.id,
    projectId: opts.projectId,
    description: "Test geliri",
    issueDate: new Date(),
    dueDate: opts.dueDate,
    subtotal: opts.subtotal,
    taxRate: 0,
  });
}

async function seedAccount(owner: SessionUser, openingBalance = 1_000_000) {
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

async function settle(owner: SessionUser, transactionId: string, accountId: string, amount: number) {
  return createSettlement(owner, {
    transactionId,
    financialAccountId: accountId,
    amount,
    settlementDate: new Date(),
    paymentMethod: "HAVALE_EFT",
    idempotencyKey: key("settle"),
  });
}

/** Gerçekleşen tahsilat/ödeme kurgusu — YF-702-F1 dengesizlik sinyali için. */
async function seedRealizedSettlements(
  owner: SessionUser,
  opts: { collected: number; paid: number; projectId?: string; accountId?: string },
) {
  const accountId = opts.accountId ?? (await seedAccount(owner)).id;
  if (opts.collected > 0) {
    const income = await seedIncome(owner, { subtotal: opts.collected, projectId: opts.projectId });
    await settle(owner, income.id, accountId, opts.collected);
  }
  if (opts.paid > 0) {
    const expense = await seedExpense(owner, { subtotal: opts.paid, projectId: opts.projectId });
    await settle(owner, expense.id, accountId, opts.paid);
  }
  return accountId;
}

async function aiEnabledOrg(quota: number | null = 50) {
  const { owner, organizationId } = await createOwnerOrg();
  const plan = await createTestPlan({
    limits: { "ai.monthly_quota": quota, "projects.active": null },
    capabilities: { "ai.features": true, "ai.insights": true },
  });
  await db.organization.update({ where: { id: organizationId }, data: { planId: plan.id } });
  return { owner, organizationId };
}

async function aiDisabledOrg() {
  const { owner, organizationId } = await createOwnerOrg();
  const plan = await createTestPlan({
    limits: { "ai.monthly_quota": 100, "projects.active": null },
    capabilities: { "ai.features": false, "ai.insights": false },
  });
  await db.organization.update({ where: { id: organizationId }, data: { planId: plan.id } });
  return { owner, organizationId };
}

/**
 * YF-702 — Genel AI şemsiyesi AÇIK ama İçgörüler modülü plana DAHİL DEĞİL.
 * Bu, `ai.insights`'ın `ai.features`'tan gerçekten BAĞIMSIZ bir kapı olduğunu
 * doğrulayan tek kurulum: `ai.features: true` olduğu için eski (YF-711) kapı
 * bu isteği geçirirdi.
 */
async function insightsDisabledOrg(quota: number | null = 50) {
  const { owner, organizationId } = await createOwnerOrg();
  const plan = await createTestPlan({
    limits: { "ai.monthly_quota": quota, "projects.active": null },
    capabilities: { "ai.features": true, "ai.insights": false },
  });
  await db.organization.update({ where: { id: organizationId }, data: { planId: plan.id } });
  return { owner, organizationId };
}

function trackedProvider(base: AiProvider) {
  let called = false;
  const provider: AiProvider = {
    name: base.name,
    complete: async (req) => {
      called = true;
      return base.complete(req);
    },
  };
  return { provider, wasCalled: () => called };
}

/** Sağlayıcıya GERÇEKTEN gönderilen istem içeriğini yakalar — payload sızıntısı testleri için. */
function capturingProvider(base: AiProvider) {
  const prompts: string[] = [];
  const provider: AiProvider = {
    name: base.name,
    complete: async (req) => {
      prompts.push(req.messages.map((m) => m.content).join("\n"));
      return base.complete(req);
    },
  };
  return { provider, sentPrompt: () => prompts.join("\n") };
}

function jsonResponseFor(signalIds: string[], overrides: Partial<{ title: string; explanation: string; suggestedAction: string }> = {}) {
  return JSON.stringify({
    insights: signalIds.map((signalId) => ({
      signalId,
      title: overrides.title ?? `AI başlığı ${signalId}`,
      explanation: overrides.explanation ?? `AI açıklaması ${signalId}`,
      suggestedAction: overrides.suggestedAction ?? `AI önerisi ${signalId}`,
    })),
  });
}

describe("ai-insights-service — deterministik sinyal çıkarımı", () => {
  it("boş organizasyonda hiç sinyal üretmez (empty-data davranışı)", async () => {
    const { owner } = await aiEnabledOrg();
    const signals = await extractFinancialSignals(owner);
    expect(signals).toHaveLength(0);
  });

  it("bütçe uyarısı: OVER_BUDGET proje BUDGET_OVERRUN sinyali üretir, kanıt getBudgetReport ile birebir eşleşir", async () => {
    const { owner } = await aiEnabledOrg();
    const project = await seedActiveProject(owner, 1000);
    await seedExpense(owner, { subtotal: 1500, projectId: project.id });

    const [signals, budget] = await Promise.all([extractFinancialSignals(owner), getBudgetReport(owner, budgetFilterSchema.parse({}))]);
    const signal = signals.find((s) => s.type === "BUDGET_OVERRUN" && s.affectedProjectId === project.id);
    expect(signal).toBeDefined();
    expect(signal!.severity).toBe("CRITICAL");
    const row = budget.overBudgetProjects.find((r) => r.projectId === project.id)!;
    expect(signal!.evidence.difference).toEqual({ label: "Bütçe aşımı", value: row.overrunAmount, kind: "MONEY" });
    expect(signal!.evidence.currentValue).toEqual({ label: "Gerçekleşen gider", value: row.realizedExpenses, kind: "MONEY" });
    expect(signal!.evidence.comparisonValue).toEqual({ label: "Planlanan bütçe", value: row.estimatedBudget, kind: "MONEY" });
    expect(signal!.evidence.percentageChange).toBe(row.overrunPercentage);
  });

  it("bütçe uyarısı: %80-99 kullanım BUDGET_NEAR_OVERRUN (HIGH) sinyali üretir", async () => {
    const { owner } = await aiEnabledOrg();
    const project = await seedActiveProject(owner, 1000);
    await seedExpense(owner, { subtotal: 850, projectId: project.id });

    const signals = await extractFinancialSignals(owner);
    const signal = signals.find((s) => s.type === "BUDGET_NEAR_OVERRUN" && s.affectedProjectId === project.id);
    expect(signal).toBeDefined();
    expect(signal!.severity).toBe("HIGH");
  });

  it("alacak uyarısı: vadesi geçmiş gelir OVERDUE_RECEIVABLES sinyali üretir, kanıt getCashFlowReport ile birebir eşleşir", async () => {
    const { owner } = await aiEnabledOrg();
    const project = await seedActiveProject(owner, 0);
    await seedIncome(owner, { subtotal: 4000, projectId: project.id, dueDate: daysFromNow(-10) });

    const [signals, cashFlow] = await Promise.all([
      extractFinancialSignals(owner),
      getCashFlowReport(owner, cashFlowFilterSchema.parse({})),
    ]);
    const orgSignal = signals.find((s) => s.id === "overdue_receivables:org");
    expect(orgSignal).toBeDefined();
    expect(orgSignal!.evidence.currentValue).toEqual({
      label: "Vadesi geçmiş alacak",
      value: cashFlow.receivableBuckets.overdue,
      kind: "MONEY",
    });

    const projectSignal = signals.find((s) => s.id === `overdue_receivables:${project.id}`);
    expect(projectSignal).toBeDefined();
    expect(projectSignal!.severity).toBe("MEDIUM");
  });

  it("nakit akışı uyarısı: yakın vadeli ödemeler bakiyeyi negatife düşürünce CASH_FLOW_PRESSURE (CRITICAL) üretir", async () => {
    const { owner } = await aiEnabledOrg();
    await createAccount(owner, { name: "Kasa", type: "CASH", bankName: undefined, iban: undefined, openingBalance: 100, currency: "TRY" });
    await seedExpense(owner, { subtotal: 5000, dueDate: daysFromNow(10) });

    const signals = await extractFinancialSignals(owner);
    const signal = signals.find((s) => s.type === "CASH_FLOW_PRESSURE");
    expect(signal).toBeDefined();
    expect(signal!.severity).toBe("CRITICAL");
    expect(Number(signal!.evidence.currentValue!.value)).toBeLessThan(0);
    expect(signal!.evidence.currentValue!.label).toBe("Tahmini kapanış bakiyesi");
  });

  it("proje kötüleşme sinyali: hem bütçe aşımı hem vadesi geçmiş alacağı olan proje PROJECT_DETERIORATION üretir", async () => {
    const { owner } = await aiEnabledOrg();
    const project = await seedActiveProject(owner, 1000);
    await seedExpense(owner, { subtotal: 1500, projectId: project.id });
    await seedIncome(owner, { subtotal: 2000, projectId: project.id, dueDate: daysFromNow(-5) });

    const signals = await extractFinancialSignals(owner);
    const signal = signals.find((s) => s.id === `project_deterioration:${project.id}`);
    expect(signal).toBeDefined();
    expect(signal!.severity).toBe("CRITICAL");
  });

  it("gider yoğunlaşması: tek bir kategori toplam giderin >=%60'ını oluşturunca EXPENSE_CONCENTRATION (HIGH) üretir", async () => {
    const { owner } = await aiEnabledOrg();
    await seedExpense(owner, { subtotal: 6000 });
    await seedExpense(owner, { subtotal: 1000 });

    const signals = await extractFinancialSignals(owner);
    const signal = signals.find((s) => s.type === "EXPENSE_CONCENTRATION");
    expect(signal).toBeDefined();
    expect(signal!.severity).toBe("HIGH");
  });

  it("tenant izolasyonu: bir organizasyonun sinyalleri başka bir organizasyonun proje/kanıt verisini asla içermez", async () => {
    const orgA = await aiEnabledOrg();
    const orgB = await aiEnabledOrg();
    const projectA = await seedActiveProject(orgA.owner, 1000);
    await seedExpense(orgA.owner, { subtotal: 1500, projectId: projectA.id });
    const projectB = await seedActiveProject(orgB.owner, 1000);
    await seedExpense(orgB.owner, { subtotal: 1500, projectId: projectB.id });

    const signalsA = await extractFinancialSignals(orgA.owner);
    expect(signalsA.some((s) => s.affectedProjectId === projectB.id)).toBe(false);
    expect(signalsA.some((s) => s.affectedProjectName === projectB.name)).toBe(false);
  });

  it("PROJECT_MANAGER rolü yalnızca atandığı projelerin sinyallerini görür", async () => {
    const { owner, organizationId } = await aiEnabledOrg();
    const assignedProject = await seedActiveProject(owner, 1000);
    await seedExpense(owner, { subtotal: 1500, projectId: assignedProject.id });
    const otherProject = await seedActiveProject(owner, 1000);
    await seedExpense(owner, { subtotal: 1500, projectId: otherProject.id });

    const pm = await createOrgUser(organizationId, "PROJECT_MANAGER");
    await assignProjectMember(owner, assignedProject.id, pm.id);

    const signals = await extractFinancialSignals(pm);
    expect(signals.some((s) => s.affectedProjectId === assignedProject.id)).toBe(true);
    expect(signals.some((s) => s.affectedProjectId === otherProject.id)).toBe(false);
  });
});

describe("ai-insights-service — tahsilat/ödeme dengesizliği (YF-702-F1)", () => {
  const imbalanceOf = (signals: FinancialSignal[]) => signals.find((s) => s.type === "COLLECTION_PAYMENT_IMBALANCE");

  it("ödemeler tahsilatları maddi olarak aşınca COLLECTION_PAYMENT_IMBALANCE üretilir", async () => {
    const { owner } = await aiEnabledOrg();
    await seedRealizedSettlements(owner, { collected: 10_000, paid: 100_000 });

    const signal = imbalanceOf(await extractFinancialSignals(owner));
    expect(signal).toBeDefined();
    expect(signal!.id).toBe("collection_payment_imbalance:org");
    expect(signal!.severity).toBe("HIGH");
    expect(signal!.affectedProjectId).toBeNull();
  });

  it("kanıt, kanonik getSettlementTotalsForRange çıktısıyla BİREBİR eşleşir (çift toplama yok)", async () => {
    const { owner } = await aiEnabledOrg();
    await seedRealizedSettlements(owner, { collected: 20_000, paid: 100_000 });

    const range = getDateRange("CURRENT_MONTH", new Date());
    const [signals, totals] = await Promise.all([
      extractFinancialSignals(owner),
      getSettlementTotalsForRange(owner.organizationId, range, await resolveActorProjectScope(owner)),
    ]);
    const signal = imbalanceOf(signals)!;
    expect(signal.evidence.currentValue!.value).toBe(totals.collected.toString());
    expect(signal.evidence.comparisonValue!.value).toBe(totals.paid.toString());
    expect(signal.evidence.difference!.value).toBe(totals.net.toString());
    expect(signal.evidence.period).not.toBeNull();
  });

  it("tahsilat ödemeleri karşılıyorsa (sağlıklı dönem) sinyal ÜRETİLMEZ", async () => {
    const { owner } = await aiEnabledOrg();
    await seedRealizedSettlements(owner, { collected: 100_000, paid: 50_000 });

    expect(imbalanceOf(await extractFinancialSignals(owner))).toBeUndefined();
  });

  it("küçük tutarlı dönemde (gürültü tabanının altında) sinyal ÜRETİLMEZ", async () => {
    const { owner } = await aiEnabledOrg();
    await seedRealizedSettlements(owner, { collected: 100, paid: 5_000 });

    expect(imbalanceOf(await extractFinancialSignals(owner))).toBeUndefined();
  });

  it("iptal edilen tahsilat/ödeme toplamlara dahil EDİLMEZ — kanonik servisin ACTIVE filtresi korunur", async () => {
    const { owner } = await aiEnabledOrg();
    const accountId = (await seedAccount(owner)).id;
    const expense = await seedExpense(owner, { subtotal: 100_000 });
    const payment = await settle(owner, expense.id, accountId, 100_000);
    await cancelSettlement(owner, { id: payment.id, reason: "Yanlış hesap" });

    // Tek gerçekleşen ödeme iptal edildi; geriye dengesizlik üretecek hiçbir
    // aktif hareket kalmadı.
    expect(imbalanceOf(await extractFinancialSignals(owner))).toBeUndefined();
  });

  it("tenant izolasyonu: başka bir organizasyonun tahsilat/ödemeleri sinyale sızmaz", async () => {
    const orgA = await aiEnabledOrg();
    const orgB = await aiEnabledOrg();
    await seedRealizedSettlements(orgA.owner, { collected: 100_000, paid: 50_000 });
    await seedRealizedSettlements(orgB.owner, { collected: 0, paid: 200_000 });

    // A dengeli; B'nin büyük ödeme çıkışı A'nın sinyaline karışmamalıdır.
    expect(imbalanceOf(await extractFinancialSignals(orgA.owner))).toBeUndefined();
    expect(imbalanceOf(await extractFinancialSignals(orgB.owner))).toBeDefined();
  });

  it("PROJECT_MANAGER yalnızca atandığı projelerin tahsilat/ödemesini görür", async () => {
    const { owner, organizationId } = await aiEnabledOrg();
    const assignedProject = await seedActiveProject(owner, 0);
    const otherProject = await seedActiveProject(owner, 0);
    const accountId = (await seedAccount(owner)).id;
    await seedRealizedSettlements(owner, { collected: 60_000, paid: 60_000, projectId: assignedProject.id, accountId });
    await seedRealizedSettlements(owner, { collected: 0, paid: 200_000, projectId: otherProject.id, accountId });

    const pm = await createOrgUser(organizationId, "PROJECT_MANAGER");
    await assignProjectMember(owner, assignedProject.id, pm.id);

    // Atanmış projede tahsilat ve ödeme dengeli; dengesizlik yalnızca
    // atanmamış projededir ve PM'e SIZMAMALIDIR.
    expect(imbalanceOf(await extractFinancialSignals(pm))).toBeUndefined();
    expect(imbalanceOf(await extractFinancialSignals(owner))).toBeDefined();
  });

  it("hiç projesi olmayan PROJECT_MANAGER fail-closed davranır — organizasyon geneline düşmez", async () => {
    const { owner, organizationId } = await aiEnabledOrg();
    await seedRealizedSettlements(owner, { collected: 0, paid: 200_000 });
    const pm = await createOrgUser(organizationId, "PROJECT_MANAGER");

    expect(imbalanceOf(await extractFinancialSignals(pm))).toBeUndefined();
    expect(imbalanceOf(await extractFinancialSignals(owner))).toBeDefined();
  });

  it("sağlayıcıya gönderilen istem yeni sinyalde de tipli kanıt/kimlik sızdırmaz", async () => {
    const { owner, organizationId } = await aiEnabledOrg();
    await seedRealizedSettlements(owner, { collected: 10_000, paid: 100_000 });

    const signals = await extractFinancialSignals(owner);
    const signal = imbalanceOf(signals)!;
    const { provider, sentPrompt } = capturingProvider(
      createFakeAiProvider({ response: jsonResponseFor(signals.map((s) => s.id)) }),
    );
    await getAiInsights(owner, { provider });

    const prompt = sentPrompt();
    expect(prompt).toContain(signal.id);
    expect(prompt).not.toContain(organizationId);
    expect(prompt).not.toContain(owner.id);
    expect(prompt).not.toContain(owner.email);
    // Tipli kanıt iç yapısı (etiket/kind anahtarları) modele GÖNDERİLMEZ.
    expect(prompt).not.toContain("Tahsilatın ödemeleri karşılama oranı");
    expect(prompt).not.toContain("MONEY");
  });
});

describe("ai-insights-service — `ai.insights` özellik yetkisi (YF-702)", () => {
  it("yetki yoksa (ai.features AÇIK ama ai.insights KAPALI) AI_PLAN_REQUIRED ile reddedilir, sağlayıcı hiç çağrılmaz", async () => {
    const { owner } = await insightsDisabledOrg();
    const project = await seedActiveProject(owner, 1000);
    await seedExpense(owner, { subtotal: 1500, projectId: project.id });

    const { provider, wasCalled } = trackedProvider(createFakeAiProvider());
    let caught: unknown;
    try {
      await getAiInsights(owner, { provider, idempotencyKey: key() });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(AiEntitlementError);
    expect((caught as AiEntitlementError).reasonCode).toBe("AI_PLAN_REQUIRED");
    expect((caught as AiEntitlementError).code).toBe("FORBIDDEN");
    expect(wasCalled()).toBe(false);
  });

  it("yetki reddi KOTA TÜKETMEZ — hiçbir AiUsageLedger satırı oluşmaz", async () => {
    const { owner, organizationId } = await insightsDisabledOrg();
    const project = await seedActiveProject(owner, 1000);
    await seedExpense(owner, { subtotal: 1500, projectId: project.id });

    await expect(getAiInsights(owner, { provider: createFakeAiProvider(), idempotencyKey: key() })).rejects.toBeInstanceOf(
      AiEntitlementError,
    );
    expect(await db.aiUsageLedger.count({ where: { organizationId } })).toBe(0);
  });

  it("yetki reddi, sinyali OLMAYAN organizasyonda da uygulanır — 'boş sonuç' ile 'plana dahil değil' karışmaz", async () => {
    // Yetki kontrolü rapor sorgularından ÖNCE çalıştığı için, hiç finansal
    // verisi olmayan yetkisiz bir organizasyon da boş liste değil, açık bir
    // yetki hatası alır.
    const { owner } = await insightsDisabledOrg();
    await expect(getAiInsights(owner, { provider: createFakeAiProvider(), idempotencyKey: key() })).rejects.toBeInstanceOf(
      AiEntitlementError,
    );
  });

  it("yetki varsa içgörü üretilir ve tam olarak bir kullanım kaydı işlenir", async () => {
    const { owner, organizationId } = await aiEnabledOrg();
    const project = await seedActiveProject(owner, 1000);
    await seedExpense(owner, { subtotal: 1500, projectId: project.id });

    const signals = await extractFinancialSignals(owner);
    const provider = createFakeAiProvider({ response: jsonResponseFor(signals.map((s) => s.id)) });
    const result = await getAiInsights(owner, { provider, idempotencyKey: key() });

    expect(result.insights.length).toBeGreaterThan(0);
    expect(await db.aiUsageLedger.count({ where: { organizationId, status: "COMMITTED" } })).toBe(1);
  });

  it("otoriter (atomik) katman da özellik yetkisini uygular — erken kontrol atlansa bile rezervasyon açılmaz", async () => {
    // `checkQuota` doğrudan çağrılır: bu, requestAiCompletion'ın erken
    // kontrolünü BYPASS eder ve yalnızca Serializable transaction içindeki
    // otoriter kapının çalıştığını doğrular (erken kontrol ile rezervasyon
    // arasında planı düşürülen bir organizasyon senaryosu).
    const { owner, organizationId } = await insightsDisabledOrg();
    const reporter = createEntitlementAiUsageReporter(owner, { featureCapability: "ai.insights" });

    const decision = await reporter.checkQuota(organizationId, {
      idempotencyKey: key("atomic"),
      correlationId: key("corr"),
      provider: "fake",
      model: null,
      reservationCreditsEstimate: 1,
    });

    expect(decision.allowed).toBe(false);
    expect(decision.reasonCode).toBe("AI_PLAN_REQUIRED");
    expect(reporter.getReservationId()).toBeNull();
    expect(await db.aiUsageLedger.count({ where: { organizationId } })).toBe(0);
  });

  it("özellik yetkisi belirtilmezse YF-711 davranışı korunur — yalnızca ai.features kontrol edilir", async () => {
    const { owner, organizationId } = await insightsDisabledOrg();
    const reporter = createEntitlementAiUsageReporter(owner);

    const decision = await reporter.checkQuota(organizationId, {
      idempotencyKey: key("no-gate"),
      correlationId: key("corr"),
      provider: "fake",
      model: null,
      reservationCreditsEstimate: 1,
    });

    expect(decision.allowed).toBe(true);
  });
});

describe("ai-insights-service — AI entegrasyonu (YF-711 kapıları)", () => {
  it("ai.features kapalıysa AI_PLAN_REQUIRED ile reddeder, sağlayıcı hiç çağrılmaz", async () => {
    const { owner } = await aiDisabledOrg();
    const project = await seedActiveProject(owner, 1000);
    await seedExpense(owner, { subtotal: 1500, projectId: project.id });

    const { provider, wasCalled } = trackedProvider(createFakeAiProvider());
    await expect(getAiInsights(owner, { provider, idempotencyKey: key() })).rejects.toBeInstanceOf(AiEntitlementError);
    expect(wasCalled()).toBe(false);
  });

  it("AI kotası tükendiyse AI_QUOTA_EXCEEDED ile reddeder, sağlayıcı hiç çağrılmaz", async () => {
    const { owner } = await aiEnabledOrg(0);
    const project = await seedActiveProject(owner, 1000);
    await seedExpense(owner, { subtotal: 1500, projectId: project.id });

    const { provider, wasCalled } = trackedProvider(createFakeAiProvider());
    let caught: unknown;
    try {
      await getAiInsights(owner, { provider, idempotencyKey: key() });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(AiEntitlementError);
    expect((caught as AiEntitlementError).reasonCode).toBe("AI_QUOTA_EXCEEDED");
    expect(wasCalled()).toBe(false);
  });

  it("veri yoksa (empty-data) sağlayıcı hiç çağrılmadan boş içgörü listesi döner", async () => {
    const { owner } = await aiEnabledOrg();
    const { provider, wasCalled } = trackedProvider(createFakeAiProvider());

    const result = await getAiInsights(owner, { provider, idempotencyKey: key() });
    expect(result.insights).toHaveLength(0);
    expect(result.signalCount).toBe(0);
    expect(wasCalled()).toBe(false);
  });

  it("sağlayıcı yükü asgaridir: tipli kanıt, kimlikler ve organizasyon kimliği modele GÖNDERİLMEZ", async () => {
    const { owner, organizationId } = await aiEnabledOrg();
    const project = await seedActiveProject(owner, 1000);
    await seedExpense(owner, { subtotal: 1500, projectId: project.id });

    const signals = await extractFinancialSignals(owner);
    const { provider, sentPrompt } = capturingProvider(
      createFakeAiProvider({ response: jsonResponseFor(signals.map((s) => s.id)) }),
    );
    await getAiInsights(owner, { provider, idempotencyKey: key() });

    const prompt = sentPrompt();
    expect(prompt.length).toBeGreaterThan(0);
    // Modele yalnızca sinyal kimliği/tür/önem/proje adı ve önceden hesaplanmış
    // Türkçe olgu cümlesi gider (bkz. lib/ai/insights/prompt.ts).
    expect(prompt).toContain("budget_overrun:");
    // Yapılandırılmış kanıt SUNUCUDA kalır — etiketleri/alan adları istemde yer almaz.
    expect(prompt).not.toContain("currentValue");
    expect(prompt).not.toContain("comparisonValue");
    expect(prompt).not.toContain("percentageChange");
    // Tenant/kullanıcı kimlikleri ve e-posta asla gönderilmez.
    expect(prompt).not.toContain(organizationId);
    expect(prompt).not.toContain(owner.id);
    expect(prompt).not.toContain(owner.email);
  });

  it("sağlayıcı hatası şeffaf biçimde yükselir (provider_error)", async () => {
    const { owner } = await aiEnabledOrg();
    const project = await seedActiveProject(owner, 1000);
    await seedExpense(owner, { subtotal: 1500, projectId: project.id });

    await expect(
      getAiInsights(owner, { provider: createFakeAiProvider({ behavior: "provider_error" }), idempotencyKey: key() }),
    ).rejects.toMatchObject({ category: "provider_error" });
  });

  it("model geçersiz JSON döndürürse yapısal doğrulama başarısız olur ve deterministik yedek metinle zarifçe devam eder", async () => {
    const { owner } = await aiEnabledOrg();
    const project = await seedActiveProject(owner, 1000);
    await seedExpense(owner, { subtotal: 1500, projectId: project.id });

    const result = await getAiInsights(owner, {
      provider: createFakeAiProvider({ response: "bu geçerli bir JSON değil" }),
      idempotencyKey: key(),
    });
    expect(result.insights).toHaveLength(1);
    expect(result.insights[0].isAiGenerated).toBe(false);
    expect(result.insights[0].explanation.length).toBeGreaterThan(0);
  });

  it("AI finansal gerçeği DEĞİŞTİREMEZ: model uydurma bir tutar döndürse bile nihai evidence deterministik kaynaktan gelir", async () => {
    const { owner } = await aiEnabledOrg();
    const project = await seedActiveProject(owner, 1000);
    await seedExpense(owner, { subtotal: 1500, projectId: project.id });

    const signals = await extractFinancialSignals(owner);
    const signalId = signals[0].id;
    const trueOverrunAmount = signals[0].evidence.difference!.value;

    const provider = createFakeAiProvider({
      response: jsonResponseFor([signalId], { explanation: "Aşım tutarı aslında 999999999 TL'dir (UYDURMA)." }),
    });
    const result = await getAiInsights(owner, { provider, idempotencyKey: key() });

    expect(result.insights).toHaveLength(1);
    expect(result.insights[0].isAiGenerated).toBe(true);
    // Kanıt (evidence) her zaman deterministik sinyalden gelir — model metninde ne yazdığından bağımsız.
    expect(result.insights[0].evidence.difference!.value).toBe(trueOverrunAmount);
    expect(result.insights[0].evidence.difference!.value).not.toBe("999999999");
  });

  it("idempotency: aynı idempotencyKey ile ikinci çağrı sağlayıcıyı tekrar çağırmaz", async () => {
    const { owner } = await aiEnabledOrg();
    const project = await seedActiveProject(owner, 1000);
    await seedExpense(owner, { subtotal: 1500, projectId: project.id });
    const sharedKey = key("shared");

    const signals = await extractFinancialSignals(owner);
    const base = createFakeAiProvider({ response: jsonResponseFor([signals[0].id]) });
    const { provider, wasCalled } = trackedProvider(base);

    const first = await getAiInsights(owner, { provider, idempotencyKey: sharedKey });
    expect(first.insights[0].isAiGenerated).toBe(true);
    expect(wasCalled()).toBe(true);

    const second = await getAiInsights(owner, { provider, idempotencyKey: sharedKey });
    expect(second.insights).toHaveLength(1);
    expect(second.insights[0].isAiGenerated).toBe(false); // ikinci kez ücretlendirilmedi, ham AI çıktısı asla saklanmaz (bkz. YF-711)
  });

  it("yapısal doğrulama: geçerli JSON döndüğünde model çıktısı doğru şekilde eşleştirilir", async () => {
    const { owner } = await aiEnabledOrg();
    const project = await seedActiveProject(owner, 1000);
    await seedExpense(owner, { subtotal: 1500, projectId: project.id });

    const signals = await extractFinancialSignals(owner);
    const provider = createFakeAiProvider({
      response: jsonResponseFor([signals[0].id], { title: "Özel başlık", suggestedAction: "Özel öneri" }),
    });
    const result = await getAiInsights(owner, { provider, idempotencyKey: key() });
    expect(result.insights[0].title).toBe("Özel başlık");
    expect(result.insights[0].suggestedAction).toBe("Özel öneri");
    expect(result.insights[0].isAiGenerated).toBe(true);
  });
});

/**
 * YF-702-F3 — `PROJECT_MARGIN_DETERIORATION` uçtan uca: gerçek Prisma verisi →
 * kanonik `getProjectMarginComparison` → deterministik kural → sinyal.
 *
 * Eşik SINIRLARI burada değil, tests/ai-insights-rules.test.ts içinde (DB'siz,
 * kesin marj kurgusuyla) sınanır. Bu blok, kuralın gerçek finansal veriyle
 * doğru beslendiğini, kapsamın sızdırmadığını ve iptal/tahsilat semantiğinin
 * kanonik servisten devralındığını doğrular.
 */
describe("ai-insights-service — proje kâr marjı gerilemesi (YF-702-F3)", () => {
  /** Cari dönem içinde kesin olan an. */
  const IN_CURRENT_PERIOD = new Date();
  /** Önceki eşdeğer dönemin 2. günü — testin çalıştığı takvim ayından bağımsız. */
  const IN_PRIOR_PERIOD = new Date(getPriorDateRange("CURRENT_MONTH", IN_CURRENT_PERIOD).start.getTime() + DAY_MS);

  const marginSignalsOf = (signals: FinancialSignal[]) => signals.filter((s) => s.type === "PROJECT_MARGIN_DETERIORATION");

  async function seedPeriodActivity(
    owner: SessionUser,
    projectId: string,
    period: "current" | "prior",
    amounts: { income: number; expense: number },
  ) {
    const issueDate = period === "current" ? IN_CURRENT_PERIOD : IN_PRIOR_PERIOD;
    const incomeCategory = await seedCategory(owner, "INCOME");
    const expenseCategory = await seedCategory(owner, "EXPENSE");
    const income = await createIncome(owner, {
      categoryId: incomeCategory.id,
      projectId,
      description: "Dönem geliri",
      issueDate,
      subtotal: amounts.income,
      taxRate: 0,
    });
    const expense = await createExpense(owner, {
      categoryId: expenseCategory.id,
      projectId,
      description: "Dönem gideri",
      issueDate,
      subtotal: amounts.expense,
      taxRate: 0,
    });
    return { income, expense };
  }

  /** Marjı %40'tan %15'e düşen (25 puan) bir proje — HIGH eşiğinin üstünde. */
  async function seedDeterioratingProject(owner: SessionUser) {
    const project = await seedActiveProject(owner, 0);
    await seedPeriodActivity(owner, project.id, "prior", { income: 100_000, expense: 60_000 });
    const current = await seedPeriodActivity(owner, project.id, "current", { income: 100_000, expense: 85_000 });
    return { project, current };
  }

  it("gerçek veriden HIGH sinyal üretir ve kanıt kanonik servisle BİREBİR eşleşir", async () => {
    const { owner } = await aiEnabledOrg();
    const { project } = await seedDeterioratingProject(owner);

    const [signals, comparison] = await Promise.all([extractFinancialSignals(owner), getProjectMarginComparison(owner)]);
    const signal = marginSignalsOf(signals).find((s) => s.affectedProjectId === project.id);
    const row = comparison.rows.find((r) => r.projectId === project.id)!;

    expect(signal).toBeDefined();
    expect(signal!.severity).toBe("HIGH");
    // Marj/gelir/kâr hiçbir yerde YENİDEN hesaplanmaz — F2 çıktısı otoritedir.
    expect(row.prior.margin).toBe("40");
    expect(row.current.margin).toBe("15");
    expect(signal!.evidence.currentValue!.value).toBe(row.current.margin);
    expect(signal!.evidence.comparisonValue!.value).toBe(row.prior.margin);
    expect(signal!.evidence.difference).toEqual({ label: "Marj değişimi", value: "-25", kind: "PERCENTAGE_POINT" });
    expect(signal!.evidence.percentageChange).toBeNull();
    expect(signal!.evidence.details).toContainEqual({ label: "Cari dönem geliri", value: row.current.revenue, kind: "MONEY" });
    expect(signal!.evidence.details).toContainEqual({ label: "Cari dönem kârı", value: row.current.profit, kind: "MONEY" });
  });

  it("iyileşen marj sinyal üretmez", async () => {
    const { owner } = await aiEnabledOrg();
    const project = await seedActiveProject(owner, 0);
    await seedPeriodActivity(owner, project.id, "prior", { income: 100_000, expense: 85_000 });
    await seedPeriodActivity(owner, project.id, "current", { income: 100_000, expense: 60_000 });

    expect(marginSignalsOf(await extractFinancialSignals(owner))).toHaveLength(0);
  });

  it("cari dönemde hiç hareketi olmayan proje için sinyal üretilmez — marj tanımsızdır, %0 sayılmaz", async () => {
    const { owner } = await aiEnabledOrg();
    const project = await seedActiveProject(owner, 0);
    await seedPeriodActivity(owner, project.id, "prior", { income: 100_000, expense: 60_000 });

    const comparison = await getProjectMarginComparison(owner);
    expect(comparison.rows.find((r) => r.projectId === project.id)!.current.margin).toBeNull();
    expect(marginSignalsOf(await extractFinancialSignals(owner))).toHaveLength(0);
  });

  it("iptal edilmiş gider semantiği kanonik servisten devralınır — iptal sonrası sinyal kaybolur", async () => {
    const { owner } = await aiEnabledOrg();
    const { project, current } = await seedDeterioratingProject(owner);
    expect(marginSignalsOf(await extractFinancialSignals(owner))).toHaveLength(1);

    // Cari dönem gideri iptal edilince marj %15 → %100'e çıkar; gerileme kalmaz.
    await cancelExpense(owner, { id: current.expense.id, reason: "Yanlış kayıt" });

    const comparison = await getProjectMarginComparison(owner);
    expect(comparison.rows.find((r) => r.projectId === project.id)!.current.margin).toBe("100");
    expect(marginSignalsOf(await extractFinancialSignals(owner))).toHaveLength(0);
  });

  it("başka organizasyonun marj gerilemesi SIZMAZ", async () => {
    const orgA = await aiEnabledOrg();
    const orgB = await aiEnabledOrg();
    await seedDeterioratingProject(orgA.owner);

    expect(marginSignalsOf(await extractFinancialSignals(orgA.owner))).toHaveLength(1);
    expect(marginSignalsOf(await extractFinancialSignals(orgB.owner))).toHaveLength(0);
  });

  it("PROJECT_MANAGER yalnızca atandığı projenin marj gerilemesini görür", async () => {
    const { owner, organizationId } = await aiEnabledOrg();
    const assigned = await seedDeterioratingProject(owner);
    const unassigned = await seedDeterioratingProject(owner);

    const pm = await createOrgUser(organizationId, "PROJECT_MANAGER");
    await assignProjectMember(owner, assigned.project.id, pm.id);

    const pmSignals = marginSignalsOf(await extractFinancialSignals(pm));
    expect(pmSignals.map((s) => s.affectedProjectId)).toEqual([assigned.project.id]);

    const ownerSignals = marginSignalsOf(await extractFinancialSignals(owner));
    expect(ownerSignals.map((s) => s.affectedProjectId).sort()).toEqual([assigned.project.id, unassigned.project.id].sort());
  });

  it("atanmış projesi olmayan PROJECT_MANAGER fail-closed davranır", async () => {
    const { owner, organizationId } = await aiEnabledOrg();
    await seedDeterioratingProject(owner);
    const pm = await createOrgUser(organizationId, "PROJECT_MANAGER");

    expect(marginSignalsOf(await extractFinancialSignals(pm))).toHaveLength(0);
    expect(marginSignalsOf(await extractFinancialSignals(owner))).toHaveLength(1);
  });

  it("sağlayıcıya gönderilen istem tenant/aktör kimliği veya e-posta taşımaz", async () => {
    const { owner, organizationId } = await aiEnabledOrg();
    const { project } = await seedDeterioratingProject(owner);

    const signals = await extractFinancialSignals(owner);
    const signal = marginSignalsOf(signals)[0];
    const { provider, sentPrompt } = capturingProvider(
      createFakeAiProvider({ response: jsonResponseFor(signals.map((s) => s.id)) }),
    );
    await getAiInsights(owner, { provider, idempotencyKey: key() });

    const prompt = sentPrompt();
    expect(prompt).toContain(signal.id);
    // Kullanıcıya gösterilecek proje ADI gereklidir; tenant/aktör kimliği DEĞİLDİR.
    // (Sinyal kimliği kararlı olmak için proje id'si taşır — bu, mevcut tüm
    // proje sinyallerinde geçerli olan yerleşik konvansiyondur.)
    expect(prompt).toContain(project.name);
    expect(prompt).not.toContain(organizationId);
    expect(prompt).not.toContain(owner.id);
    expect(prompt).not.toContain(owner.email);
    // Tipli kanıt yapısı modele HİÇ gönderilmez; yalnızca olgu cümlesi gider.
    expect(prompt).not.toContain("PERCENTAGE_POINT");
    expect(prompt).not.toContain("currentValue");
  });

  it("sağlayıcı geçersiz yanıt verse bile deterministik marj uyarısı kullanıcıya ulaşır", async () => {
    const { owner } = await aiEnabledOrg();
    await seedDeterioratingProject(owner);

    const provider = createFakeAiProvider({ response: "bu geçerli bir JSON değil" });
    const result = await getAiInsights(owner, { provider, idempotencyKey: key() });

    const insight = result.insights.find((i) => i.type === "PROJECT_MARGIN_DETERIORATION")!;
    expect(insight).toBeDefined();
    expect(insight.isAiGenerated).toBe(false);
    expect(insight.severity).toBe("HIGH");
    expect(insight.explanation).toContain("yüzde puan");
    // Ham enum/anahtar kullanıcıya sızmaz.
    expect(insight.title).not.toContain("PROJECT_MARGIN_DETERIORATION");
    expect(insight.explanation).not.toContain("PROJECT_MARGIN_DETERIORATION");
  });
});

describe("app/api/ai/insights route — kullanıcıya gösterilen hata eşlemesi", () => {
  it("AI_PLAN_REQUIRED -> 403", () => {
    const err = new AiEntitlementError("Plan gerekli", "FORBIDDEN", "AI_PLAN_REQUIRED");
    const mapped = mapAiInsightsError(err);
    expect(mapped.status).toBe(403);
    expect(mapped.body.code).toBe("AI_PLAN_REQUIRED");
  });

  it("AI_QUOTA_EXCEEDED -> 409", () => {
    const err = new AiEntitlementError("Kota doldu", "CONFLICT", "AI_QUOTA_EXCEEDED");
    const mapped = mapAiInsightsError(err);
    expect(mapped.status).toBe(409);
    expect(mapped.body.code).toBe("AI_QUOTA_EXCEEDED");
  });

  it("devre dışı sağlayıcı (not_configured) -> 503 AI_PROVIDER_DISABLED", () => {
    const err = new AiError("Sağlayıcı yapılandırılmamış", "not_configured", "corr-1");
    const mapped = mapAiInsightsError(err);
    expect(mapped.status).toBe(503);
    expect(mapped.body.code).toBe("AI_PROVIDER_DISABLED");
  });

  it("geçici sağlayıcı hatası (timeout/provider_error) -> 503 AI_PROVIDER_UNAVAILABLE", () => {
    expect(mapAiInsightsError(new AiError("zaman aşımı", "timeout", "corr-2")).body.code).toBe("AI_PROVIDER_UNAVAILABLE");
    expect(mapAiInsightsError(new AiError("sağlayıcı hatası", "provider_error", "corr-3")).status).toBe(503);
  });

  it("bilinen ServiceError kendi koduna eşlenir", () => {
    const mapped = mapAiInsightsError(new ServiceError("Yetkisiz", "FORBIDDEN"));
    expect(mapped.status).toBe(403);
  });

  it("bilinmeyen bir hata 500 genel mesajına düşer", () => {
    const mapped = mapAiInsightsError(new Error("beklenmeyen"));
    expect(mapped.status).toBe(500);
  });
});
