import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { cleanDatabase, createOwnerOrg, createTestPlan } from "./helpers";
import { checkLimit, resolveEffectiveLimitMax } from "@/lib/entitlements/entitlement-service";
import { getActiveAddonQuota, grantUsageAddon, expireUsageAddonGrant } from "@/lib/entitlements/usage-addons";
import { getAiQuotaPeriodStart } from "@/lib/ai/quota-period";
import { requestAiCompletion } from "@/server/services/ai-usage-reporting-service";
import { createFakeAiProvider } from "@/lib/ai/providers/fake-provider";
import type { AiProvider } from "@/lib/ai/provider";
import { uploadAndExtractDocument } from "@/server/services/document-extraction-service";
import { emptyExtractionResult } from "@/server/services/document-extraction/provider";
import type { DocumentExtractionProvider, DocumentExtractionResult } from "@/server/services/document-extraction/provider";
import { ServiceError } from "@/server/services/errors";

/**
 * YF-803 — genelleştirilmiş kullanım/kota + ek (add-on/top-up) kota
 * mimarisinin davranış testleri. `tests/ai-usage-quota.test.ts` ve
 * `tests/ocr-usage-quota.test.ts` (YF-711/YF-817) AYNI DB-backed vitest
 * kalıbını izler. Bu dosya yalnızca YF-803'ün YENİ eklediği kısmı
 * (`UsageAddonGrant` + `resolveEffectiveLimitMax`) ve AI/OCR'ın bunu
 * otomatik olarak nasıl miras aldığını test eder — mevcut kota/rezervasyon
 * mekaniği (rezervasyon geri kazanımı, P2034 yeniden deneme vb.) o iki
 * dosyada zaten kapsanır, burada TEKRARLANMAZ.
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
function key(prefix = "idem") {
  seq += 1;
  return `${prefix}-${seq}-${Date.now()}`;
}

async function orgWithPlan(overrides: { limits?: Record<string, number | null>; capabilities?: Record<string, boolean> }) {
  const { owner, organizationId } = await createOwnerOrg();
  const plan = await createTestPlan({
    limits: overrides.limits ?? {},
    capabilities: overrides.capabilities ?? {},
  });
  await db.organization.update({ where: { id: organizationId }, data: { planId: plan.id } });
  return { owner, organizationId, plan };
}

function pdfBuffer(): Buffer {
  return Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.alloc(64, 0x20)]);
}

function countingOcrProvider(): { provider: DocumentExtractionProvider; callCount: () => number } {
  let calls = 0;
  return {
    provider: {
      name: "counting-fake",
      async extract(): Promise<DocumentExtractionResult> {
        calls += 1;
        return emptyExtractionResult();
      },
    },
    callCount: () => calls,
  };
}

describe("UsageAddonGrant — okuma (getActiveAddonQuota) ve yazma (grantUsageAddon) sınırı", () => {
  it("1) hiç bağış yoksa aktif ek kota 0'dır", async () => {
    const { organizationId } = await orgWithPlan({});
    const active = await getActiveAddonQuota(db, organizationId, "ai.monthly_quota");
    expect(active).toBe(0);
  });

  it("2) geçerli (süresiz) bir bağış toplama dahil olur", async () => {
    const { organizationId } = await orgWithPlan({});
    await grantUsageAddon(db, {
      organizationId,
      resource: "ai.monthly_quota",
      amount: 50,
      idempotencyKey: key(),
      source: "manual",
    });
    expect(await getActiveAddonQuota(db, organizationId, "ai.monthly_quota")).toBe(50);
  });

  it("3) birden çok geçerli bağış toplanır (kompozisyon)", async () => {
    const { organizationId } = await orgWithPlan({});
    await grantUsageAddon(db, { organizationId, resource: "ai.monthly_quota", amount: 30, idempotencyKey: key(), source: "manual" });
    await grantUsageAddon(db, { organizationId, resource: "ai.monthly_quota", amount: 20, idempotencyKey: key(), source: "manual" });
    expect(await getActiveAddonQuota(db, organizationId, "ai.monthly_quota")).toBe(50);
  });

  it("4) henüz başlamamış (validFrom gelecekte) bir bağış toplama dahil DEĞİLDİR", async () => {
    const { organizationId } = await orgWithPlan({});
    await grantUsageAddon(db, {
      organizationId,
      resource: "ai.monthly_quota",
      amount: 50,
      idempotencyKey: key(),
      source: "manual",
      validFrom: new Date(Date.now() + 24 * 60 * 60 * 1000),
    });
    expect(await getActiveAddonQuota(db, organizationId, "ai.monthly_quota")).toBe(0);
  });

  it("5) süresi dolmuş (validUntil geçmişte) bir bağış toplama dahil DEĞİLDİR", async () => {
    const { organizationId } = await orgWithPlan({});
    await grantUsageAddon(db, {
      organizationId,
      resource: "ai.monthly_quota",
      amount: 50,
      idempotencyKey: key(),
      source: "manual",
      validFrom: new Date(Date.now() - 60 * 60 * 1000),
      validUntil: new Date(Date.now() - 1000),
    });
    expect(await getActiveAddonQuota(db, organizationId, "ai.monthly_quota")).toBe(0);
  });

  it("6) expireUsageAddonGrant bir bağışı 'iptal eder' — satır silinmez, yalnızca validUntil çekilir", async () => {
    const { organizationId } = await orgWithPlan({});
    const grant = await grantUsageAddon(db, {
      organizationId,
      resource: "ai.monthly_quota",
      amount: 50,
      idempotencyKey: key(),
      source: "manual",
    });
    expect(await getActiveAddonQuota(db, organizationId, "ai.monthly_quota")).toBe(50);

    await expireUsageAddonGrant(db, organizationId, grant.id);

    expect(await getActiveAddonQuota(db, organizationId, "ai.monthly_quota")).toBe(0);
    const stillThere = await db.usageAddonGrant.findUniqueOrThrow({ where: { id: grant.id } });
    expect(stillThere.id).toBe(grant.id); // hard delete YOK — satır hâlâ var, yalnızca süresi dolmuş.
  });

  it("7) cross-tenant bir grantId ile expireUsageAddonGrant varlığı sızdırmadan NOT_FOUND fırlatır", async () => {
    const orgA = await orgWithPlan({});
    const orgB = await orgWithPlan({});
    const grant = await grantUsageAddon(db, {
      organizationId: orgA.organizationId,
      resource: "ai.monthly_quota",
      amount: 10,
      idempotencyKey: key(),
      source: "manual",
    });

    await expect(expireUsageAddonGrant(db, orgB.organizationId, grant.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
    // Org A'nın bağışı ETKİLENMEDİ.
    expect(await getActiveAddonQuota(db, orgA.organizationId, "ai.monthly_quota")).toBe(10);
  });

  it("8) bilinmeyen bir resource ile grantUsageAddon fail-closed reddeder", async () => {
    const { organizationId } = await orgWithPlan({});
    await expect(
      grantUsageAddon(db, {
        organizationId,
        resource: "sms.monthly_quota" as never,
        amount: 10,
        idempotencyKey: key(),
        source: "manual",
      }),
    ).rejects.toBeInstanceOf(ServiceError);
  });

  it("9) pozitif olmayan bir miktar (0 veya negatif) reddedilir", async () => {
    const { organizationId } = await orgWithPlan({});
    await expect(
      grantUsageAddon(db, { organizationId, resource: "ai.monthly_quota", amount: 0, idempotencyKey: key(), source: "manual" }),
    ).rejects.toBeInstanceOf(ServiceError);
    await expect(
      grantUsageAddon(db, { organizationId, resource: "ai.monthly_quota", amount: -5, idempotencyKey: key(), source: "manual" }),
    ).rejects.toBeInstanceOf(ServiceError);
  });

  it("10) aynı idempotencyKey ile tekrar çağrı YENİ bir satır oluşturmaz, mevcut bağışı döner (ardışık)", async () => {
    const { organizationId } = await orgWithPlan({});
    const sharedKey = key();

    const first = await grantUsageAddon(db, { organizationId, resource: "ai.monthly_quota", amount: 25, idempotencyKey: sharedKey, source: "manual" });
    const second = await grantUsageAddon(db, { organizationId, resource: "ai.monthly_quota", amount: 25, idempotencyKey: sharedKey, source: "manual" });

    expect(second.id).toBe(first.id);
    const rows = await db.usageAddonGrant.findMany({ where: { organizationId, idempotencyKey: sharedKey } });
    expect(rows).toHaveLength(1);
    expect(await getActiveAddonQuota(db, organizationId, "ai.monthly_quota")).toBe(25); // İKİ KEZ SAYILMADI.
  });

  it("11) aynı idempotencyKey ile YARIŞAN eşzamanlı çağrılar tek bir satır üretir (P2002 yarış çözümü)", async () => {
    const { organizationId } = await orgWithPlan({});
    const sharedKey = key();

    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        grantUsageAddon(db, { organizationId, resource: "ai.monthly_quota", amount: 10, idempotencyKey: sharedKey, source: "manual" }),
      ),
    );

    const distinctIds = new Set(results.map((r) => r.id));
    expect(distinctIds.size).toBe(1);
    const rows = await db.usageAddonGrant.findMany({ where: { organizationId, idempotencyKey: sharedKey } });
    expect(rows).toHaveLength(1);
    expect(await getActiveAddonQuota(db, organizationId, "ai.monthly_quota")).toBe(10); // 5 yarışan çağrı asla 50 üretmedi.
  });

  it("12) tenant izolasyonu: org A'nın bağışı org B'nin ek kotasını hiç etkilemez", async () => {
    const orgA = await orgWithPlan({});
    const orgB = await orgWithPlan({});
    await grantUsageAddon(db, { organizationId: orgA.organizationId, resource: "ai.monthly_quota", amount: 100, idempotencyKey: key(), source: "manual" });

    expect(await getActiveAddonQuota(db, orgA.organizationId, "ai.monthly_quota")).toBe(100);
    expect(await getActiveAddonQuota(db, orgB.organizationId, "ai.monthly_quota")).toBe(0);
  });
});

describe("resolveEffectiveLimitMax / checkLimit — dahil + ek kota kompozisyonu", () => {
  it("13) yalnızca dahil kota (ek bağış yok) — max === includedMax, addonMax === 0", async () => {
    const { organizationId } = await orgWithPlan({ limits: { "ai.monthly_quota": 10 }, capabilities: { "ai.features": true } });
    const limit = await checkLimit(db, organizationId, "ai.monthly_quota");
    expect(limit).toMatchObject({ max: 10, includedMax: 10, addonMax: 0, used: 0, canAddOne: true });
  });

  it("14) dahil kota sıfırken (Starter tipi) bir ek bağış tek başına kullanılabilir kota açar", async () => {
    const { organizationId } = await orgWithPlan({ limits: { "ai.monthly_quota": 0 }, capabilities: { "ai.features": true } });
    await grantUsageAddon(db, { organizationId, resource: "ai.monthly_quota", amount: 5, idempotencyKey: key(), source: "manual" });

    const limit = await checkLimit(db, organizationId, "ai.monthly_quota");
    expect(limit).toMatchObject({ max: 5, includedMax: 0, addonMax: 5, used: 0, canAddOne: true });
  });

  it("15) dahil + ek kota TOPLANIR (available = included + add-on - consumed)", async () => {
    const { organizationId } = await orgWithPlan({ limits: { "ai.monthly_quota": 10 }, capabilities: { "ai.features": true } });
    await grantUsageAddon(db, { organizationId, resource: "ai.monthly_quota", amount: 7, idempotencyKey: key(), source: "manual" });

    const limit = await checkLimit(db, organizationId, "ai.monthly_quota");
    expect(limit).toMatchObject({ max: 17, includedMax: 10, addonMax: 7, remaining: 17, canAddOne: true });
  });

  it("16) sınırsız (max=null) planda ek bağış sorgulanmaz/anlamsızdır — sınırsız sınırsız kalır", async () => {
    const { organizationId } = await orgWithPlan({ limits: { "ai.monthly_quota": null }, capabilities: { "ai.features": true } });
    await grantUsageAddon(db, { organizationId, resource: "ai.monthly_quota", amount: 999, idempotencyKey: key(), source: "manual" });

    const limit = await checkLimit(db, organizationId, "ai.monthly_quota");
    expect(limit).toMatchObject({ max: null, includedMax: null, addonMax: 0, remaining: null, canAddOne: true });
  });

  it("17) tam sınır tüketimi: included+addon kadar tüketim sonrası kota tam olarak tükenir, bir fazlası reddedilir", async () => {
    const { organizationId } = await orgWithPlan({ limits: { "ai.monthly_quota": 3 }, capabilities: { "ai.features": true } });
    await grantUsageAddon(db, { organizationId, resource: "ai.monthly_quota", amount: 2, idempotencyKey: key(), source: "manual" });
    // Etkin toplam = 5.

    const periodStart = getAiQuotaPeriodStart(new Date());
    await db.aiUsageLedger.create({
      data: {
        organizationId,
        periodStart,
        idempotencyKey: key("exact"),
        provider: "fake",
        status: "COMMITTED",
        reservedCredits: 5,
        consumedCredits: 5,
        reservationExpiresAt: new Date(),
        correlationId: key("corr"),
      },
    });

    const exact = await checkLimit(db, organizationId, "ai.monthly_quota");
    expect(exact).toMatchObject({ max: 5, used: 5, remaining: 0, isOverLimit: false, canAddOne: false });
  });

  it("18) uyarı eşiği (~%80) dahil+ek toplamına göre hesaplanır", async () => {
    const { owner, organizationId } = await orgWithPlan({ limits: { "ai.monthly_quota": 8 }, capabilities: { "ai.features": true } });
    await grantUsageAddon(db, { organizationId, resource: "ai.monthly_quota", amount: 2, idempotencyKey: key(), source: "manual" });
    // Etkin toplam = 10.

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

    const { getAiUsageSummary } = await import("@/server/services/ai-usage-service");
    const summary = await getAiUsageSummary(owner);
    expect(summary).toMatchObject({ monthlyQuota: 10, includedQuota: 8, addonQuota: 2, creditsUsed: 8, warningState: "WARNING" });
  });

  it("19) resolveEffectiveLimitMax zaten çözülmüş bir plan ile aynı sonucu üretir (ai-usage-reporting-service.ts atomik yolun kullandığı imza)", async () => {
    const { organizationId, plan } = await orgWithPlan({ limits: { "ocr.monthly_quota": 4 }, capabilities: { ocr: true } });
    await grantUsageAddon(db, { organizationId, resource: "ocr.monthly_quota", amount: 6, idempotencyKey: key(), source: "manual" });

    const effectivePlanShape = { id: plan.id, code: plan.code, name: plan.name, capabilities: plan.capabilities as Record<string, unknown>, limits: plan.limits as Record<string, unknown> };
    const result = await resolveEffectiveLimitMax(db, organizationId, "ocr.monthly_quota", effectivePlanShape);
    expect(result).toEqual({ max: 10, includedMax: 4, addonMax: 6 });
  });
});

describe("YF-803 — AI regresyonu: rezervasyon yolu ek kotayı atomik biçimde onurlandırır", () => {
  it("20) yalnızca ek bağış ile açılan kota (dahil=0) gerçek bir requestAiCompletion çağrısını başarıyla tamamlar", async () => {
    const { owner, organizationId } = await orgWithPlan({ limits: { "ai.monthly_quota": 0 }, capabilities: { "ai.features": true } });
    await grantUsageAddon(db, { organizationId, resource: "ai.monthly_quota", amount: 3, idempotencyKey: key(), source: "manual" });

    const outcome = await requestAiCompletion(owner, {
      provider: createFakeAiProvider(),
      idempotencyKey: key(),
      messages: [{ role: "user", content: "merhaba" }],
      promptVersion: "v1",
      maxOutputTokens: 10,
    });
    expect(outcome.status).toBe("completed");
  });

  it("21) dahil+ek kota tam tüketildikten sonra sağlayıcı ARTIK hiç çağrılmaz (sert kota, add-on dahil)", async () => {
    const { owner, organizationId } = await orgWithPlan({ limits: { "ai.monthly_quota": 0 }, capabilities: { "ai.features": true } });
    await grantUsageAddon(db, { organizationId, resource: "ai.monthly_quota", amount: 1, idempotencyKey: key(), source: "manual" });

    const first = await requestAiCompletion(owner, {
      provider: createFakeAiProvider(),
      idempotencyKey: key(),
      messages: [{ role: "user", content: "merhaba" }],
      promptVersion: "v1",
      maxOutputTokens: 10,
    });
    expect(first.status).toBe("completed");

    const complete = createFakeAiProvider();
    let called = false;
    const provider: AiProvider = {
      name: "fake",
      complete: async (req) => {
        called = true;
        return complete.complete(req);
      },
    };

    await expect(
      requestAiCompletion(owner, {
        provider,
        idempotencyKey: key(),
        messages: [{ role: "user", content: "merhaba" }],
        promptVersion: "v1",
        maxOutputTokens: 10,
      }),
    ).rejects.toMatchObject({ reasonCode: "AI_QUOTA_EXCEEDED" });
    expect(called).toBe(false); // hard-stop sonrası sağlayıcı HİÇ çağrılmadı.
  });

  it("22) eşzamanlı rezervasyonlar dahil+ek toplamını asla aşmaz (add-on'lu Serializable atomicity)", async () => {
    const { owner, organizationId } = await orgWithPlan({ limits: { "ai.monthly_quota": 1 }, capabilities: { "ai.features": true } });
    await grantUsageAddon(db, { organizationId, resource: "ai.monthly_quota", amount: 2, idempotencyKey: key(), source: "manual" });
    // Etkin toplam = 3.

    const attempts = Array.from({ length: 5 }, () =>
      requestAiCompletion(owner, {
        provider: createFakeAiProvider(),
        idempotencyKey: key(),
        messages: [{ role: "user", content: "merhaba" }],
        promptVersion: "v1",
        maxOutputTokens: 10,
      }),
    );
    const outcomes = await Promise.allSettled(attempts);

    expect(outcomes.filter((r) => r.status === "fulfilled")).toHaveLength(3);
    expect(outcomes.filter((r) => r.status === "rejected")).toHaveLength(2);

    const [committed, activeReserved] = await Promise.all([
      db.aiUsageLedger.aggregate({ where: { organizationId, status: "COMMITTED" }, _sum: { consumedCredits: true } }),
      db.aiUsageLedger.aggregate({ where: { organizationId, status: "RESERVED", reservationExpiresAt: { gt: new Date() } }, _sum: { reservedCredits: true } }),
    ]);
    const total = (committed._sum.consumedCredits ?? 0) + (activeReserved._sum.reservedCredits ?? 0);
    expect(total).toBeLessThanOrEqual(3);
  });
});

describe("YF-803 — OCR regresyonu: assertWithinLimitAtomic ek kotayı otomatik miras alır", () => {
  it("23) yalnızca ek bağış ile açılan OCR kotası (dahil=0) bir yüklemeyi başarıyla kabul eder", async () => {
    const { owner, organizationId } = await orgWithPlan({ limits: { "ocr.monthly_quota": 0 }, capabilities: { ocr: true } });
    await grantUsageAddon(db, { organizationId, resource: "ocr.monthly_quota", amount: 1, idempotencyKey: key(), source: "manual" });

    const record = await uploadAndExtractDocument(owner, { fileName: "f1.pdf", buffer: pdfBuffer() });
    expect(record.status).toBe("EXTRACTED");
  });

  it("24) dahil+ek OCR kotası tükendikten sonra sağlayıcı ARTIK hiç çağrılmaz", async () => {
    const { owner, organizationId } = await orgWithPlan({ limits: { "ocr.monthly_quota": 1 }, capabilities: { ocr: true } });
    await grantUsageAddon(db, { organizationId, resource: "ocr.monthly_quota", amount: 1, idempotencyKey: key(), source: "manual" });
    // Etkin toplam = 2.
    const { provider, callCount } = countingOcrProvider();

    await uploadAndExtractDocument(owner, { fileName: "f1.pdf", buffer: pdfBuffer() }, provider);
    await uploadAndExtractDocument(owner, { fileName: "f2.pdf", buffer: pdfBuffer() }, provider);
    expect(callCount()).toBe(2);

    await expect(
      uploadAndExtractDocument(owner, { fileName: "f3.pdf", buffer: pdfBuffer() }, provider),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(callCount()).toBe(2); // üçüncü çağrıda sağlayıcıya HİÇ ulaşılmadı.
  });
});

describe("YF-803 — dönem/geçerlilik semantiği", () => {
  it("25) bir bağış belirli bir geçerlilik penceresinden (ör. 'bu ay') sonra otomatik olarak toplamdan düşer — cron/reset job GEREKMEZ", async () => {
    const { organizationId } = await orgWithPlan({ limits: { "ai.monthly_quota": 0 }, capabilities: { "ai.features": true } });
    const periodStart = getAiQuotaPeriodStart(new Date());
    const nextPeriodStart = new Date(Date.UTC(periodStart.getUTCFullYear(), periodStart.getUTCMonth() + 1, 1));

    await grantUsageAddon(db, {
      organizationId,
      resource: "ai.monthly_quota",
      amount: 40,
      idempotencyKey: key(),
      source: "manual",
      validFrom: periodStart,
      validUntil: nextPeriodStart,
    });

    expect(await getActiveAddonQuota(db, organizationId, "ai.monthly_quota", new Date())).toBe(40);
    // Bir sonraki dönemin başında (dönem sınırında) bağış artık geçerli DEĞİLDİR.
    expect(await getActiveAddonQuota(db, organizationId, "ai.monthly_quota", nextPeriodStart)).toBe(0);
  });
});
