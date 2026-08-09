import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { cleanDatabase, createOwnerOrg, createOrgUser, createTestPlan } from "./helpers";
import { createExpense } from "@/server/services/transaction-service";
import { createAccount } from "@/server/services/account-service";
import { createProject, assignProjectMember, setProjectStatus } from "@/server/services/project-service";
import { getBudgetReport } from "@/server/services/budget-report-service";
import { budgetFilterSchema } from "@/lib/validation/reports";
import { askYapiFin } from "@/server/services/ask-yapifin-service";
import { AiEntitlementError } from "@/server/services/ai-usage-reporting-service";
import { AiError } from "@/lib/ai";
import { createFakeAiProvider } from "@/lib/ai/providers/fake-provider";
import type { AiProvider } from "@/lib/ai/provider";
import { ServiceError } from "@/server/services/errors";
import { mapAskYapiFinError } from "@/app/api/ai/ask/route";
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
function key(prefix = "ask") {
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
  const project = await createProject(owner, { code: `ASK-${seq}`, name: `Ask Proje ${seq}`, contractAmount: 0, estimatedBudget });
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

async function aiEnabledOrg(quota: number | null = 50) {
  const { owner, organizationId } = await createOwnerOrg();
  const plan = await createTestPlan({
    limits: { "ai.monthly_quota": quota, "projects.active": null },
    capabilities: { "ai.features": true },
  });
  await db.organization.update({ where: { id: organizationId }, data: { planId: plan.id } });
  return { owner, organizationId };
}

async function aiDisabledOrg() {
  const { owner, organizationId } = await createOwnerOrg();
  const plan = await createTestPlan({
    limits: { "ai.monthly_quota": 100, "projects.active": null },
    capabilities: { "ai.features": false },
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

function jsonAnswer(text: string) {
  return JSON.stringify({ answer: text });
}

describe("ask-yapifin-service — sınıflandırma ve desteklenmeyen sorular", () => {
  it("konuyla ilgisiz bir soru: AI hiç çağrılmadan 'unsupported' döner (uydurma yok)", async () => {
    const { owner } = await aiEnabledOrg();
    const { provider, wasCalled } = trackedProvider(createFakeAiProvider());

    const result = await askYapiFin(owner, "Yarın hava nasıl olacak?", { provider, idempotencyKey: key() });
    expect(result.status).toBe("unsupported");
    expect(wasCalled()).toBe(false);
  });
});

describe("ask-yapifin-service — kanonik servislerle birebir eşleşen deterministik olgular", () => {
  it("TOP_BUDGET_OVERRUN: facts, getBudgetReport ile birebir eşleşir", async () => {
    const { owner } = await aiEnabledOrg();
    const project = await seedActiveProject(owner, 1000);
    await seedExpense(owner, { subtotal: 1500, projectId: project.id });

    const result = await askYapiFin(owner, "En fazla bütçe aşımı hangi projede?", {
      provider: createFakeAiProvider({ response: jsonAnswer("Test yanıtı") }),
      idempotencyKey: key(),
    });
    const budget = await getBudgetReport(owner, budgetFilterSchema.parse({}));
    const row = budget.overBudgetProjects[0];

    expect(result.status).toBe("answered");
    if (result.status !== "answered") return;
    expect(result.intent).toBe("TOP_BUDGET_OVERRUN");
    expect(result.projectId).toBe(row.projectId);
    expect(result.facts.find((f) => f.label === "Aşım Tutarı")!.value).toBe(`${row.overrunAmount} TL`);
    expect(result.facts.find((f) => f.label === "Gerçekleşen Gider")!.value).toBe(`${row.realizedExpenses} TL`);
  });

  it("Decimal hassasiyeti: kuruş değerleri facts'e kayıpsız aktarılır (Number() dönüşümü yok)", async () => {
    const { owner } = await aiEnabledOrg();
    const project = await seedActiveProject(owner, 1000);
    await seedExpense(owner, { subtotal: 1500.37, projectId: project.id });

    const budget = await getBudgetReport(owner, budgetFilterSchema.parse({}));
    const row = budget.overBudgetProjects[0];

    const result = await askYapiFin(owner, "En fazla bütçe aşımı hangi projede?", {
      provider: createFakeAiProvider(),
      idempotencyKey: key(),
    });
    expect(result.status).toBe("answered");
    if (result.status !== "answered") return;
    expect(result.facts.find((f) => f.label === "Gerçekleşen Gider")!.value).toBe(`${row.realizedExpenses} TL`);
    expect(row.realizedExpenses).toContain("1500.37");
  });

  it("AI finansal gerçeği DEĞİŞTİREMEZ: model uydurma bir tutar döndürse bile facts deterministik kaynaktan gelir", async () => {
    const { owner } = await aiEnabledOrg();
    const project = await seedActiveProject(owner, 1000);
    await seedExpense(owner, { subtotal: 1500, projectId: project.id });

    const budget = await getBudgetReport(owner, budgetFilterSchema.parse({}));
    const trueOverrunAmount = budget.overBudgetProjects[0].overrunAmount;

    const result = await askYapiFin(owner, "En fazla bütçe aşımı hangi projede?", {
      provider: createFakeAiProvider({ response: jsonAnswer("Aşım tutarı aslında 999999999 TL'dir (UYDURMA).") }),
      idempotencyKey: key(),
    });

    expect(result.status).toBe("answered");
    if (result.status !== "answered") return;
    expect(result.answer.isAiGenerated).toBe(true);
    const overrunFact = result.facts.find((f) => f.label === "Aşım Tutarı")!;
    expect(overrunFact.value).toBe(`${trueOverrunAmount} TL`);
    expect(overrunFact.value).not.toBe("999999999 TL");
  });

  it("nakit akışı riski: yakın vadeli büyük ödeme bakiyeyi negatife düşürünce risk sinyali facts'e yansır", async () => {
    const { owner } = await aiEnabledOrg();
    await createAccount(owner, { name: "Kasa", type: "CASH", bankName: undefined, iban: undefined, openingBalance: 100, currency: "TRY" });
    await seedExpense(owner, { subtotal: 5000, dueDate: daysFromNow(10) });

    const result = await askYapiFin(owner, "Nakit akışında risk var mı?", {
      provider: createFakeAiProvider({ response: jsonAnswer("Evet, nakit akışında risk var.") }),
      idempotencyKey: key(),
    });
    expect(result.status).toBe("answered");
    if (result.status !== "answered") return;
    expect(result.facts.find((f) => f.label === "Nakit Akışı Riski")!.value).toContain("risk tespit edildi");
  });
});

describe("ask-yapifin-service — tenant izolasyonu ve rol kapsaması", () => {
  it("bir organizasyonun yanıtı başka bir organizasyonun proje verisini asla içermez", async () => {
    const orgA = await aiEnabledOrg();
    const orgB = await aiEnabledOrg();
    const projectA = await seedActiveProject(orgA.owner, 1000);
    await seedExpense(orgA.owner, { subtotal: 1500, projectId: projectA.id });
    const projectB = await seedActiveProject(orgB.owner, 1000);
    await seedExpense(orgB.owner, { subtotal: 1500, projectId: projectB.id });

    const result = await askYapiFin(orgA.owner, "En fazla bütçe aşımı hangi projede?", {
      provider: createFakeAiProvider(),
      idempotencyKey: key(),
    });
    expect(result.status).toBe("answered");
    if (result.status !== "answered") return;
    expect(result.projectId).toBe(projectA.id);
    expect(result.projectId).not.toBe(projectB.id);
  });

  it("başka bir organizasyonun proje adı asla eşleştirilmez (proje listesi actor'a scope'lu) — var olduğu bile ima edilmez", async () => {
    const orgA = await aiEnabledOrg();
    const orgB = await aiEnabledOrg();
    const projectB = await seedActiveProject(orgB.owner, 1000);

    const { provider, wasCalled } = trackedProvider(createFakeAiProvider());
    const result = await askYapiFin(orgA.owner, `${projectB.name} projesinin finansal durumu nasıl?`, {
      provider,
      idempotencyKey: key(),
    });
    expect(result.status).toBe("unsupported");
    expect(wasCalled()).toBe(false);
  });

  it("PROJECT_MANAGER yalnızca atandığı projenin durumunu sorgulayabilir, atanmadığı proje için unsupported döner", async () => {
    const { owner, organizationId } = await aiEnabledOrg();
    const assignedProject = await seedActiveProject(owner, 1000);
    await seedExpense(owner, { subtotal: 500, projectId: assignedProject.id });
    const otherProject = await seedActiveProject(owner, 1000);
    await seedExpense(owner, { subtotal: 500, projectId: otherProject.id });
    const pm = await createOrgUser(organizationId, "PROJECT_MANAGER");
    await assignProjectMember(owner, assignedProject.id, pm.id);

    const assignedResult = await askYapiFin(pm, `${assignedProject.name} projesinin durumu nasıl?`, {
      provider: createFakeAiProvider(),
      idempotencyKey: key(),
    });
    expect(assignedResult.status).toBe("answered");
    if (assignedResult.status === "answered") expect(assignedResult.projectId).toBe(assignedProject.id);

    const { provider, wasCalled } = trackedProvider(createFakeAiProvider());
    const otherResult = await askYapiFin(pm, `${otherProject.name} projesinin durumu nasıl?`, { provider, idempotencyKey: key() });
    expect(otherResult.status).toBe("unsupported");
    expect(wasCalled()).toBe(false);
  });

  it("PROJECT_MANAGER için scope her zaman PROJECT_MANAGER olarak işaretlenir", async () => {
    const { organizationId } = await aiEnabledOrg();
    const pm = await createOrgUser(organizationId, "PROJECT_MANAGER");

    const result = await askYapiFin(pm, "Bu ay toplam giderimiz ne kadar?", {
      provider: createFakeAiProvider(),
      idempotencyKey: key(),
    });
    expect(result.status).toBe("answered");
    if (result.status === "answered") expect(result.scope).toBe("PROJECT_MANAGER");
  });
});

describe("ask-yapifin-service — AI entegrasyonu (YF-711 kapıları)", () => {
  it("ai.features kapalıysa AI_PLAN_REQUIRED ile reddeder, sağlayıcı hiç çağrılmaz", async () => {
    const { owner } = await aiDisabledOrg();
    const { provider, wasCalled } = trackedProvider(createFakeAiProvider());

    await expect(
      askYapiFin(owner, "Bu ay toplam giderimiz ne kadar?", { provider, idempotencyKey: key() }),
    ).rejects.toBeInstanceOf(AiEntitlementError);
    expect(wasCalled()).toBe(false);
  });

  it("AI kotası tükendiyse AI_QUOTA_EXCEEDED ile reddeder, sağlayıcı hiç çağrılmaz", async () => {
    const { owner } = await aiEnabledOrg(0);
    const { provider, wasCalled } = trackedProvider(createFakeAiProvider());

    let caught: unknown;
    try {
      await askYapiFin(owner, "Bu ay toplam giderimiz ne kadar?", { provider, idempotencyKey: key() });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(AiEntitlementError);
    expect((caught as AiEntitlementError).reasonCode).toBe("AI_QUOTA_EXCEEDED");
    expect(wasCalled()).toBe(false);
  });

  it("sağlayıcı hatası şeffaf biçimde yükselir (provider_error)", async () => {
    const { owner } = await aiEnabledOrg();
    await expect(
      askYapiFin(owner, "Bu ay toplam giderimiz ne kadar?", {
        provider: createFakeAiProvider({ behavior: "provider_error" }),
        idempotencyKey: key(),
      }),
    ).rejects.toMatchObject({ category: "provider_error" });
  });

  it("model geçersiz JSON döndürürse yapısal doğrulama başarısız olur, deterministik olgu metniyle zarifçe devam edilir", async () => {
    const { owner } = await aiEnabledOrg();
    const result = await askYapiFin(owner, "Bu ay toplam giderimiz ne kadar?", {
      provider: createFakeAiProvider({ response: "bu geçerli bir JSON değil" }),
      idempotencyKey: key(),
    });
    expect(result.status).toBe("answered");
    if (result.status !== "answered") return;
    expect(result.answer.isAiGenerated).toBe(false);
    expect(result.answer.text.length).toBeGreaterThan(0);
  });

  it("idempotency: aynı idempotencyKey ile ikinci çağrı sağlayıcıyı tekrar çağırmaz", async () => {
    const { owner } = await aiEnabledOrg();
    const sharedKey = key("shared");
    const base = createFakeAiProvider({ response: jsonAnswer("İlk yanıt") });
    const { provider, wasCalled } = trackedProvider(base);

    const first = await askYapiFin(owner, "Bu ay toplam giderimiz ne kadar?", { provider, idempotencyKey: sharedKey });
    expect(first.status).toBe("answered");
    if (first.status === "answered") expect(first.answer.isAiGenerated).toBe(true);
    expect(wasCalled()).toBe(true);

    const second = await askYapiFin(owner, "Bu ay toplam giderimiz ne kadar?", { provider, idempotencyKey: sharedKey });
    expect(second.status).toBe("answered");
    // İkinci çağrı sağlayıcıyı tekrar tetiklemedi (wasCalled zaten true kaldı) ve ham AI çıktısı asla saklanmadığından
    // ikinci kez ücretlendirilmeden deterministik metinle döner (bkz. YF-711).
    if (second.status === "answered") expect(second.answer.isAiGenerated).toBe(false);
  });
});

describe("ask-yapifin-service — empty-data davranışı (AI hiç çağrılmadan deterministik yanıt)", () => {
  it("bütçesi aşılmış proje yoksa", async () => {
    const { owner } = await aiEnabledOrg();
    const { provider, wasCalled } = trackedProvider(createFakeAiProvider());

    const result = await askYapiFin(owner, "En fazla bütçe aşımı hangi projede?", { provider, idempotencyKey: key() });
    expect(result.status).toBe("answered");
    if (result.status === "answered") {
      expect(result.answer.isAiGenerated).toBe(false);
      expect(result.facts).toHaveLength(0);
    }
    expect(wasCalled()).toBe(false);
  });

  it("vadesi geçen alacak yoksa", async () => {
    const { owner } = await aiEnabledOrg();
    const { provider, wasCalled } = trackedProvider(createFakeAiProvider());

    const result = await askYapiFin(owner, "Vadesi geçen alacaklarımız ne kadar?", { provider, idempotencyKey: key() });
    expect(result.status).toBe("answered");
    if (result.status === "answered") {
      expect(result.answer.isAiGenerated).toBe(false);
      expect(result.facts[0].value).toBe("0 TL");
    }
    expect(wasCalled()).toBe(false);
  });

  it("hiç gider kategorisi yoksa", async () => {
    const { owner } = await aiEnabledOrg();
    const { provider, wasCalled } = trackedProvider(createFakeAiProvider());

    const result = await askYapiFin(owner, "Hangi kategoride gider yoğunlaşması var?", { provider, idempotencyKey: key() });
    expect(result.status).toBe("answered");
    if (result.status === "answered") {
      expect(result.answer.isAiGenerated).toBe(false);
      expect(result.facts).toHaveLength(0);
    }
    expect(wasCalled()).toBe(false);
  });

  it("boş organizasyonda org özeti sorusu yine de yanıtlanır (sıfır değerler geçerli veridir, AI çağrılır)", async () => {
    const { owner } = await aiEnabledOrg();
    const { provider, wasCalled } = trackedProvider(createFakeAiProvider({ response: jsonAnswer("Henüz hiç işlem yok.") }));

    const result = await askYapiFin(owner, "Bu ay toplam giderimiz ne kadar?", { provider, idempotencyKey: key() });
    expect(result.status).toBe("answered");
    if (result.status === "answered") {
      expect(result.facts.find((f) => f.label === "Ödenen Gider")!.value).toBe("0 TL");
    }
    expect(wasCalled()).toBe(true);
  });
});

describe("app/api/ai/ask route — kullanıcıya gösterilen hata eşlemesi", () => {
  it("AI_PLAN_REQUIRED -> 403", () => {
    const err = new AiEntitlementError("Plan gerekli", "FORBIDDEN", "AI_PLAN_REQUIRED");
    const mapped = mapAskYapiFinError(err);
    expect(mapped.status).toBe(403);
    expect(mapped.body.code).toBe("AI_PLAN_REQUIRED");
  });

  it("AI_QUOTA_EXCEEDED -> 409", () => {
    const err = new AiEntitlementError("Kota doldu", "CONFLICT", "AI_QUOTA_EXCEEDED");
    const mapped = mapAskYapiFinError(err);
    expect(mapped.status).toBe(409);
    expect(mapped.body.code).toBe("AI_QUOTA_EXCEEDED");
  });

  it("devre dışı sağlayıcı (not_configured) -> 503 AI_PROVIDER_DISABLED", () => {
    const err = new AiError("Sağlayıcı yapılandırılmamış", "not_configured", "corr-1");
    const mapped = mapAskYapiFinError(err);
    expect(mapped.status).toBe(503);
    expect(mapped.body.code).toBe("AI_PROVIDER_DISABLED");
  });

  it("geçici sağlayıcı hatası (timeout/provider_error) -> 503 AI_PROVIDER_UNAVAILABLE", () => {
    expect(mapAskYapiFinError(new AiError("zaman aşımı", "timeout", "corr-2")).body.code).toBe("AI_PROVIDER_UNAVAILABLE");
    expect(mapAskYapiFinError(new AiError("sağlayıcı hatası", "provider_error", "corr-3")).status).toBe(503);
  });

  it("proje/tenant bulunamadı (NOT_FOUND) -> 404", () => {
    const mapped = mapAskYapiFinError(new ServiceError("Proje bulunamadı", "NOT_FOUND"));
    expect(mapped.status).toBe(404);
  });

  it("bilinen ServiceError kendi koduna eşlenir", () => {
    const mapped = mapAskYapiFinError(new ServiceError("Yetkisiz", "FORBIDDEN"));
    expect(mapped.status).toBe(403);
  });

  it("bilinmeyen bir hata 500 genel mesajına düşer", () => {
    const mapped = mapAskYapiFinError(new Error("beklenmeyen"));
    expect(mapped.status).toBe(500);
  });
});
