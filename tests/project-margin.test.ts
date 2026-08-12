import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { cleanDatabase, createOwnerOrg, createOrgUser } from "./helpers";
import { createIncome, createExpense, cancelExpense } from "@/server/services/transaction-service";
import { createAccount } from "@/server/services/account-service";
import { createSettlement } from "@/server/services/settlement-service";
import { createTransfer } from "@/server/services/transfer-service";
import { createProject, assignProjectMember } from "@/server/services/project-service";
import { getProjectFinanceSummary } from "@/server/services/project-finance-service";
import { getProjectMarginComparison } from "@/server/services/project-margin-service";
import type { ProjectMarginComparison, ProjectMarginComparisonRow } from "@/server/services/project-margin-service";
import type { SessionUser } from "@/lib/auth/session";
import type { TransactionType } from "@prisma/client";

/**
 * YF-702-F2 — Toplu proje marj karşılaştırması.
 *
 * Testler izole, tek kullanımlık bir PostgreSQL veritabanına karşı çalışır
 * (bkz. `npm run test:db`, scripts/test-db-harness.mjs) — gerçek Decimal
 * kolon davranışı (Decimal(18,2)) ve gerçek `groupBy` semantiği taklit
 * EDİLMEZ.
 *
 * Zaman: tüm dönem testleri SABİT bir `now` enjekte eder — testlerin
 * çalıştırıldığı takvim ayına göre davranış değiştirmemesi için (bkz.
 * `GetProjectMarginComparisonOptions.now`).
 */

/** Sabit referans an: 15 Haziran 2026 (Istanbul takvimine göre Haziran ayının ortası). */
const NOW = new Date("2026-06-15T09:00:00.000Z");
/** CURRENT_MONTH kapsamında (Haziran 2026). */
const IN_CURRENT = new Date("2026-06-10T12:00:00.000Z");
/** Bir önceki eşdeğer dönem kapsamında (Mayıs 2026). */
const IN_PRIOR = new Date("2026-05-10T12:00:00.000Z");
/** Her iki dönemin de DIŞINDA (Nisan 2026). */
const OUTSIDE_BOTH = new Date("2026-04-10T12:00:00.000Z");

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
function key() {
  seq += 1;
  return `pm-test-${seq}-${Math.floor(Math.random() * 1e9)}`;
}

async function seedProject(owner: SessionUser, overrides: { code?: string; contractAmount?: number } = {}) {
  seq += 1;
  return createProject(owner, {
    code: overrides.code ?? `PRJ-${seq}-${Math.floor(Math.random() * 1e6)}`,
    name: `Proje ${seq}`,
    customerId: undefined,
    city: "",
    district: "",
    address: "",
    startDate: undefined,
    plannedEndDate: undefined,
    contractAmount: overrides.contractAmount ?? 0,
    estimatedBudget: 0,
    notes: "",
  });
}

async function seedCategory(owner: SessionUser, type: TransactionType) {
  seq += 1;
  return db.transactionCategory.create({
    data: { organizationId: owner.organizationId, type, name: `Kategori ${seq}` },
  });
}

async function seedIncome(owner: SessionUser, projectId: string, subtotal: number, issueDate = IN_CURRENT) {
  const category = await seedCategory(owner, "INCOME");
  return createIncome(owner, {
    categoryId: category.id,
    projectId,
    description: "Proje geliri",
    issueDate,
    subtotal,
    taxRate: 0,
  });
}

async function seedExpense(owner: SessionUser, projectId: string, subtotal: number, issueDate = IN_CURRENT) {
  const category = await seedCategory(owner, "EXPENSE");
  return createExpense(owner, {
    categoryId: category.id,
    projectId,
    description: "Proje gideri",
    issueDate,
    subtotal,
    taxRate: 0,
  });
}

/**
 * Decimal hassasiyeti/çok büyük tutar senaryoları için DOĞRUDAN kayıt yazar.
 * Gerekçe: `createIncomeSchema.subtotal` bir JS `number`'dır (form sınırı),
 * bu yüzden `Decimal(18,2)` kolonunun üst bölgesindeki tutarlar servis
 * girdisinden GEÇİRİLEMEZ. Burada test edilen şey servisin ARİTMETİĞİdir —
 * kayıt oluşturma yolu değil (o `seedIncome`/`seedExpense` ile zaten kapsanır).
 */
async function seedRawTransaction(
  owner: SessionUser,
  projectId: string,
  type: TransactionType,
  totalAmount: string,
  issueDate = IN_CURRENT,
) {
  const category = await seedCategory(owner, type);
  return db.financialTransaction.create({
    data: {
      organizationId: owner.organizationId,
      projectId,
      type,
      categoryId: category.id,
      description: `Ham ${type} kaydı`,
      issueDate,
      subtotal: totalAmount,
      totalAmount,
      createdById: owner.id,
    },
  });
}

