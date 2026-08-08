import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import * as auditModule from "@/lib/audit";
import { cleanDatabase, createOwnerOrg, createOrgUser } from "./helpers";
import {
  importBankStatement,
  listBatchesForUser,
  getBatchForUser,
  getBankImportRowForUser,
  suggestMatchesForRow,
  confirmBankImportRowAsSettlement,
  confirmBankImportRowAsTransfer,
  ignoreBankImportRow,
} from "@/server/services/bank-import-service";
import type { SessionUser } from "@/lib/auth/session";
import type { TransactionType } from "@prisma/client";

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
function next() {
  seq += 1;
  return seq;
}

function csvBuffer(dataLines: string[], header = "Tarih,Açıklama,Tutar,Referans"): Buffer {
  return Buffer.from([header, ...dataLines].join("\n"), "utf8");
}

async function seedBankAccount(owner: SessionUser, overrides: Record<string, unknown> = {}) {
  const n = next();
  return db.financialAccount.create({
    data: {
      organizationId: owner.organizationId,
      name: `Test Banka ${n}`,
      type: "BANK",
      currency: "TRY",
      isActive: true,
      ...overrides,
    },
  });
}

/** `seedBankAccount` gerçek bir bakiye taşımaz (bakiye AccountMovement toplamından türetilir) — negatif bakiye korumasını tetiklemeyecek testler için açık bir OPENING hareketi eklenir. */
async function seedOpeningMovement(owner: SessionUser, account: { id: string }, amount: number) {
  return db.accountMovement.create({
    data: {
      organizationId: owner.organizationId,
      financialAccountId: account.id,
      type: "OPENING",
      direction: "CREDIT",
      amount,
      occurredAt: new Date("2026-01-01T00:00:00.000Z"),
      description: "Test açılış bakiyesi",
      createdById: owner.id,
    },
  });
}

async function seedCashAccount(owner: SessionUser) {
  const n = next();
  return db.financialAccount.create({
    data: { organizationId: owner.organizationId, name: `Test Kasa ${n}`, type: "CASH", currency: "TRY", isActive: true },
  });
}

async function seedCategory(owner: SessionUser, type: TransactionType) {
  const n = next();
  return db.transactionCategory.create({
    data: { organizationId: owner.organizationId, type, name: `Kategori ${n}`, isActive: true },
  });
}

async function seedOpenTransaction(owner: SessionUser, type: TransactionType, totalAmount: number) {
  const category = await seedCategory(owner, type);
  const n = next();
  return db.financialTransaction.create({
    data: {
      organizationId: owner.organizationId,
      type,
      categoryId: category.id,
      description: `Test ${type} kaydı ${n}`,
      issueDate: new Date("2026-03-01T00:00:00.000Z"),
      subtotal: totalAmount,
      totalAmount,
      createdById: owner.id,
    },
  });
}

