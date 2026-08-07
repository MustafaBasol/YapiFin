import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import * as auditModule from "@/lib/audit";
import { cleanDatabase, createOwnerOrg, createOrgUser } from "./helpers";
import { createProject, assignProjectMember } from "@/server/services/project-service";
import {
  uploadAndExtractDocument,
  getDocumentExtractionForUser,
  confirmDocumentExtraction,
} from "@/server/services/document-extraction-service";
import { emptyExtractionResult } from "@/server/services/document-extraction/provider";
import { confirmDocumentExtractionSchema } from "@/lib/validation/document-extraction";
import type { DocumentExtractionProvider, DocumentExtractionResult } from "@/server/services/document-extraction/provider";
import type { SessionUser } from "@/lib/auth/session";

beforeAll(async () => {
  await cleanDatabase();
});
afterEach(async () => {
  vi.restoreAllMocks();
  await cleanDatabase();
});
afterAll(async () => {
  await db.$disconnect();
});

let seq = 0;
function key() {
  seq += 1;
  return `doc-ocr-test-${seq}-${Math.floor(Math.random() * 1e9)}`;
}

function pdfBuffer(padding = 100): Buffer {
  return Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.alloc(padding, 0x20)]);
}

function pngBuffer(): Buffer {
  return Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00]);
}

async function seedExpenseCategory(owner: SessionUser) {
  seq += 1;
  return db.transactionCategory.create({
    data: { organizationId: owner.organizationId, type: "EXPENSE", name: `OCR Test Kategori ${seq}`, isActive: true },
  });
}

async function seedProject(owner: SessionUser) {
  return createProject(owner, { code: key(), name: `OCR Test Proje ${seq}`, contractAmount: 0, estimatedBudget: 0 });
}

function fakeProvider(result: Partial<DocumentExtractionResult>, name = "fake"): DocumentExtractionProvider {
  return {
    name,
    async extract() {
      return { ...emptyExtractionResult(), ...result };
    },
  };
}

function failingProvider(message: string): DocumentExtractionProvider {
  return {
    name: "failing",
    async extract() {
      throw new Error(message);
    },
  };
}

/** Onay için geçerli, tam bir input üretir — testler yalnızca ihtiyaç duydukları alanı override eder. */
function confirmInput(extractionId: string, categoryId: string, overrides: Record<string, unknown> = {}) {
  return {
    extractionId,
    categoryId,
    description: "OCR ile yüklenen fatura",
    issueDate: new Date(),
    subtotal: 100,
    taxRate: 20,
    ...overrides,
  } as Parameters<typeof confirmDocumentExtraction>[1];
}

