import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { cleanDatabase, createOrgUser, createOwnerOrg, createTestPlan } from "./helpers";
import { checkLimit } from "@/lib/entitlements/entitlement-service";
import { getCurrentPeriodAiCreditsUsed } from "@/lib/entitlements/ai-quota-usage";
import { getAiQuotaPeriodStart, getAiQuotaPeriodEnd } from "@/lib/ai/quota-period";
import { AI_CREDIT_POLICY } from "@/lib/ai/credits";
import { createFakeAiProvider } from "@/lib/ai/providers/fake-provider";
import type { AiProvider } from "@/lib/ai/provider";
import {
  requestAiCompletion,
  createEntitlementAiUsageReporter,
  AiEntitlementError,
} from "@/server/services/ai-usage-reporting-service";
import { getAiUsageSummary } from "@/server/services/ai-usage-service";

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
function key(prefix = "idem") {
  seq += 1;
  return `${prefix}-${seq}-${Date.now()}`;
}

/** Küçük, tahmin edilebilir bir rezervasyon (~1 kredi) üreten sabit mesaj/limit. */
const SMALL_MESSAGES = [{ role: "user" as const, content: "merhaba" }];
const SMALL_MAX_OUTPUT_TOKENS = 10;

async function aiEnabledOrg(quota: number | null) {
  const { owner, organizationId } = await createOwnerOrg();
  const plan = await createTestPlan({ limits: { "ai.monthly_quota": quota }, capabilities: { "ai.features": true } });
  await db.organization.update({ where: { id: organizationId }, data: { planId: plan.id } });
  return { owner, organizationId, plan };
}

async function aiDisabledOrg() {
  const { owner, organizationId } = await createOwnerOrg();
  const plan = await createTestPlan({ limits: { "ai.monthly_quota": 100 }, capabilities: { "ai.features": false } });
  await db.organization.update({ where: { id: organizationId }, data: { planId: plan.id } });
  return { owner, organizationId, plan };
}

function fakeProvider(overrides: Parameters<typeof createFakeAiProvider>[0] = {}) {
  return createFakeAiProvider(overrides);
}