describe("bank-import-service — dosya doğrulama", () => {
  it("boş dosya reddedilir", async () => {
    const { owner } = await createOwnerOrg();
    const account = await seedBankAccount(owner);
    await expect(
      importBankStatement(owner, { financialAccountId: account.id, fileName: "ekstre.csv", buffer: Buffer.alloc(0) }),
    ).rejects.toMatchObject({ code: "VALIDATION" });
  });

  it("5 MB sınırını aşan dosya reddedilir", async () => {
    const { owner } = await createOwnerOrg();
    const account = await seedBankAccount(owner);
    const big = Buffer.alloc(6 * 1024 * 1024, 0x20);
    await expect(
      importBankStatement(owner, { financialAccountId: account.id, fileName: "buyuk.csv", buffer: big }),
    ).rejects.toMatchObject({ code: "VALIDATION" });
  });

  it("gerekli sütunlar (Tutar) eksikse dosya tamamen reddedilir, hiçbir satır kaydedilmez", async () => {
    const { owner } = await createOwnerOrg();
    const account = await seedBankAccount(owner);
    const buffer = csvBuffer(["01.03.2026,Bir açıklama,REF-1"], "Tarih,Açıklama,Referans");
    await expect(
      importBankStatement(owner, { financialAccountId: account.id, fileName: "ekstre.csv", buffer }),
    ).rejects.toMatchObject({ code: "VALIDATION" });
    expect(await db.bankImportBatch.count()).toBe(0);
  });

  it("yalnızca BANK türü hesaplara içe aktarılabilir", async () => {
    const { owner } = await createOwnerOrg();
    const cash = await seedCashAccount(owner);
    const buffer = csvBuffer(["01.03.2026,Test,100.00,REF-1"]);
    await expect(
      importBankStatement(owner, { financialAccountId: cash.id, fileName: "ekstre.csv", buffer }),
    ).rejects.toMatchObject({ code: "VALIDATION" });
  });

  it("pasif hesaba içe aktarım yapılamaz", async () => {
    const { owner } = await createOwnerOrg();
    const account = await seedBankAccount(owner, { isActive: false });
    const buffer = csvBuffer(["01.03.2026,Test,100.00,REF-1"]);
    await expect(
      importBankStatement(owner, { financialAccountId: account.id, fileName: "ekstre.csv", buffer }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });
});

describe("bank-import-service — tenant izolasyonu", () => {
  it("başka organizasyonun hesabına içe aktarım yapılamaz (NOT_FOUND, sızıntı yok)", async () => {
    const { owner: ownerA } = await createOwnerOrg();
    const { owner: ownerB } = await createOwnerOrg();
    const accountB = await seedBankAccount(ownerB);
    const buffer = csvBuffer(["01.03.2026,Test,100.00,REF-1"]);
    await expect(
      importBankStatement(ownerA, { financialAccountId: accountB.id, fileName: "ekstre.csv", buffer }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("başka organizasyonun batch'i görüntülenemez", async () => {
    const { owner: ownerA } = await createOwnerOrg();
    const { owner: ownerB } = await createOwnerOrg();
    const accountA = await seedBankAccount(ownerA);
    const { batch } = await importBankStatement(ownerA, {
      financialAccountId: accountA.id,
      fileName: "ekstre.csv",
      buffer: csvBuffer(["01.03.2026,Test,100.00,REF-1"]),
    });
    await expect(getBatchForUser(ownerB, batch.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("başka organizasyonun satırı görüntülenemez ve mutabık kılınamaz", async () => {
    const { owner: ownerA } = await createOwnerOrg();
    const { owner: ownerB } = await createOwnerOrg();
    const accountA = await seedBankAccount(ownerA);
    const { batch } = await importBankStatement(ownerA, {
      financialAccountId: accountA.id,
      fileName: "ekstre.csv",
      buffer: csvBuffer(["01.03.2026,Test,100.00,REF-1"]),
    });
    const { rows } = await getBatchForUser(ownerA, batch.id);
    const row = rows[0];

    await expect(getBankImportRowForUser(ownerB, row.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      confirmBankImportRowAsSettlement(ownerB, { rowId: row.id, transactionId: "irrelevant" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(await db.settlement.count()).toBe(0);
  });
});

describe("bank-import-service — PROJECT_MANAGER kapalı-durumda-başarısız", () => {
  it("PROJECT_MANAGER ekstre içe aktaramaz", async () => {
    const { owner } = await createOwnerOrg();
    const pm = await createOrgUser(owner.organizationId, "PROJECT_MANAGER");
    const account = await seedBankAccount(owner);
    await expect(
      importBankStatement(pm, { financialAccountId: account.id, fileName: "ekstre.csv", buffer: csvBuffer(["01.03.2026,Test,100.00,REF-1"]) }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("PROJECT_MANAGER batch listesini göremez", async () => {
    const { owner } = await createOwnerOrg();
    const pm = await createOrgUser(owner.organizationId, "PROJECT_MANAGER");
    await expect(listBatchesForUser(pm)).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});

describe("bank-import-service — mükerrer içe aktarım koruması", () => {
  it("aynı dosya aynı hesaba iki kez yüklenirse ikincisi idempotent döner, satır çoğalmaz", async () => {
    const { owner } = await createOwnerOrg();
    const account = await seedBankAccount(owner);
    const buffer = csvBuffer(["01.03.2026,Kira ödemesi,1000.00,REF-1", "02.03.2026,Fatura,250.50,REF-2"]);

    const first = await importBankStatement(owner, { financialAccountId: account.id, fileName: "ekstre.csv", buffer });
    expect(first.alreadyImported).toBe(false);
    expect(await db.bankImportRow.count()).toBe(2);

    const second = await importBankStatement(owner, { financialAccountId: account.id, fileName: "ekstre-tekrar.csv", buffer });
    expect(second.alreadyImported).toBe(true);
    expect(second.batch.id).toBe(first.batch.id);
    expect(await db.bankImportBatch.count()).toBe(1);
    expect(await db.bankImportRow.count()).toBe(2);
  });

  it("aynı işlem farklı bir dosyadan tekrar gelirse satır düzeyinde atlanır (yalnızca yeni satır eklenir)", async () => {
    const { owner } = await createOwnerOrg();
    const account = await seedBankAccount(owner);
    const fileA = csvBuffer(["01.03.2026,Kira ödemesi,1000.00,REF-1"]);
    const fileB = csvBuffer(["01.03.2026,Kira ödemesi,1000.00,REF-1", "02.03.2026,Başka ödeme,500.00,REF-2"]);

    const batchA = await importBankStatement(owner, { financialAccountId: account.id, fileName: "a.csv", buffer: fileA });
    expect(batchA.alreadyImported).toBe(false);

    const batchB = await importBankStatement(owner, { financialAccountId: account.id, fileName: "b.csv", buffer: fileB });
    expect(batchB.alreadyImported).toBe(false);
    expect(batchB.batch.id).not.toBe(batchA.batch.id);
    expect(batchB.batch.rowCount).toBe(2);
    expect(batchB.batch.importedRowCount).toBe(1);
    expect(batchB.batch.duplicateSkippedCount).toBe(1);

    expect(await db.bankImportRow.count()).toBe(2);
  });

  it("eşzamanlı aynı dosya yüklemesi (race) tek batch üretir — yeni benzersizlik kısıtı eşzamanlılık altında test edildi", async () => {
    const { owner } = await createOwnerOrg();
    const account = await seedBankAccount(owner);
    const buffer = csvBuffer(["01.03.2026,Eşzamanlı test,300.00,REF-9"]);

    const results = await Promise.allSettled([
      importBankStatement(owner, { financialAccountId: account.id, fileName: "e1.csv", buffer }),
      importBankStatement(owner, { financialAccountId: account.id, fileName: "e2.csv", buffer }),
    ]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    expect(fulfilled).toHaveLength(2);
    const batchIds = new Set(
      fulfilled.map((r) => (r as PromiseFulfilledResult<Awaited<ReturnType<typeof importBankStatement>>>).value.batch.id),
    );
    expect(batchIds.size).toBe(1);
    expect(await db.bankImportBatch.count()).toBe(1);
    expect(await db.bankImportRow.count()).toBe(1);
  });
});

describe("bank-import-service — bozuk satırlar", () => {
  it("bozuk/belirsiz tutar ERROR olarak saklanır, diğer geçerli satırları engellemez, hiçbir finansal etki yok", async () => {
    const { owner } = await createOwnerOrg();
    const account = await seedBankAccount(owner);
    const buffer = csvBuffer(["01.03.2026,Geçerli satır,100.00,REF-1", "02.03.2026,Bozuk tutar,elli TL,REF-2"]);

    const { batch } = await importBankStatement(owner, { financialAccountId: account.id, fileName: "ekstre.csv", buffer });
    expect(batch.importedRowCount).toBe(1);
    expect(batch.errorRowCount).toBe(1);

    const rows = await db.bankImportRow.findMany({ where: { batchId: batch.id }, orderBy: { createdAt: "asc" } });
    const errorRow = rows.find((r) => r.status === "ERROR");
    expect(errorRow).toBeTruthy();
    expect(errorRow?.amount).toBeNull();
    expect(errorRow?.errorMessage).toContain("tutar");
    expect(await db.settlement.count()).toBe(0);
  });

  it("takvimde var olmayan tarih (31.02) ERROR olarak saklanır, asla en yakın geçerli tarihe yuvarlanmaz", async () => {
    const { owner } = await createOwnerOrg();
    const account = await seedBankAccount(owner);
    const buffer = csvBuffer(["31.02.2026,Geçersiz tarih,100.00,REF-1"]);

    const { batch } = await importBankStatement(owner, { financialAccountId: account.id, fileName: "ekstre.csv", buffer });
    expect(batch.errorRowCount).toBe(1);
    expect(batch.importedRowCount).toBe(0);
    const row = await db.bankImportRow.findFirstOrThrow({ where: { batchId: batch.id } });
    expect(row.transactionDate).toBeNull();
  });

  it("sıfır tutar ERROR olarak saklanır (belirsiz/anlamsız işlem, sessizce kabul edilmez)", async () => {
    const { owner } = await createOwnerOrg();
    const account = await seedBankAccount(owner);
    const buffer = csvBuffer(["01.03.2026,Sıfır tutar,0,00,REF-1"], "Tarih,Açıklama,Tutar,Referans");
    const { batch } = await importBankStatement(owner, { financialAccountId: account.id, fileName: "ekstre.csv", buffer });
    expect(batch.errorRowCount).toBe(1);
  });
});

describe("bank-import-service — salt-okunur eşleşme önerisi", () => {
  it("suggestMatchesForRow hiçbir DB değişikliği yapmaz", async () => {
    const { owner } = await createOwnerOrg();
    const account = await seedBankAccount(owner);
    const income = await seedOpenTransaction(owner, "INCOME", 1000);
    const { batch } = await importBankStatement(owner, {
      financialAccountId: account.id,
      fileName: "ekstre.csv",
      buffer: csvBuffer(["01.03.2026,Gelen havale,1000.00,REF-1"]),
    });
    const { rows } = await getBatchForUser(owner, batch.id);
    const row = rows[0];

    const candidatesFirst = await suggestMatchesForRow(owner, row.id);
    const candidatesSecond = await suggestMatchesForRow(owner, row.id);
    expect(candidatesFirst.map((c) => c.id)).toEqual(candidatesSecond.map((c) => c.id));
    expect(candidatesFirst.some((c) => c.id === income.id)).toBe(true);

    const unchanged = await db.bankImportRow.findUniqueOrThrow({ where: { id: row.id } });
    expect(unchanged.status).toBe("IMPORTED");
    expect(await db.settlement.count()).toBe(0);
  });
});

describe("bank-import-service — mutabakat onayı (tahsilat/ödeme)", () => {
  async function setupCreditRowAgainstIncome() {
    const { owner } = await createOwnerOrg();
    const account = await seedBankAccount(owner);
    const income = await seedOpenTransaction(owner, "INCOME", 1000);
    const { batch } = await importBankStatement(owner, {
      financialAccountId: account.id,
      fileName: "ekstre.csv",
      buffer: csvBuffer(["01.03.2026,Gelen havale,1000.00,REF-1"]),
    });
    const { rows } = await getBatchForUser(owner, batch.id);
    return { owner, account, income, batch, row: rows[0] };
  }

  it("canonical createSettlement üzerinden tam olarak bir Settlement + AccountMovement oluşturur, satırı RECONCILED işaretler, audit log yazar", async () => {
    const { owner, account, income, row } = await setupCreditRowAgainstIncome();

    const result = await confirmBankImportRowAsSettlement(owner, { rowId: row.id, transactionId: income.id });
    expect(result.alreadyConfirmed).toBe(false);
    expect(await db.settlement.count()).toBe(1);
    // Not: kayıt sırasında organizasyona otomatik "Ana Kasa" hesabı ve 0
    // tutarlı bir OPENING hareketi eklenir (bkz. organization-service.ts) —
    // bu yüzden hareket sayısı test hesabına göre (financialAccountId ile)
    // taranır, DB genelinde değil.
    expect(await db.accountMovement.count({ where: { financialAccountId: account.id } })).toBe(1);

    const updatedRow = await db.bankImportRow.findUniqueOrThrow({ where: { id: row.id } });
    expect(updatedRow.status).toBe("RECONCILED");
    expect(updatedRow.matchedSettlementId).toBe(result.settlementId);
    expect(updatedRow.reconciliationType).toBe("COLLECTION");

    const tx = await db.financialTransaction.findUniqueOrThrow({ where: { id: income.id } });
    expect(tx.status).toBe("PAID");

    const audit = await db.auditLog.findMany({ where: { entityType: "BankImportRow", entityId: row.id } });
    expect(audit.some((a) => a.action === "bank_import_row.reconcile_settlement")).toBe(true);
  });

  it("banka satırının yönü (CREDIT) seçilen kaydın türüyle (EXPENSE) uyuşmazsa reddedilir, hiçbir Settlement oluşmaz", async () => {
    const { owner, row } = await setupCreditRowAgainstIncome();
    const expense = await seedOpenTransaction(owner, "EXPENSE", 1000);

    await expect(
      confirmBankImportRowAsSettlement(owner, { rowId: row.id, transactionId: expense.id }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await db.settlement.count()).toBe(0);

    const afterFail = await db.bankImportRow.findUniqueOrThrow({ where: { id: row.id } });
    expect(afterFail.status).toBe("IMPORTED");
  });

  it("mükerrer onay denemesi (aynı satır tekrar) reddedilir — iki kez mutabakat sağlanamaz", async () => {
    const { owner, income, row } = await setupCreditRowAgainstIncome();
    await confirmBankImportRowAsSettlement(owner, { rowId: row.id, transactionId: income.id });

    await expect(
      confirmBankImportRowAsSettlement(owner, { rowId: row.id, transactionId: income.id }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await db.settlement.count()).toBe(1);
  });

  it("eşzamanlı çift onay denemesinde yalnızca biri başarılı olur, asla iki Settlement oluşmaz", async () => {
    const { owner, income, row } = await setupCreditRowAgainstIncome();

    const results = await Promise.allSettled([
      confirmBankImportRowAsSettlement(owner, { rowId: row.id, transactionId: income.id }),
      confirmBankImportRowAsSettlement(owner, { rowId: row.id, transactionId: income.id }),
    ]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    if (rejected[0]?.status === "rejected") {
      expect(rejected[0].reason).toMatchObject({ code: "CONFLICT" });
    }
    expect(await db.settlement.count()).toBe(1);
  });

  it("çöküş penceresi kapalı: finalize adımı (audit) çökerse Settlement dahil TÜM işlem geri alınır, satır tekrar denemeye açılır, yeniden deneme TAM OLARAK bir Settlement oluşturur", async () => {
    const { owner, account, income, row } = await setupCreditRowAgainstIncome();

    const originalWriteAuditLog = auditModule.writeAuditLog;
    const auditSpy = vi.spyOn(auditModule, "writeAuditLog").mockImplementation(async (tx, entry) => {
      if (entry.action === "bank_import_row.reconcile_settlement") {
        throw new Error("simulated crash: finalize adımı çöktü");
      }
      return originalWriteAuditLog(tx, entry);
    });
    try {
      await expect(confirmBankImportRowAsSettlement(owner, { rowId: row.id, transactionId: income.id })).rejects.toThrow(
        "simulated crash: finalize adımı çöktü",
      );
    } finally {
      auditSpy.mockRestore();
    }

    expect(await db.settlement.count()).toBe(0);
    expect(await db.accountMovement.count({ where: { financialAccountId: account.id } })).toBe(0);
    const afterCrash = await db.bankImportRow.findUniqueOrThrow({ where: { id: row.id } });
    expect(afterCrash.status).toBe("IMPORTED");
    expect(afterCrash.matchedSettlementId).toBeNull();

    const retry = await confirmBankImportRowAsSettlement(owner, { rowId: row.id, transactionId: income.id });
    expect(retry.alreadyConfirmed).toBe(false);
    expect(await db.settlement.count()).toBe(1);
    const finalRow = await db.bankImportRow.findUniqueOrThrow({ where: { id: row.id } });
    expect(finalRow.status).toBe("RECONCILED");
    expect(finalRow.matchedSettlementId).toBe(retry.settlementId);
  });

  it("yok sayılmış bir satır yanlışlıkla mutabık kılınamaz", async () => {
    const { owner, income, row } = await setupCreditRowAgainstIncome();
    await ignoreBankImportRow(owner, row.id);

    await expect(
      confirmBankImportRowAsSettlement(owner, { rowId: row.id, transactionId: income.id }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await db.settlement.count()).toBe(0);
  });

  it("ERROR durumundaki satır mutabık kılınamaz", async () => {
    const { owner } = await createOwnerOrg();
    const account = await seedBankAccount(owner);
    const { batch } = await importBankStatement(owner, {
      financialAccountId: account.id,
      fileName: "ekstre.csv",
      buffer: csvBuffer(["01.03.2026,Bozuk,elli TL,REF-1"]),
    });
    const { rows } = await getBatchForUser(owner, batch.id);
    const income = await seedOpenTransaction(owner, "INCOME", 1000);

    await expect(
      confirmBankImportRowAsSettlement(owner, { rowId: rows[0].id, transactionId: income.id }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });
});

describe("bank-import-service — mutabakat onayı (transfer)", () => {
  it("transfer olarak mutabık kılınan satır canonical createTransfer'ı kullanır ve GELİR/GİDER OLARAK SAYILMAZ", async () => {
    const { owner } = await createOwnerOrg();
    const accountA = await seedBankAccount(owner);
    const accountB = await seedBankAccount(owner);
    await seedOpeningMovement(owner, accountA, 1000);
    const { batch } = await importBankStatement(owner, {
      financialAccountId: accountA.id,
      fileName: "ekstre.csv",
      buffer: csvBuffer(["01.03.2026,Hesaba transfer,-400.00,REF-1"]),
    });
    const { rows } = await getBatchForUser(owner, batch.id);
    const row = rows[0];
    expect(row.direction).toBe("DEBIT");

    const before = await db.financialTransaction.count();
    const result = await confirmBankImportRowAsTransfer(owner, { rowId: row.id, counterpartAccountId: accountB.id });
    expect(result.alreadyConfirmed).toBe(false);

    expect(await db.financialTransaction.count()).toBe(before); // gelir/gider oluşmadı
    expect(await db.accountTransfer.count()).toBe(1);
    const transfer = await db.accountTransfer.findFirstOrThrow();
    expect(transfer.fromAccountId).toBe(accountA.id);
    expect(transfer.toAccountId).toBe(accountB.id);

    const updatedRow = await db.bankImportRow.findUniqueOrThrow({ where: { id: row.id } });
    expect(updatedRow.status).toBe("RECONCILED");
    expect(updatedRow.reconciliationType).toBe("TRANSFER");
    expect(updatedRow.matchedTransferId).toBe(transfer.id);
  });

  it("karşı hesap başka bir organizasyona aitse reddedilir (NOT_FOUND, sızıntı yok)", async () => {
    const { owner: ownerA } = await createOwnerOrg();
    const { owner: ownerB } = await createOwnerOrg();
    const accountA = await seedBankAccount(ownerA);
    const accountB = await seedBankAccount(ownerB);
    const { batch } = await importBankStatement(ownerA, {
      financialAccountId: accountA.id,
      fileName: "ekstre.csv",
      buffer: csvBuffer(["01.03.2026,Transfer,-100.00,REF-1"]),
    });
    const { rows } = await getBatchForUser(ownerA, batch.id);

    await expect(
      confirmBankImportRowAsTransfer(ownerA, { rowId: rows[0].id, counterpartAccountId: accountB.id }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(await db.accountTransfer.count()).toBe(0);
  });
});

describe("bank-import-service — yok sayma", () => {
  it("IMPORTED bir satır yok sayılabilir, audit log yazılır", async () => {
    const { owner } = await createOwnerOrg();
    const account = await seedBankAccount(owner);
    const { batch } = await importBankStatement(owner, {
      financialAccountId: account.id,
      fileName: "ekstre.csv",
      buffer: csvBuffer(["01.03.2026,Test,100.00,REF-1"]),
    });
    const { rows } = await getBatchForUser(owner, batch.id);

    const updated = await ignoreBankImportRow(owner, rows[0].id);
    expect(updated.status).toBe("IGNORED");
    const audit = await db.auditLog.findMany({ where: { entityType: "BankImportRow", entityId: rows[0].id } });
    expect(audit.some((a) => a.action === "bank_import_row.ignore")).toBe(true);
  });

  it("yok sayma idempotenttir (iki kez yok saymak hata vermez)", async () => {
    const { owner } = await createOwnerOrg();
    const account = await seedBankAccount(owner);
    const { batch } = await importBankStatement(owner, {
      financialAccountId: account.id,
      fileName: "ekstre.csv",
      buffer: csvBuffer(["01.03.2026,Test,100.00,REF-1"]),
    });
    const { rows } = await getBatchForUser(owner, batch.id);

    await ignoreBankImportRow(owner, rows[0].id);
    const second = await ignoreBankImportRow(owner, rows[0].id);
    expect(second.status).toBe("IGNORED");
  });

  it("zaten mutabık kılınmış bir satır yok sayılamaz", async () => {
    const { owner } = await createOwnerOrg();
    const account = await seedBankAccount(owner);
    const income = await seedOpenTransaction(owner, "INCOME", 1000);
    const { batch } = await importBankStatement(owner, {
      financialAccountId: account.id,
      fileName: "ekstre.csv",
      buffer: csvBuffer(["01.03.2026,Gelen havale,1000.00,REF-1"]),
    });
    const { rows } = await getBatchForUser(owner, batch.id);
    await confirmBankImportRowAsSettlement(owner, { rowId: rows[0].id, transactionId: income.id });

    await expect(ignoreBankImportRow(owner, rows[0].id)).rejects.toMatchObject({ code: "CONFLICT" });
  });
});