describe("document-extraction-service — yükleme ve dosya doğrulama", () => {
  it("desteklenmeyen dosya türü (magic-byte imzası eşleşmiyor) reddedilir", async () => {
    const { owner } = await createOwnerOrg();
    await expect(
      uploadAndExtractDocument(owner, { fileName: "belge.pdf", buffer: Buffer.from("bu bir PDF degil") }),
    ).rejects.toMatchObject({ code: "VALIDATION" });
  });

  it("dosya adı uzantısına değil yalnızca gerçek baytlara güvenilir (yanıltıcı uzantı reddedilmez, gerçek imza kullanılır)", async () => {
    const { owner } = await createOwnerOrg();
    // Dosya adı ".pdf" der ama baytlar gerçek bir PNG imzasıdır.
    const record = await uploadAndExtractDocument(owner, { fileName: "sahte.pdf", buffer: pngBuffer() });
    expect(record.mimeType).toBe("image/png");
  });

  it("boş dosya reddedilir", async () => {
    const { owner } = await createOwnerOrg();
    await expect(
      uploadAndExtractDocument(owner, { fileName: "bos.pdf", buffer: Buffer.alloc(0) }),
    ).rejects.toMatchObject({ code: "VALIDATION" });
  });

  it("8 MB sınırını aşan dosya reddedilir", async () => {
    const { owner } = await createOwnerOrg();
    const big = pdfBuffer(9 * 1024 * 1024);
    await expect(uploadAndExtractDocument(owner, { fileName: "buyuk.pdf", buffer: big })).rejects.toMatchObject({
      code: "VALIDATION",
    });
  });

  it("başarılı yükleme yalnızca bir taslak (candidate) üretir — hiçbir finansal kayıt oluşturmaz", async () => {
    const { owner } = await createOwnerOrg();
    const record = await uploadAndExtractDocument(owner, { fileName: "fatura.pdf", buffer: pdfBuffer() });

    expect(record.status).toBe("EXTRACTED");
    expect(record.providerName).toBe("none");
    expect(await db.financialTransaction.count()).toBe(0);
  });

  it("sağlayıcı hata fırlatırsa taslak FAILED olur ve yalnızca sabit, güvenli bir Türkçe mesaj saklanır (ham hata sızmaz)", async () => {
    const { owner } = await createOwnerOrg();
    const secretPayload = "gizli-api-anahtari-XYZ123 kullanıcı TCKN 12345678901";
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const record = await uploadAndExtractDocument(
      owner,
      { fileName: "fatura.pdf", buffer: pdfBuffer() },
      failingProvider(secretPayload),
    );

    expect(record.status).toBe("FAILED");
    expect(record.errorMessage).toBe("Belge işlenemedi");
    expect(record.errorMessage).not.toContain("gizli-api-anahtari");
    expect(await db.financialTransaction.count()).toBe(0);

    for (const call of errorSpy.mock.calls) {
      expect(JSON.stringify(call)).not.toContain("gizli-api-anahtari");
    }
  });

  it("sağlayıcının döndürdüğü bozuk/anlamsız tutar HAM STRING olarak saklanır — sessizce 0'a veya bir sayıya dönüştürülmez", async () => {
    const { owner } = await createOwnerOrg();
    const record = await uploadAndExtractDocument(
      owner,
      { fileName: "fatura.pdf", buffer: pdfBuffer() },
      fakeProvider({ totalAmountRaw: { value: "bes-yuz-TL-falan", confidence: 0.4 } }),
    );

    const candidate = record.candidateJson as unknown as DocumentExtractionResult;
    expect(candidate.totalAmountRaw.value).toBe("bes-yuz-TL-falan");
    expect(await db.financialTransaction.count()).toBe(0);
  });

  it("sağlayıcının hiçbir alan bulamadığı durum (boş aday sonucu) dürüstçe null olarak kalır, veri uydurulmaz", async () => {
    const { owner } = await createOwnerOrg();
    const record = await uploadAndExtractDocument(owner, { fileName: "fatura.pdf", buffer: pdfBuffer() });
    const candidate = record.candidateJson as unknown as DocumentExtractionResult;
    expect(candidate.totalAmountRaw.value).toBeNull();
    expect(candidate.supplierName.value).toBeNull();
  });
});