async function seedAccount(owner: SessionUser, openingBalance = 0) {
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

function rowFor(result: ProjectMarginComparison, projectId: string): ProjectMarginComparisonRow {
  const row = result.rows.find((r) => r.projectId === projectId);
  if (!row) throw new Error(`Proje sonucu bulunamadı: ${projectId}`);
  return row;
}

describe("YF-702-F2 — dönem ve marj semantiği", () => {
  it("cari dönem sonuçları kanonik getProjectFinanceSummary değerleriyle birebir eşleşir", async () => {
    const { owner } = await createOwnerOrg();
    const project = await seedProject(owner);
    await seedIncome(owner, project.id, 100000);
    await seedIncome(owner, project.id, 50000);
    await seedExpense(owner, project.id, 60000);

    // Tüm kayıtlar cari dönemin içindedir; bu yüzden özet servisinin ömür
    // boyu toplamları ile toplu servisin dönem toplamları KARŞILAŞTIRILABİLİR.
    const summary = await getProjectFinanceSummary(owner, project.id);
    const bulk = await getProjectMarginComparison(owner, { period: "CURRENT_MONTH", now: NOW });
    const row = rowFor(bulk, project.id);

    expect(row.current.revenue).toBe(summary.totalRecordedIncome);
    expect(row.current.expense).toBe(summary.totalRecordedExpense);
    expect(row.current.profit).toBe(summary.accrualResult);
    expect(row.current.revenue).toBe("150000");
    expect(row.current.expense).toBe("60000");
    expect(row.current.profit).toBe("90000");
    expect(row.current.margin).toBe("60");
    expect(row.current.marginAvailable).toBe(true);
  });

  it("cari ve önceki dönem örtüşmez ve kayıtlar doğru tarafa düşer", async () => {
    const { owner } = await createOwnerOrg();
    const project = await seedProject(owner);
    await seedIncome(owner, project.id, 200000, IN_CURRENT);
    await seedExpense(owner, project.id, 150000, IN_CURRENT);
    await seedIncome(owner, project.id, 100000, IN_PRIOR);
    await seedExpense(owner, project.id, 40000, IN_PRIOR);

    const bulk = await getProjectMarginComparison(owner, { period: "CURRENT_MONTH", now: NOW });
    const row = rowFor(bulk, project.id);

    expect(bulk.priorPeriod.end.getTime()).toBe(bulk.currentPeriod.start.getTime());
    expect(bulk.priorPeriod.start.getTime()).toBeLessThan(bulk.priorPeriod.end.getTime());

    expect(row.current.revenue).toBe("200000");
    expect(row.current.expense).toBe("150000");
    expect(row.current.profit).toBe("50000");
    expect(row.current.margin).toBe("25");

    expect(row.prior.revenue).toBe("100000");
    expect(row.prior.expense).toBe("40000");
    expect(row.prior.profit).toBe("60000");
    expect(row.prior.margin).toBe("60");
  });

  it("her iki dönemin de dışındaki kayıtlar hiçbir tarafa dahil edilmez", async () => {
    const { owner } = await createOwnerOrg();
    const project = await seedProject(owner);
    await seedIncome(owner, project.id, 999999, OUTSIDE_BOTH);
    await seedExpense(owner, project.id, 999999, OUTSIDE_BOTH);

    const row = rowFor(await getProjectMarginComparison(owner, { period: "CURRENT_MONTH", now: NOW }), project.id);

    expect(row.current.revenue).toBe("0");
    expect(row.prior.revenue).toBe("0");
    expect(row.current.expense).toBe("0");
    expect(row.prior.expense).toBe("0");
  });

  it("CURRENT_YEAR ve LAST_12_MONTHS dönemleri de bitişik ve örtüşmesiz üretilir", async () => {
    const { owner } = await createOwnerOrg();
    for (const period of ["CURRENT_YEAR", "LAST_12_MONTHS"] as const) {
      const bulk = await getProjectMarginComparison(owner, { period, now: NOW });
      expect(bulk.period).toBe(period);
      expect(bulk.priorPeriod.end.getTime()).toBe(bulk.currentPeriod.start.getTime());
      expect(bulk.priorPeriod.start.getTime()).toBeLessThan(bulk.priorPeriod.end.getTime());
    }
  });
});

describe("YF-702-F2 — sınır durumları", () => {
  it("gelir sıfırken marj null döner, %0 uydurulmaz", async () => {
    const { owner } = await createOwnerOrg();
    const project = await seedProject(owner);
    await seedExpense(owner, project.id, 25000);

    const row = rowFor(await getProjectMarginComparison(owner, { period: "CURRENT_MONTH", now: NOW }), project.id);

    expect(row.current.revenue).toBe("0");
    expect(row.current.expense).toBe("25000");
    expect(row.current.profit).toBe("-25000");
    expect(row.current.margin).toBeNull();
    expect(row.current.marginAvailable).toBe(false);
  });

  it("gider sıfırken marj %100'dür", async () => {
    const { owner } = await createOwnerOrg();
    const project = await seedProject(owner);
    await seedIncome(owner, project.id, 80000);

    const row = rowFor(await getProjectMarginComparison(owner, { period: "CURRENT_MONTH", now: NOW }), project.id);

    expect(row.current.expense).toBe("0");
    expect(row.current.profit).toBe("80000");
    expect(row.current.margin).toBe("100");
  });

  it("hiç hareketi olmayan proje sıfır değerlerle ve tanımsız marjla döner", async () => {
    const { owner } = await createOwnerOrg();
    const project = await seedProject(owner);

    const row = rowFor(await getProjectMarginComparison(owner, { period: "CURRENT_MONTH", now: NOW }), project.id);

    for (const side of [row.current, row.prior]) {
      expect(side.revenue).toBe("0");
      expect(side.expense).toBe("0");
      expect(side.profit).toBe("0");
      expect(side.margin).toBeNull();
      expect(side.marginAvailable).toBe(false);
    }
  });

  it("gider geliri aştığında kâr ve marj negatiftir", async () => {
    const { owner } = await createOwnerOrg();
    const project = await seedProject(owner);
    await seedIncome(owner, project.id, 40000);
    await seedExpense(owner, project.id, 60000);

    const row = rowFor(await getProjectMarginComparison(owner, { period: "CURRENT_MONTH", now: NOW }), project.id);

    expect(row.current.profit).toBe("-20000");
    expect(row.current.margin).toBe("-50");
  });

  it("marj iki ondalık basamağa yuvarlanır", async () => {
    const { owner } = await createOwnerOrg();
    const project = await seedProject(owner);
    await seedIncome(owner, project.id, 3);
    await seedExpense(owner, project.id, 1);

    const row = rowFor(await getProjectMarginComparison(owner, { period: "CURRENT_MONTH", now: NOW }), project.id);

    // 2 / 3 = 0,6666... → %66,67
    expect(row.current.margin).toBe("66.67");
  });

  it("kayan nokta hatası üretecek tutarlarda kâr tam Decimal olarak hesaplanır", async () => {
    const { owner } = await createOwnerOrg();
    const project = await seedProject(owner);
    await seedRawTransaction(owner, project.id, "INCOME", "0.30");
    await seedRawTransaction(owner, project.id, "EXPENSE", "0.10");

    const row = rowFor(await getProjectMarginComparison(owner, { period: "CURRENT_MONTH", now: NOW }), project.id);

    // JS number aritmetiğinde 0.3 - 0.1 = 0.19999999999999998 olurdu.
    expect(row.current.profit).toBe("0.2");
    expect(row.current.margin).toBe("66.67");
  });

  it("çok büyük Decimal tutarlarda hassasiyet korunur", async () => {
    const { owner } = await createOwnerOrg();
    const project = await seedProject(owner);
    await seedRawTransaction(owner, project.id, "INCOME", "9999999999999.99");
    await seedRawTransaction(owner, project.id, "EXPENSE", "0.01");

    const row = rowFor(await getProjectMarginComparison(owner, { period: "CURRENT_MONTH", now: NOW }), project.id);

    expect(row.current.revenue).toBe("9999999999999.99");
    expect(row.current.expense).toBe("0.01");
    expect(row.current.profit).toBe("9999999999999.98");
  });
});

describe("YF-702-F2 — işlem semantiği", () => {
  it("iptal edilmiş gider toplamlardan hariç tutulur", async () => {
    const { owner } = await createOwnerOrg();
    const project = await seedProject(owner);
    await seedIncome(owner, project.id, 100000);
    await seedExpense(owner, project.id, 30000);
    const cancelled = await seedExpense(owner, project.id, 70000);
    await cancelExpense(owner, { id: cancelled.id, reason: "Yanlış kayıt" });

    const row = rowFor(await getProjectMarginComparison(owner, { period: "CURRENT_MONTH", now: NOW }), project.id);

    expect(row.current.expense).toBe("30000");
    expect(row.current.profit).toBe("70000");
    expect(row.current.margin).toBe("70");
  });

  it("hesaplar arası transfer proje geliri/gideri olarak sayılmaz", async () => {
    const { owner } = await createOwnerOrg();
    const project = await seedProject(owner);
    await seedIncome(owner, project.id, 100000);
    await seedExpense(owner, project.id, 40000);

    const before = rowFor(await getProjectMarginComparison(owner, { period: "CURRENT_MONTH", now: NOW }), project.id);

    const from = await seedAccount(owner, 500000);
    const to = await seedAccount(owner, 0);
    await createTransfer(owner, {
      fromAccountId: from.id,
      toAccountId: to.id,
      amount: 250000,
      transferDate: IN_CURRENT,
      description: "Kasa aktarımı",
      idempotencyKey: key(),
    });

    const after = rowFor(await getProjectMarginComparison(owner, { period: "CURRENT_MONTH", now: NOW }), project.id);

    expect(after.current).toEqual(before.current);
    expect(after.current.revenue).toBe("100000");
    expect(after.current.expense).toBe("40000");
  });

  it("kısmi tahsilat/ödeme tahakkuk bazlı marjı değiştirmez", async () => {
    const { owner } = await createOwnerOrg();
    const project = await seedProject(owner);
    const income = await seedIncome(owner, project.id, 100000);
    const expense = await seedExpense(owner, project.id, 40000);

    const before = rowFor(await getProjectMarginComparison(owner, { period: "CURRENT_MONTH", now: NOW }), project.id);

    const account = await seedAccount(owner, 500000);
    await createSettlement(owner, {
      transactionId: income.id,
      financialAccountId: account.id,
      amount: 25000,
      settlementDate: IN_CURRENT,
      paymentMethod: "HAVALE_EFT",
      idempotencyKey: key(),
    });
    await createSettlement(owner, {
      transactionId: expense.id,
      financialAccountId: account.id,
      amount: 10000,
      settlementDate: IN_CURRENT,
      paymentMethod: "HAVALE_EFT",
      idempotencyKey: key(),
    });

    const after = rowFor(await getProjectMarginComparison(owner, { period: "CURRENT_MONTH", now: NOW }), project.id);

    expect(after.current).toEqual(before.current);
    expect(after.current.margin).toBe("60");
  });
});

describe("YF-702-F2 — tenant ve rol kapsamı", () => {
  it("organizasyon geneli yetkili aktör kapsamındaki tüm projeleri görür", async () => {
    const { owner } = await createOwnerOrg();
    const first = await seedProject(owner);
    const second = await seedProject(owner);
    await seedIncome(owner, first.id, 10000);

    const bulk = await getProjectMarginComparison(owner, { period: "CURRENT_MONTH", now: NOW });

    expect(bulk.scope).toBe("ORGANIZATION");
    expect(bulk.rows.map((r) => r.projectId).sort()).toEqual([first.id, second.id].sort());
  });

  it("PROJECT_MANAGER yalnızca atandığı projeleri görür", async () => {
    const { owner, organizationId } = await createOwnerOrg();
    const assigned = await seedProject(owner);
    const other = await seedProject(owner);
    await seedIncome(owner, assigned.id, 50000);
    await seedIncome(owner, other.id, 90000);

    const manager = await createOrgUser(organizationId, "PROJECT_MANAGER");
    await assignProjectMember(owner, assigned.id, manager.id);

    const bulk = await getProjectMarginComparison(manager, { period: "CURRENT_MONTH", now: NOW });

    expect(bulk.scope).toBe("PROJECT_MANAGER");
    expect(bulk.rows).toHaveLength(1);
    expect(bulk.rows[0].projectId).toBe(assigned.id);
    expect(bulk.rows[0].current.revenue).toBe("50000");
  });

  it("hiç projeye atanmamış PROJECT_MANAGER boş sonuç alır, organizasyon geneline DÜŞMEZ", async () => {
    const { owner, organizationId } = await createOwnerOrg();
    const project = await seedProject(owner);
    await seedIncome(owner, project.id, 400000);

    const manager = await createOrgUser(organizationId, "PROJECT_MANAGER");
    const bulk = await getProjectMarginComparison(manager, { period: "CURRENT_MONTH", now: NOW });

    expect(bulk.scope).toBe("PROJECT_MANAGER");
    expect(bulk.rows).toEqual([]);
  });

  it("başka organizasyonun proje verisi sızmaz", async () => {
    const { owner: ownerA } = await createOwnerOrg();
    const { owner: ownerB } = await createOwnerOrg();
    const projectA = await seedProject(ownerA);
    const projectB = await seedProject(ownerB);
    await seedIncome(ownerA, projectA.id, 11000);
    await seedIncome(ownerB, projectB.id, 22000);

    const bulkA = await getProjectMarginComparison(ownerA, { period: "CURRENT_MONTH", now: NOW });

    expect(bulkA.rows.map((r) => r.projectId)).toEqual([projectA.id]);
    expect(rowFor(bulkA, projectA.id).current.revenue).toBe("11000");
  });
});

// N+1 / sorgu sayısı regresyon testi AYRI bir dosyadadır
// (tests/project-margin-query-count.test.ts): sorgu sayacı `@/lib/db`
// modülünün tamamını sarmalar ve bu, dosya kapsamında bir mock gerektirir.