describe("AI kota/rezervasyon servisi — yetenek ve kota kapıları", () => {
  it("1) ai.features kapalıysa AI_PLAN_REQUIRED ile reddeder, sağlayıcı hiç çağrılmaz", async () => {
    const { owner } = await aiDisabledOrg();
    const complete = createFakeAiProvider();
    let called = false;
    const provider: AiProvider = {
      name: "fake",
      complete: async (req) => {
        called = true;
        return complete.complete(req);
      },
    };

    let caught: unknown;
    try {
      await requestAiCompletion(owner, {
        provider,
        idempotencyKey: key(),
        messages: SMALL_MESSAGES,
        promptVersion: "v1",
        maxOutputTokens: SMALL_MAX_OUTPUT_TOKENS,
      });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(AiEntitlementError);
    expect((caught as AiEntitlementError).code).toBe("FORBIDDEN");
    expect((caught as AiEntitlementError).reasonCode).toBe("AI_PLAN_REQUIRED");
    expect(called).toBe(false);
  });

  it("2) plan içinde ve kota dahilindeyse başarılı olur, ledger COMMITTED olur", async () => {
    const { owner, organizationId } = await aiEnabledOrg(5);
    const outcome = await requestAiCompletion(owner, {
      provider: fakeProvider(),
      idempotencyKey: key(),
      messages: SMALL_MESSAGES,
      promptVersion: "v1",
      maxOutputTokens: SMALL_MAX_OUTPUT_TOKENS,
    });

    expect(outcome.status).toBe("completed");
    if (outcome.status !== "completed") throw new Error("unreachable");
    const row = await db.aiUsageLedger.findUnique({ where: { id: outcome.ledgerId } });
    expect(row?.status).toBe("COMMITTED");
    expect(row?.organizationId).toBe(organizationId);
  });

  it("3) kota tükendiyse AI_QUOTA_EXCEEDED ile reddeder, sağlayıcı hiç çağrılmaz", async () => {
    const { owner } = await aiEnabledOrg(1);
    await requestAiCompletion(owner, {
      provider: fakeProvider(),
      idempotencyKey: key(),
      messages: SMALL_MESSAGES,
      promptVersion: "v1",
      maxOutputTokens: SMALL_MAX_OUTPUT_TOKENS,
    });

    const complete = createFakeAiProvider();
    let called = false;
    const provider: AiProvider = {
      name: "fake",
      complete: async (req) => {
        called = true;
        return complete.complete(req);
      },
    };

    let caught: unknown;
    try {
      await requestAiCompletion(owner, {
        provider,
        idempotencyKey: key(),
        messages: SMALL_MESSAGES,
        promptVersion: "v1",
        maxOutputTokens: SMALL_MAX_OUTPUT_TOKENS,
      });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(AiEntitlementError);
    expect((caught as AiEntitlementError).code).toBe("CONFLICT");
    expect((caught as AiEntitlementError).reasonCode).toBe("AI_QUOTA_EXCEEDED");
    expect(called).toBe(false);
  });
});

describe("AI kota/rezervasyon servisi — eşzamanlılık ve idempotency", () => {
  it("4) son boş kota için yarışan iki farklı mantıksal istekten yalnızca biri başarılı olur (kota asla aşılmaz)", async () => {
    const { owner, organizationId } = await aiEnabledOrg(1);

    const [r1, r2] = await Promise.allSettled([
      requestAiCompletion(owner, {
        provider: fakeProvider(),
        idempotencyKey: key(),
        messages: SMALL_MESSAGES,
        promptVersion: "v1",
        maxOutputTokens: SMALL_MAX_OUTPUT_TOKENS,
      }),
      requestAiCompletion(owner, {
        provider: fakeProvider(),
        idempotencyKey: key(),
        messages: SMALL_MESSAGES,
        promptVersion: "v1",
        maxOutputTokens: SMALL_MAX_OUTPUT_TOKENS,
      }),
    ]);

    const outcomes = [r1, r2];
    expect(outcomes.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((r) => r.status === "rejected")).toHaveLength(1);
    const rejected = outcomes.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(rejected.reason).toBeInstanceOf(AiEntitlementError);
    expect((rejected.reason as AiEntitlementError).reasonCode).toBe("AI_QUOTA_EXCEEDED");

    const used = await getCurrentPeriodAiCreditsUsed(db, organizationId);
    expect(used).toBeLessThanOrEqual(1);
  });

  it("5) aynı idempotencyKey ile yarışan eşzamanlı isteklerden yalnızca biri ücretlendirilir", async () => {
    const { owner, organizationId } = await aiEnabledOrg(10);
    const sharedKey = key();

    const results = await Promise.allSettled([
      requestAiCompletion(owner, {
        provider: fakeProvider(),
        idempotencyKey: sharedKey,
        messages: SMALL_MESSAGES,
        promptVersion: "v1",
        maxOutputTokens: SMALL_MAX_OUTPUT_TOKENS,
      }),
      requestAiCompletion(owner, {
        provider: fakeProvider(),
        idempotencyKey: sharedKey,
        messages: SMALL_MESSAGES,
        promptVersion: "v1",
        maxOutputTokens: SMALL_MAX_OUTPUT_TOKENS,
      }),
    ]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    expect(fulfilled.length).toBeGreaterThanOrEqual(1);

    const rows = await db.aiUsageLedger.findMany({ where: { organizationId, idempotencyKey: sharedKey } });
    expect(rows).toHaveLength(1);
    const committedRows = rows.filter((r) => r.status === "COMMITTED");
    expect(committedRows.length).toBeLessThanOrEqual(1);
  });

  it("6) tamamlanmış (COMMITTED) bir isteğin tekrarı sağlayıcıyı hiç çağırmaz ve ikinci kez ücretlendirmez", async () => {
    const { owner } = await aiEnabledOrg(10);
    const sharedKey = key();
    const base = createFakeAiProvider();
    let callCount = 0;
    const provider: AiProvider = {
      name: "fake",
      complete: async (req) => {
        callCount += 1;
        return base.complete(req);
      },
    };

    const first = await requestAiCompletion(owner, {
      provider,
      idempotencyKey: sharedKey,
      messages: SMALL_MESSAGES,
      promptVersion: "v1",
      maxOutputTokens: SMALL_MAX_OUTPUT_TOKENS,
    });
    expect(first.status).toBe("completed");
    expect(callCount).toBe(1);

    const second = await requestAiCompletion(owner, {
      provider,
      idempotencyKey: sharedKey,
      messages: SMALL_MESSAGES,
      promptVersion: "v1",
      maxOutputTokens: SMALL_MAX_OUTPUT_TOKENS,
    });

    expect(second.status).toBe("already_processed");
    expect(callCount).toBe(1);
    if (second.status !== "already_processed") throw new Error("unreachable");
    expect((second as { result?: unknown }).result).toBeUndefined();
  });
});

describe("AI kota/rezervasyon servisi — sağlayıcı hatası ve sert kota sınırı", () => {
  it("7) sağlayıcı hatası rezervasyonu serbest bırakır, kota tekrar kullanılabilir olur", async () => {
    const { owner, organizationId } = await aiEnabledOrg(1);

    await expect(
      requestAiCompletion(owner, {
        provider: createFakeAiProvider({ behavior: "provider_error" }),
        idempotencyKey: key(),
        messages: SMALL_MESSAGES,
        promptVersion: "v1",
        maxOutputTokens: SMALL_MAX_OUTPUT_TOKENS,
      }),
    ).rejects.toMatchObject({ category: "provider_error" });

    const failedRow = await db.aiUsageLedger.findFirst({ where: { organizationId } });
    expect(failedRow?.status).toBe("FAILED");
    expect(failedRow?.consumedCredits).toBe(0);

    const used = await getCurrentPeriodAiCreditsUsed(db, organizationId);
    expect(used).toBe(0);

    const outcome = await requestAiCompletion(owner, {
      provider: fakeProvider(),
      idempotencyKey: key(),
      messages: SMALL_MESSAGES,
      promptVersion: "v1",
      maxOutputTokens: SMALL_MAX_OUTPUT_TOKENS,
    });
    expect(outcome.status).toBe("completed");
  });

  it("8) sert kota sınırı: gerçek kullanım rezervasyonu aşsa bile tüketim asla reservedCredits'i geçmez; gerçek token/maliyet gizlenmez", async () => {
    const { owner } = await aiEnabledOrg(100);

    const outcome = await requestAiCompletion(owner, {
      provider: createFakeAiProvider({ usage: { promptTokens: 500, completionTokens: 500, totalTokens: 1000 } }),
      idempotencyKey: key(),
      messages: SMALL_MESSAGES,
      promptVersion: "v1",
      maxOutputTokens: SMALL_MAX_OUTPUT_TOKENS, // küçük rezervasyon (~1 kredi) ama gerçek kullanım 1000 token
    });

    expect(outcome.status).toBe("completed");
    if (outcome.status !== "completed") throw new Error("unreachable");
    const row = await db.aiUsageLedger.findUniqueOrThrow({ where: { id: outcome.ledgerId } });

    expect(row.consumedCredits).toBe(row.reservedCredits);
    expect(row.consumedCreditsCapped).toBe(true);
    // Gerçek (uncapped) kullanım her zaman saklanır — kapatma yalnızca müşteri kredisini etkiler.
    expect(row.inputTokens).toBe(500);
    expect(row.outputTokens).toBe(500);
    expect(row.totalTokens).toBe(1000);
    // Maliyet yaklaşıklaması GERÇEK (uncapped) kullanımdan hesaplanır — kapatılmış kredi tutarından DEĞİL.
    const uncappedCredits = Math.ceil(1000 / AI_CREDIT_POLICY.tokensPerCredit);
    expect(row.estimatedCostUsd?.toString()).toBe(AI_CREDIT_POLICY.usdPerCredit.mul(uncappedCredits).toString());
    expect(row.actualCostUsd).toBeNull();
  });
});

describe("AI kota/rezervasyon servisi — bayat (stale) rezervasyon geri kazanımı", () => {
  it("9) süresi dolmuş RESERVED satır kota toplamından hariç tutulur", async () => {
    const { owner, organizationId } = await aiEnabledOrg(1);
    const periodStart = getAiQuotaPeriodStart(new Date());

    await db.aiUsageLedger.create({
      data: {
        organizationId,
        periodStart,
        idempotencyKey: key("stale"),
        provider: "fake",
        status: "RESERVED",
        reservedCredits: 1,
        reservationExpiresAt: new Date(Date.now() - 60_000), // geçmişte
        correlationId: key("corr"),
      },
    });

    const used = await getCurrentPeriodAiCreditsUsed(db, organizationId);
    expect(used).toBe(0);

    const outcome = await requestAiCompletion(owner, {
      provider: fakeProvider(),
      idempotencyKey: key(),
      messages: SMALL_MESSAGES,
      promptVersion: "v1",
      maxOutputTokens: SMALL_MAX_OUTPUT_TOKENS,
    });
    expect(outcome.status).toBe("completed");
  });

  it("10) aynı idempotencyKey ile retry bayat satırı denetlenebilir biçimde geri kazanır — tek satır, tek ücretlendirme", async () => {
    const { owner, organizationId } = await aiEnabledOrg(5);
    const periodStart = getAiQuotaPeriodStart(new Date());
    const sharedKey = key();
    const originalCreatedAt = new Date(Date.now() - 10 * 60 * 1000);

    const stale = await db.aiUsageLedger.create({
      data: {
        organizationId,
        periodStart,
        idempotencyKey: sharedKey,
        provider: "fake",
        status: "RESERVED",
        reservedCredits: 1,
        reservationExpiresAt: new Date(Date.now() - 60_000),
        correlationId: key("corr"),
        attemptCount: 1,
        createdAt: originalCreatedAt,
      },
    });

    const outcome = await requestAiCompletion(owner, {
      provider: fakeProvider(),
      idempotencyKey: sharedKey,
      messages: SMALL_MESSAGES,
      promptVersion: "v1",
      maxOutputTokens: SMALL_MAX_OUTPUT_TOKENS,
    });
    expect(outcome.status).toBe("completed");

    const rows = await db.aiUsageLedger.findMany({ where: { organizationId, idempotencyKey: sharedKey } });
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row.id).toBe(stale.id);
    expect(row.attemptCount).toBe(2);
    expect(row.createdAt.getTime()).toBe(originalCreatedAt.getTime());
    expect(row.status).toBe("COMMITTED");

    const audit = await db.auditLog.findFirst({
      where: { action: "ai_usage.reservation_recycled", entityId: stale.id, organizationId },
    });
    expect(audit).not.toBeNull();
  });

  it("11) geç kalan bir finalize çağrısı (eski attemptCount) geri kazanılmış rezervasyonu bozamaz", async () => {
    const { owner, organizationId } = await aiEnabledOrg(5);
    const sharedKey = key();

    const staleReporter = createEntitlementAiUsageReporter(owner);
    const firstDecision = await staleReporter.checkQuota(organizationId, {
      idempotencyKey: sharedKey,
      correlationId: key("corr"),
      provider: "fake",
      model: null,
      reservationCreditsEstimate: 1,
    });
    expect(firstDecision.allowed).toBe(true);
    const staleReservationId = staleReporter.getReservationId();
    expect(staleReservationId).toBeTruthy();

    // Çöküş simülasyonu: rezervasyonu bayatlat.
    await db.aiUsageLedger.update({
      where: { id: staleReservationId! },
      data: { reservationExpiresAt: new Date(Date.now() - 60_000) },
    });

    const recoveringReporter = createEntitlementAiUsageReporter(owner);
    const recoverDecision = await recoveringReporter.checkQuota(organizationId, {
      idempotencyKey: sharedKey,
      correlationId: key("corr"),
      provider: "fake",
      model: null,
      reservationCreditsEstimate: 1,
    });
    expect(recoverDecision.allowed).toBe(true);
    expect(recoveringReporter.getReservationId()).toBe(staleReservationId);

    const beforeLateFinalize = await db.aiUsageLedger.findUniqueOrThrow({ where: { id: staleReservationId! } });
    expect(beforeLateFinalize.attemptCount).toBe(2);

    // Geç kalan finalize: eski (çökmüş) reporter'ın kapanışı hâlâ attemptCount=1 tutuyor.
    await staleReporter.reportUsage({
      organizationId,
      provider: "fake",
      correlationId: key("corr"),
      idempotencyKey: sharedKey,
      status: "success",
      usage: { promptTokens: 10, completionTokens: 10, totalTokens: 20 },
    });

    const afterLateFinalize = await db.aiUsageLedger.findUniqueOrThrow({ where: { id: staleReservationId! } });
    expect(afterLateFinalize.attemptCount).toBe(2);
    expect(afterLateFinalize.status).toBe("RESERVED"); // geri kazanılmış deneme hâlâ RESERVED — geç finalize tarafından DOKUNULMADI.
    expect(afterLateFinalize.consumedCredits).toBe(0);
  });
});

describe("AI kota/rezervasyon servisi — tenant izolasyonu ve yetki", () => {
  it("12) kullanım kaydı yalnızca kendi organizasyonu altında görünür; farklı rol AI kullanım özetini göremez", async () => {
    const orgA = await aiEnabledOrg(5);
    const orgB = await aiEnabledOrg(5);

    await requestAiCompletion(orgA.owner, {
      provider: fakeProvider(),
      idempotencyKey: key(),
      messages: SMALL_MESSAGES,
      promptVersion: "v1",
      maxOutputTokens: SMALL_MAX_OUTPUT_TOKENS,
    });

    const usedA = await getCurrentPeriodAiCreditsUsed(db, orgA.organizationId);
    const usedB = await getCurrentPeriodAiCreditsUsed(db, orgB.organizationId);
    expect(usedA).toBeGreaterThan(0);
    expect(usedB).toBe(0);

    const summaryB = await getAiUsageSummary(orgB.owner);
    expect(summaryB.creditsUsed).toBe(0);

    const financeUser = await createOrgUser(orgA.organizationId, "FINANCE");
    await expect(getAiUsageSummary(financeUser)).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});

describe("AI kota/rezervasyon servisi — dönem sınırı", () => {
  it("13) UTC takvim ayı sınırları deterministiktir (yıl/ay dönüşümü dahil)", () => {
    const decEnd = new Date("2026-12-31T23:59:59.999Z");
    const start = getAiQuotaPeriodStart(decEnd);
    expect(start.toISOString()).toBe("2026-12-01T00:00:00.000Z");
    const end = getAiQuotaPeriodEnd(start);
    expect(end.toISOString()).toBe("2027-01-01T00:00:00.000Z");

    const janMid = new Date("2027-01-15T10:00:00.000Z");
    expect(getAiQuotaPeriodStart(janMid).toISOString()).toBe("2027-01-01T00:00:00.000Z");
  });

  it("14) yeni dönem geçmişi silmeden taze kota ile başlar", async () => {
    const { organizationId } = await aiEnabledOrg(1);
    const currentPeriodStart = getAiQuotaPeriodStart(new Date());
    const previousPeriodStart = new Date(
      Date.UTC(currentPeriodStart.getUTCFullYear(), currentPeriodStart.getUTCMonth() - 1, 1),
    );

    const priorRow = await db.aiUsageLedger.create({
      data: {
        organizationId,
        periodStart: previousPeriodStart,
        idempotencyKey: key("prior"),
        provider: "fake",
        status: "COMMITTED",
        reservedCredits: 1,
        consumedCredits: 1,
        reservationExpiresAt: new Date(Date.now() - 60_000),
        correlationId: key("corr"),
      },
    });

    const usedThisPeriod = await getCurrentPeriodAiCreditsUsed(db, organizationId);
    expect(usedThisPeriod).toBe(0);

    const limit = await checkLimit(db, organizationId, "ai.monthly_quota");
    expect(limit.used).toBe(0);
    expect(limit.max).toBe(1);

    const stillThere = await db.aiUsageLedger.findUniqueOrThrow({ where: { id: priorRow.id } });
    expect(stillThere.consumedCredits).toBe(1);
  });
});

describe("AI kota/rezervasyon servisi — plan düşürme/yükseltme", () => {
  it("15) düşürme yeni çağrıları engeller ama geçmişi korur; yükseltme özel bir kod yolu olmadan erişimi geri açar", async () => {
    const { owner, organizationId } = await aiEnabledOrg(5);

    const first = await requestAiCompletion(owner, {
      provider: fakeProvider(),
      idempotencyKey: key(),
      messages: SMALL_MESSAGES,
      promptVersion: "v1",
      maxOutputTokens: SMALL_MAX_OUTPUT_TOKENS,
    });
    expect(first.status).toBe("completed");
    if (first.status !== "completed") throw new Error("unreachable");

    // Düşürme: kota 0'a düşer (yetenek hâlâ açık — AI_QUOTA_EXCEEDED yolunu test eder).
    const strictPlan = await createTestPlan({ limits: { "ai.monthly_quota": 0 }, capabilities: { "ai.features": true } });
    await db.organization.update({ where: { id: organizationId }, data: { planId: strictPlan.id } });

    await expect(
      requestAiCompletion(owner, {
        provider: fakeProvider(),
        idempotencyKey: key(),
        messages: SMALL_MESSAGES,
        promptVersion: "v1",
        maxOutputTokens: SMALL_MAX_OUTPUT_TOKENS,
      }),
    ).rejects.toMatchObject({ code: "CONFLICT", reasonCode: "AI_QUOTA_EXCEEDED" });

    const historyRow = await db.aiUsageLedger.findUniqueOrThrow({ where: { id: first.ledgerId } });
    expect(historyRow.status).toBe("COMMITTED");

    // Yükseltme: cömert bir plana geç — özel bir "yükseltme" kod yolu olmadan aynı çağrı başarılı olur.
    const generousPlan = await createTestPlan({ limits: { "ai.monthly_quota": 10 }, capabilities: { "ai.features": true } });
    await db.organization.update({ where: { id: organizationId }, data: { planId: generousPlan.id } });

    const afterUpgrade = await requestAiCompletion(owner, {
      provider: fakeProvider(),
      idempotencyKey: key(),
      messages: SMALL_MESSAGES,
      promptVersion: "v1",
      maxOutputTokens: SMALL_MAX_OUTPUT_TOKENS,
    });
    expect(afterUpgrade.status).toBe("completed");
  });
});

describe("AI kota/rezervasyon servisi — güvenlik/gizlilik ve maliyet muhasebesi", () => {
  it("16) ledger asla ham prompt/context içermez", async () => {
    const { owner } = await aiEnabledOrg(5);
    const secret = "ÇOK-GİZLİ-FİNANSAL-TUTAR-999999";

    const outcome = await requestAiCompletion(owner, {
      provider: fakeProvider(),
      idempotencyKey: key(),
      messages: [{ role: "user", content: `İçinde ${secret} olan bir prompt` }],
      promptVersion: "v1",
      maxOutputTokens: SMALL_MAX_OUTPUT_TOKENS,
    });
    expect(outcome.status).toBe("completed");
    if (outcome.status !== "completed") throw new Error("unreachable");

    const row = await db.aiUsageLedger.findUniqueOrThrow({ where: { id: outcome.ledgerId } });
    expect(JSON.stringify(row)).not.toContain(secret);
  });

  it("17) kalan kredi/usagePercentage hesabı doğrudur; %80 uyarı, %100 tükenme eşiği", async () => {
    const { owner, organizationId } = await aiEnabledOrg(10);
    const periodStart = getAiQuotaPeriodStart(new Date());

    await db.aiUsageLedger.create({
      data: {
        organizationId,
        periodStart,
        idempotencyKey: key(),
        provider: "fake",
        status: "COMMITTED",
        reservedCredits: 8,
        consumedCredits: 8,
        reservationExpiresAt: new Date(),
        correlationId: key("corr"),
      },
    });

    const at80 = await getAiUsageSummary(owner);
    expect(at80.creditsUsed).toBe(8);
    expect(at80.creditsRemaining).toBe(2);
    expect(at80.usagePercentage).toBe("80.00");
    expect(at80.warningState).toBe("WARNING");

    await db.aiUsageLedger.create({
      data: {
        organizationId,
        periodStart,
        idempotencyKey: key(),
        provider: "fake",
        status: "COMMITTED",
        reservedCredits: 2,
        consumedCredits: 2,
        reservationExpiresAt: new Date(),
        correlationId: key("corr"),
      },
    });

    const at100 = await getAiUsageSummary(owner);
    expect(at100.creditsUsed).toBe(10);
    expect(at100.creditsRemaining).toBe(0);
    expect(at100.usagePercentage).toBe("100.00");
    expect(at100.warningState).toBe("EXHAUSTED");
  });

  it("18) plan atanmamış/bilinmeyen organizasyon fail-closed davranır", async () => {
    const { owner, organizationId } = await createOwnerOrg();
    await db.organization.update({ where: { id: organizationId }, data: { planId: null } });

    const summary = await getAiUsageSummary(owner);
    expect(summary.enabled).toBe(false);
    expect(summary.monthlyQuota).toBe(0);
    expect(summary.warningState).toBe("EXHAUSTED");

    await expect(
      requestAiCompletion(owner, {
        provider: fakeProvider(),
        idempotencyKey: key(),
        messages: SMALL_MESSAGES,
        promptVersion: "v1",
        maxOutputTokens: SMALL_MAX_OUTPUT_TOKENS,
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN", reasonCode: "AI_PLAN_REQUIRED" });
  });

  it("19) maliyet muhasebesi Decimal ile yapılır, gerçek sağlayıcı olmadığından actualCostUsd null kalır", async () => {
    const { owner } = await aiEnabledOrg(50);

    const outcome = await requestAiCompletion(owner, {
      provider: createFakeAiProvider({ usage: { promptTokens: 125, completionTokens: 125, totalTokens: 250 } }),
      idempotencyKey: key(),
      messages: SMALL_MESSAGES,
      promptVersion: "v1",
      maxOutputTokens: 400, // reservedCredits yeterince büyük ki 250 token capped OLMASIN
    });
    expect(outcome.status).toBe("completed");
    if (outcome.status !== "completed") throw new Error("unreachable");

    const row = await db.aiUsageLedger.findUniqueOrThrow({ where: { id: outcome.ledgerId } });
    expect(row.consumedCreditsCapped).toBe(false);
    const expectedCredits = Math.ceil(250 / AI_CREDIT_POLICY.tokensPerCredit);
    expect(row.consumedCredits).toBe(expectedCredits);
    expect(row.estimatedCostUsd).toBeInstanceOf(Prisma.Decimal);
    expect((row.estimatedCostUsd as Prisma.Decimal).equals(AI_CREDIT_POLICY.usdPerCredit.mul(expectedCredits))).toBe(true);
    expect(row.actualCostUsd).toBeNull();
  });
});