describe("document-extraction-service — tenant izolasyonu", () => {
  it("başka organizasyonun taslağı görüntülenemez (NOT_FOUND, sızıntı yok)", async () => {
    const { owner: ownerA } = await createOwnerOrg();
    const { owner: ownerB } = await createOwnerOrg();
    const record = await uploadAndExtractDocument(ownerA, { fileName: "fatura.pdf", buffer: pdfBuffer() });

    await expect(getDocumentExtractionForUser(ownerB, record.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("başka organizasyonun taslağı onaylanamaz (NOT_FOUND) ve hiçbir organizasyonda gider oluşmaz", async () => {
    const { owner: ownerA } = await createOwnerOrg();
    const { owner: ownerB } = await createOwnerOrg();
    const record = await uploadAndExtractDocument(ownerA, { fileName: "fatura.pdf", buffer: pdfBuffer() });
    const category = await seedExpenseCategory(ownerB);

    await expect(
      confirmDocumentExtraction(ownerB, confirmInput(record.id, category.id)),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(await db.financialTransaction.count()).toBe(0);
  });
});

describe("document-extraction-service — PROJECT_MANAGER kapsamı", () => {
  it("projesiz PROJECT_MANAGER belge yükleyemez", async () => {
    const { owner } = await createOwnerOrg();
    const pm = await createOrgUser(owner.organizationId, "PROJECT_MANAGER");
    await expect(uploadAndExtractDocument(pm, { fileName: "fatura.pdf", buffer: pdfBuffer() })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });

  it("atanmamış projeye PROJECT_MANAGER belge yükleyemez (NOT_FOUND, sızıntı yok)", async () => {
    const { owner } = await createOwnerOrg();
    const pm = await createOrgUser(owner.organizationId, "PROJECT_MANAGER");
    const project = await seedProject(owner);
    await expect(
      uploadAndExtractDocument(pm, { fileName: "fatura.pdf", buffer: pdfBuffer(), projectId: project.id }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("atanmamış PROJECT_MANAGER başka bir PM'in projesine ait taslağı göremez", async () => {
    const { owner } = await createOwnerOrg();
    const pmOwnerSide = await createOrgUser(owner.organizationId, "PROJECT_MANAGER");
    const outsiderPm = await createOrgUser(owner.organizationId, "PROJECT_MANAGER");
    const project = await seedProject(owner);
    await assignProjectMember(owner, project.id, pmOwnerSide.id);

    const record = await uploadAndExtractDocument(pmOwnerSide, {
      fileName: "fatura.pdf",
      buffer: pdfBuffer(),
      projectId: project.id,
    });

    await expect(getDocumentExtractionForUser(outsiderPm, record.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("atanmış PROJECT_MANAGER kendi projesindeki taslağı yükleyip onaylayabilir", async () => {
    const { owner } = await createOwnerOrg();
    const pm = await createOrgUser(owner.organizationId, "PROJECT_MANAGER");
    const project = await seedProject(owner);
    await assignProjectMember(owner, project.id, pm.id);
    const category = await seedExpenseCategory(owner);

    const record = await uploadAndExtractDocument(pm, {
      fileName: "fatura.pdf",
      buffer: pdfBuffer(),
      projectId: project.id,
    });

    const result = await confirmDocumentExtraction(
      pm,
      confirmInput(record.id, category.id, { projectId: project.id }),
    );
    expect(result.alreadyConfirmed).toBe(false);
    expect(await db.financialTransaction.count()).toBe(1);
  });
});

describe("document-extraction-service — onay akışı (yalnızca canonical createExpense üzerinden)", () => {
  it("onay sonrası tam olarak bir FinancialTransaction oluşturur, taslağı CONFIRMED işaretler ve audit log yazar", async () => {
    const { owner } = await createOwnerOrg();
    const category = await seedExpenseCategory(owner);
    const record = await uploadAndExtractDocument(owner, { fileName: "fatura.pdf", buffer: pdfBuffer() });

    const result = await confirmDocumentExtraction(owner, confirmInput(record.id, category.id));

    expect(result.alreadyConfirmed).toBe(false);
    expect(await db.financialTransaction.count()).toBe(1);
    const tx = await db.financialTransaction.findFirstOrThrow();
    expect(tx.id).toBe(result.transactionId);
    expect(tx.type).toBe("EXPENSE");

    const updated = await db.documentExtraction.findUniqueOrThrow({ where: { id: record.id } });
    expect(updated.status).toBe("CONFIRMED");
    expect(updated.confirmedTransactionId).toBe(result.transactionId);
    expect(updated.confirmedById).toBe(owner.id);

    const auditEntries = await db.auditLog.findMany({ where: { entityType: "DocumentExtraction", entityId: record.id } });
    expect(auditEntries.some((a) => a.action === "document_extraction.confirm")).toBe(true);
  });

  it("mükerrer onay (istemci tekrar denemesi) ikinci bir gider OLUŞTURMAZ — idempotent olarak aynı sonucu döner", async () => {
    const { owner } = await createOwnerOrg();
    const category = await seedExpenseCategory(owner);
    const record = await uploadAndExtractDocument(owner, { fileName: "fatura.pdf", buffer: pdfBuffer() });

    const first = await confirmDocumentExtraction(owner, confirmInput(record.id, category.id));
    const second = await confirmDocumentExtraction(owner, confirmInput(record.id, category.id));

    expect(second.alreadyConfirmed).toBe(true);
    expect(second.transactionId).toBe(first.transactionId);
    expect(await db.financialTransaction.count()).toBe(1);
  });

  it("eşzamanlı çift onay denemesinde yalnızca biri başarılı olur, ikincisi çakışma hatası alır — asla iki gider oluşmaz", async () => {
    const { owner } = await createOwnerOrg();
    const category = await seedExpenseCategory(owner);
    const record = await uploadAndExtractDocument(owner, { fileName: "fatura.pdf", buffer: pdfBuffer() });

    const results = await Promise.allSettled([
      confirmDocumentExtraction(owner, confirmInput(record.id, category.id)),
      confirmDocumentExtraction(owner, confirmInput(record.id, category.id)),
    ]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    if (rejected[0]?.status === "rejected") {
      expect(rejected[0].reason).toMatchObject({ code: "CONFLICT" });
    }
    expect(await db.financialTransaction.count()).toBe(1);
  });

  it("çöküş penceresi kapatıldı: gider oluşturma tamamlansa bile finalize adımı (audit/CONFIRMED) çökerse TÜM işlem geri alınır — asılı FinancialTransaction kalmaz; yeniden deneme TAM OLARAK bir gider oluşturur (YF-601 follow-up, PR #25 blocker)", async () => {
    const { owner } = await createOwnerOrg();
    const category = await seedExpenseCategory(owner);
    const record = await uploadAndExtractDocument(owner, { fileName: "fatura.pdf", buffer: pdfBuffer() });

    // Gerçek `writeAuditLog`'u yalnızca "document_extraction.confirm" audit'i
    // yazılırken (yani gider ZATEN oluşturulmuş, finalize adımının SON
    // adımındayken) fırlatacak şekilde geçici olarak değiştiriyoruz — bu,
    // "expense oluştu ama taslak CONFIRMED'e hiç ulaşmadan süreç çöktü"
    // senaryosunu simüle eder. `createExpenseInTransaction` ve finalize
    // güncellemesi ARTIK AYNI veritabanı transaction'ında olduğundan, bu
    // fırlatma tüm transaction'ı (financialTransaction.create dahil) geri
    // almalıdır — eski (buggy) davranışta ise gider zaten ayrı commit edilmiş
    // olurdu.
    const originalWriteAuditLog = auditModule.writeAuditLog;
    const auditSpy = vi.spyOn(auditModule, "writeAuditLog").mockImplementation(async (tx, entry) => {
      if (entry.action === "document_extraction.confirm") {
        throw new Error("simulated crash: finalize adımı çöktü");
      }
      return originalWriteAuditLog(tx, entry);
    });
    try {
      await expect(confirmDocumentExtraction(owner, confirmInput(record.id, category.id))).rejects.toThrow(
        "simulated crash: finalize adımı çöktü",
      );
    } finally {
      auditSpy.mockRestore();
    }

    // Çöküşten SONRA: transaction tamamen geri alındı — asılı kalmış hiçbir
    // FinancialTransaction yok, taslak kurtarılabilir (recoverable) önceki
    // durumuna (EXTRACTED) dönmüş, hiçbir audit kaydı kalıcı olmamış.
    expect(await db.financialTransaction.count()).toBe(0);
    const afterCrash = await db.documentExtraction.findUniqueOrThrow({ where: { id: record.id } });
    expect(afterCrash.status).toBe("EXTRACTED");
    expect(afterCrash.confirmedTransactionId).toBeNull();
    expect(
      await db.auditLog.count({
        where: { entityType: "DocumentExtraction", entityId: record.id, action: "document_extraction.confirm" },
      }),
    ).toBe(0);
    expect(await db.auditLog.count({ where: { entityType: "FinancialTransaction", action: "expense.create" } })).toBe(
      0,
    );

    // Kurtarma/yeniden deneme: aynı taslak tekrar onaylanır — TAM OLARAK bir
    // gider oluşur, mükerrer kayıt YOK.
    const retry = await confirmDocumentExtraction(owner, confirmInput(record.id, category.id));
    expect(retry.alreadyConfirmed).toBe(false);

    expect(await db.financialTransaction.count()).toBe(1);
    const finalRecord = await db.documentExtraction.findUniqueOrThrow({ where: { id: record.id } });
    expect(finalRecord.status).toBe("CONFIRMED");
    expect(finalRecord.confirmedTransactionId).toBe(retry.transactionId);

    expect(
      await db.auditLog.count({
        where: {
          entityType: "FinancialTransaction",
          entityId: retry.transactionId as string,
          action: "expense.create",
        },
      }),
    ).toBe(1);
    expect(
      await db.auditLog.count({
        where: { entityType: "DocumentExtraction", entityId: record.id, action: "document_extraction.confirm" },
      }),
    ).toBe(1);
  });

  it("createExpense başarısız olursa (kategori başka organizasyondan) taslak durumu geri alınır ve daha sonra tekrar onaylanabilir", async () => {
    const { owner } = await createOwnerOrg();
    const { owner: otherOrgOwner } = await createOwnerOrg();
    const foreignCategory = await seedExpenseCategory(otherOrgOwner);
    const record = await uploadAndExtractDocument(owner, { fileName: "fatura.pdf", buffer: pdfBuffer() });

    await expect(
      confirmDocumentExtraction(owner, confirmInput(record.id, foreignCategory.id)),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    const afterFailedConfirm = await db.documentExtraction.findUniqueOrThrow({ where: { id: record.id } });
    expect(afterFailedConfirm.status).toBe("EXTRACTED");
    expect(await db.financialTransaction.count()).toBe(0);

    const validCategory = await seedExpenseCategory(owner);
    const retry = await confirmDocumentExtraction(owner, confirmInput(record.id, validCategory.id));
    expect(retry.alreadyConfirmed).toBe(false);
    expect(await db.financialTransaction.count()).toBe(1);
  });

  it("sağlayıcı başarısız olsa bile (FAILED) kullanıcı tüm alanları elle doldurup onaylayabilir", async () => {
    const { owner } = await createOwnerOrg();
    const category = await seedExpenseCategory(owner);
    const record = await uploadAndExtractDocument(
      owner,
      { fileName: "fatura.pdf", buffer: pdfBuffer() },
      failingProvider("saglayici coktu"),
    );
    expect(record.status).toBe("FAILED");

    const result = await confirmDocumentExtraction(owner, confirmInput(record.id, category.id));
    expect(result.alreadyConfirmed).toBe(false);
    expect(await db.financialTransaction.count()).toBe(1);
  });

  it("PENDING/CONFIRMING dışı geçerli bir durumda olmayan taslak onaylanamaz (henüz işlenmemiş taslak)", async () => {
    const { owner } = await createOwnerOrg();
    const category = await seedExpenseCategory(owner);
    const record = await uploadAndExtractDocument(owner, { fileName: "fatura.pdf", buffer: pdfBuffer() });
    await db.documentExtraction.update({ where: { id: record.id }, data: { status: "PENDING" } });

    await expect(
      confirmDocumentExtraction(owner, confirmInput(record.id, category.id)),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await db.financialTransaction.count()).toBe(0);
  });
});

describe("lib/validation/document-extraction — onay şeması mevcut gider doğrulamasını yeniden kullanır", () => {
  it("OCR'den gelen bozuk bir tutar dizesi onay şemasından geçemez (sessizce 0'a dönüşmez)", () => {
    const parsed = confirmDocumentExtractionSchema.safeParse({
      extractionId: "abc",
      categoryId: "cat-1",
      description: "test",
      issueDate: new Date().toISOString(),
      subtotal: "bes-yuz-TL-falan",
      taxRate: 20,
    });
    expect(parsed.success).toBe(false);
  });

  it("eksik/boş tutar da geçemez — hiçbir alan varsayılan olarak 0 doldurulmaz", () => {
    const parsed = confirmDocumentExtractionSchema.safeParse({
      extractionId: "abc",
      categoryId: "cat-1",
      description: "test",
      issueDate: new Date().toISOString(),
      taxRate: 20,
    });
    expect(parsed.success).toBe(false);
  });
});
