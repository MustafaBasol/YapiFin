import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { cleanDatabase, createOwnerOrg, createTestPlan, setOrganizationPlan } from "./helpers";
import { checkLimit } from "@/lib/entitlements/entitlement-service";
import { getCurrentPeriodOcrExtractionsUsed } from "@/lib/entitlements/ocr-quota-usage";
import { getAiQuotaPeriodStart } from "@/lib/ai/quota-period";
import { uploadAndExtractDocument } from "@/server/services/document-extraction-service";
import { emptyExtractionResult } from "@/server/services/document-extraction/provider";
import type { DocumentExtractionProvider, DocumentExtractionResult } from "@/server/services/document-extraction/provider";

/**
 * YF-817 — OCR aylık kota (`ocr.monthly_quota`) davranış testleri.
 *
 * AI kota testleriyle (tests/ai-usage-quota.test.ts) AYNI DB-backed vitest
 * kalıbını izler. OCR kotası AI'nın rezervasyon defterinden (AiUsageLedger)
 * FARKLI olarak mevcut `DocumentExtraction` kayıtlarını sayar (bkz.
 * lib/entitlements/ocr-quota-usage.ts) ve `assertWithinLimitAtomic`
 * (createProject/acceptInvitation ile AYNI desen) üzerinden
 * `uploadAndExtractDocument` içinde uygulanır.
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

function pdfBuffer(): Buffer {
  return Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.alloc(64, 0x20)]);
}

async function ocrEnabledOrg(quota: number | null) {
  const { owner, organizationId } = await createOwnerOrg();
  const plan = await createTestPlan({ limits: { "ocr.monthly_quota": quota }, capabilities: { ocr: true } });
  await db.organization.update({ where: { id: organizationId }, data: { planId: plan.id } });
  return { owner, organizationId, plan };
}

function countingProvider(): { provider: DocumentExtractionProvider; callCount: () => number } {
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

describe("OCR aylık kota servisi — kota kapıları", () => {
  it("1) kota dahilindeyse yükleme başarılı olur ve kullanım sayacı gerçek DB kaydını yansıtır", async () => {
    const { owner, organizationId } = await ocrEnabledOrg(3);

    await uploadAndExtractDocument(owner, { fileName: "f1.pdf", buffer: pdfBuffer() });
    await uploadAndExtractDocument(owner, { fileName: "f2.pdf", buffer: pdfBuffer() });

    const used = await getCurrentPeriodOcrExtractionsUsed(db, organizationId);
    expect(used).toBe(2);
    const limit = await checkLimit(db, organizationId, "ocr.monthly_quota");
    expect(limit).toMatchObject({ max: 3, used: 2, canAddOne: true });
  });

  it("2) kota tam sınırdayken bir yükleme daha kabul eder, ardından kota tükenir ve bir sonraki reddedilir; reddedilende sağlayıcı hiç çağrılmaz", async () => {
    const { owner } = await ocrEnabledOrg(1);
    const { provider, callCount } = countingProvider();

    const record = await uploadAndExtractDocument(owner, { fileName: "f1.pdf", buffer: pdfBuffer() }, provider);
    expect(record.status).toBe("EXTRACTED");
    expect(callCount()).toBe(1);

    await expect(
      uploadAndExtractDocument(owner, { fileName: "f2.pdf", buffer: pdfBuffer() }, provider),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    // Reddedilen istek için sağlayıcı ASLA çağrılmadı — yalnızca ilk (başarılı) çağrıdan gelen 1 sayım var.
    expect(callCount()).toBe(1);
    expect(await db.documentExtraction.count()).toBe(1);
  });

  it("3) sınırsız (max=null) kotada art arda birçok yükleme her zaman izin verir", async () => {
    const { owner, organizationId } = await ocrEnabledOrg(null);

    for (let i = 0; i < 5; i += 1) {
      await uploadAndExtractDocument(owner, { fileName: `f${i}.pdf`, buffer: pdfBuffer() });
    }

    const limit = await checkLimit(db, organizationId, "ocr.monthly_quota");
    expect(limit).toMatchObject({ max: null, used: 5, canAddOne: true, remaining: null });
  });

  it("4) plan verisinde ocr.monthly_quota anahtarı hiç yoksa fail-closed reddedilir (max=0), sağlayıcı çağrılmaz", async () => {
    const { owner, organizationId } = await createOwnerOrg();
    // Kasıtlı olarak "ocr.monthly_quota" anahtarını İÇERMEYEN bir plan — yalnızca capability açık.
    const plan = await createTestPlan({ limits: {}, capabilities: { ocr: true } });
    await db.organization.update({ where: { id: organizationId }, data: { planId: plan.id } });

    const limit = await checkLimit(db, organizationId, "ocr.monthly_quota");
    expect(limit).toMatchObject({ max: 0, canAddOne: false });

    const { provider, callCount } = countingProvider();
    await expect(
      uploadAndExtractDocument(owner, { fileName: "f1.pdf", buffer: pdfBuffer() }, provider),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(callCount()).toBe(0);
  });

  it("5) bozuk (negatif) bir limit değeri de fail-closed reddedilir (max=0)", async () => {
    const { organizationId } = await createOwnerOrg();
    const plan = await createTestPlan({
      limits: { "ocr.monthly_quota": -5 as unknown as number },
      capabilities: { ocr: true },
    });
    await db.organization.update({ where: { id: organizationId }, data: { planId: plan.id } });

    const limit = await checkLimit(db, organizationId, "ocr.monthly_quota");
    expect(limit).toMatchObject({ max: 0, canAddOne: false });
  });

  it("6) Starter'da 'ocr' capability kapalıysa kota ne olursa olsun yükleme reddedilir (regresyon) — sağlayıcı hiç çağrılmaz", async () => {
    const { owner, organizationId } = await createOwnerOrg();
    // Kota AÇIKÇA cömert (100) ama capability kapalı — capability kapısı KOTADAN ÖNCE çalışmalı.
    const plan = await createTestPlan({ limits: { "ocr.monthly_quota": 100 }, capabilities: { ocr: false } });
    await db.organization.update({ where: { id: organizationId }, data: { planId: plan.id } });

    const { provider, callCount } = countingProvider();
    await expect(
      uploadAndExtractDocument(owner, { fileName: "f1.pdf", buffer: pdfBuffer() }, provider),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(callCount()).toBe(0);

    // Gerçek STARTER planında da aynı regresyon korunur (bkz. tests/entitlements.test.ts).
    await setOrganizationPlan(organizationId, "STARTER");
    await expect(
      uploadAndExtractDocument(owner, { fileName: "f2.pdf", buffer: pdfBuffer() }, provider),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(callCount()).toBe(0);
  });
});

describe("OCR aylık kota servisi — kullanım muhasebesi (bypass önleme)", () => {
  it("7) sağlayıcı hata fırlatsa bile (FAILED) o deneme kotaya dahildir — kasıtlı bozuk dosyalarla kota bedavaya atlatılamaz", async () => {
    const { owner, organizationId } = await ocrEnabledOrg(1);
    const failing: DocumentExtractionProvider = {
      name: "failing",
      async extract() {
        throw new Error("saglayici hatasi");
      },
    };

    const record = await uploadAndExtractDocument(owner, { fileName: "f1.pdf", buffer: pdfBuffer() }, failing);
    expect(record.status).toBe("FAILED");

    const used = await getCurrentPeriodOcrExtractionsUsed(db, organizationId);
    expect(used).toBe(1);

    await expect(
      uploadAndExtractDocument(owner, { fileName: "f2.pdf", buffer: pdfBuffer() }, failing),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("8) PENDING durumunda kalan (hiç tamamlanmamış) bir kayıt kotaya dahil edilmez", async () => {
    const { owner, organizationId } = await ocrEnabledOrg(1);
    const record = await uploadAndExtractDocument(owner, { fileName: "f1.pdf", buffer: pdfBuffer() });
    expect(record.status).toBe("EXTRACTED");

    // Çöküş simülasyonu: kayıt PENDING'e geri alınır (sağlayıcı çağrısı hiç tamamlanmamış gibi).
    await db.documentExtraction.update({ where: { id: record.id }, data: { status: "PENDING" } });

    const used = await getCurrentPeriodOcrExtractionsUsed(db, organizationId);
    expect(used).toBe(0);

    // Kota tekrar kullanılabilir hale gelir.
    const retry = await uploadAndExtractDocument(owner, { fileName: "f2.pdf", buffer: pdfBuffer() });
    expect(retry.status).toBe("EXTRACTED");
  });
});

describe("OCR aylık kota servisi — dönem sınırı", () => {
  it("9) önceki UTC takvim ayındaki kullanım bu ayki kotaya sayılmaz", async () => {
    const { owner, organizationId } = await ocrEnabledOrg(1);
    const currentPeriodStart = getAiQuotaPeriodStart(new Date());
    const previousMonth = new Date(
      Date.UTC(currentPeriodStart.getUTCFullYear(), currentPeriodStart.getUTCMonth() - 1, 15),
    );

    await db.documentExtraction.create({
      data: {
        organizationId,
        uploadedById: owner.id,
        fileName: "gecen-ay.pdf",
        mimeType: "application/pdf",
        sizeBytes: 10,
        fileData: Buffer.from("x"),
        status: "EXTRACTED",
        createdAt: previousMonth,
      },
    });

    const used = await getCurrentPeriodOcrExtractionsUsed(db, organizationId);
    expect(used).toBe(0);

    // Bu ayki kota (1) hâlâ tamamen kullanılabilir.
    const record = await uploadAndExtractDocument(owner, { fileName: "bu-ay.pdf", buffer: pdfBuffer() });
    expect(record.status).toBe("EXTRACTED");
  });
});

describe("OCR aylık kota servisi — tenant izolasyonu", () => {
  it("10) org A'nın OCR kullanımı org B'nin kotasını/sayacını hiç etkilemez", async () => {
    const orgA = await ocrEnabledOrg(2);
    const orgB = await ocrEnabledOrg(2);

    await uploadAndExtractDocument(orgA.owner, { fileName: "a1.pdf", buffer: pdfBuffer() });
    await uploadAndExtractDocument(orgA.owner, { fileName: "a2.pdf", buffer: pdfBuffer() });

    const usedA = await getCurrentPeriodOcrExtractionsUsed(db, orgA.organizationId);
    const usedB = await getCurrentPeriodOcrExtractionsUsed(db, orgB.organizationId);
    expect(usedA).toBe(2);
    expect(usedB).toBe(0);

    // Org A kotası dolu olsa da org B hâlâ tamamen kullanılabilir.
    const recordB = await uploadAndExtractDocument(orgB.owner, { fileName: "b1.pdf", buffer: pdfBuffer() });
    expect(recordB.status).toBe("EXTRACTED");
  });
});

describe("OCR aylık kota servisi — eşzamanlılık", () => {
  it("11) son boş kota koltuğu için yarışan iki eşzamanlı yükleme isteğinden yalnızca biri başarılı olur, kota asla aşılmaz", async () => {
    const { owner, organizationId } = await ocrEnabledOrg(1);

    const [r1, r2] = await Promise.allSettled([
      uploadAndExtractDocument(owner, { fileName: "race1.pdf", buffer: pdfBuffer() }),
      uploadAndExtractDocument(owner, { fileName: "race2.pdf", buffer: pdfBuffer() }),
    ]);
    const outcomes = [r1, r2];

    expect(outcomes.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = outcomes.filter((r) => r.status === "rejected");
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({ code: "CONFLICT" });

    const finalCount = await db.documentExtraction.count({ where: { organizationId } });
    expect(finalCount).toBe(1);
    const used = await getCurrentPeriodOcrExtractionsUsed(db, organizationId);
    expect(used).toBeLessThanOrEqual(1);
  });

  it("12) son N boş koltuk için yarışan N+2 istekten en fazla N tanesi başarılı olur (organizasyon kilidi doğru serileştirir)", async () => {
    const quota = 3;
    const { owner, organizationId } = await ocrEnabledOrg(quota);

    const attempts = Array.from({ length: quota + 2 }, (_, i) =>
      uploadAndExtractDocument(owner, { fileName: `race-${i}.pdf`, buffer: pdfBuffer() }),
    );
    const outcomes = await Promise.allSettled(attempts);

    const fulfilled = outcomes.filter((r) => r.status === "fulfilled");
    const rejected = outcomes.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
    expect(fulfilled).toHaveLength(quota);
    expect(rejected).toHaveLength(2);
    for (const r of rejected) {
      expect(r.reason).toMatchObject({ code: "CONFLICT" });
    }

    const used = await getCurrentPeriodOcrExtractionsUsed(db, organizationId);
    expect(used).toBeLessThanOrEqual(quota);
  });

  it("13) iki farklı organizasyonun eşzamanlı son-kota istekleri birbirini gereksiz yere bloklamaz", async () => {
    const orgA = await ocrEnabledOrg(1);
    const orgB = await ocrEnabledOrg(1);

    const [resultA, resultB] = await Promise.all([
      uploadAndExtractDocument(orgA.owner, { fileName: "a.pdf", buffer: pdfBuffer() }),
      uploadAndExtractDocument(orgB.owner, { fileName: "b.pdf", buffer: pdfBuffer() }),
    ]);

    expect(resultA.status).toBe("EXTRACTED");
    expect(resultB.status).toBe("EXTRACTED");
  });
});

describe("OCR aylık kota servisi — plan düşürme/yükseltme", () => {
  it("14) düşürme yeni yüklemeleri engeller ama geçmiş taslakları korur; yükseltme özel bir kod yolu olmadan erişimi geri açar", async () => {
    const { owner, organizationId } = await ocrEnabledOrg(5);

    const first = await uploadAndExtractDocument(owner, { fileName: "f1.pdf", buffer: pdfBuffer() });
    expect(first.status).toBe("EXTRACTED");

    const strictPlan = await createTestPlan({ limits: { "ocr.monthly_quota": 0 }, capabilities: { ocr: true } });
    await db.organization.update({ where: { id: organizationId }, data: { planId: strictPlan.id } });

    await expect(
      uploadAndExtractDocument(owner, { fileName: "f2.pdf", buffer: pdfBuffer() }),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    // Geçmiş taslak hâlâ erişilebilir/değişmemiş.
    const stillThere = await db.documentExtraction.findUniqueOrThrow({ where: { id: first.id } });
    expect(stillThere.status).toBe("EXTRACTED");

    const generousPlan = await createTestPlan({ limits: { "ocr.monthly_quota": 10 }, capabilities: { ocr: true } });
    await db.organization.update({ where: { id: organizationId }, data: { planId: generousPlan.id } });

    const afterUpgrade = await uploadAndExtractDocument(owner, { fileName: "f3.pdf", buffer: pdfBuffer() });
    expect(afterUpgrade.status).toBe("EXTRACTED");
  });
});

describe("OCR aylık kota servisi — YF-805 plan karşılaştırma uyumluluğu", () => {
  it("15) getOrganizationLimitSummary tüm LIMIT_IDS için (ocr.monthly_quota dahil) bir sonuç döner, hiçbiri undefined kalmaz", async () => {
    const { organizationId } = await ocrEnabledOrg(7);
    const { getOrganizationLimitSummary } = await import("@/lib/entitlements/entitlement-service");
    const summary = await getOrganizationLimitSummary(db, organizationId);

    expect(summary["ocr.monthly_quota"]).toBeDefined();
    expect(summary["ocr.monthly_quota"]).toMatchObject({ max: 7, used: 0 });
  });
});
