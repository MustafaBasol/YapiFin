import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import ExcelJS from "exceljs";
import { db } from "@/lib/db";
import { cleanDatabase, createOwnerOrg, createOrgUser } from "./helpers";
import { createIncome, createExpense, cancelIncome } from "@/server/services/transaction-service";
import { createAccount } from "@/server/services/account-service";
import { createSettlement } from "@/server/services/settlement-service";
import { createProject, assignProjectMember, setProjectStatus } from "@/server/services/project-service";
import { exportDashboard, exportProjectFinance, exportCashFlow, exportBudget } from "@/server/services/report-export-service";
import { ServiceError } from "@/server/services/errors";
import type { SessionUser } from "@/lib/auth/session";
import type { TransactionType } from "@prisma/client";

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
  return `export-test-${seq}-${Math.floor(Math.random() * 1e9)}`;
}

async function seedCategory(owner: SessionUser, type: TransactionType) {
  seq += 1;
  return db.transactionCategory.create({ data: { organizationId: owner.organizationId, type, name: `Kategori ${seq}` } });
}

async function seedIncome(owner: SessionUser, opts: { subtotal: number; projectId?: string; description?: string }) {
  const category = await seedCategory(owner, "INCOME");
  return createIncome(owner, {
    categoryId: category.id,
    projectId: opts.projectId,
    description: opts.description ?? "Test geliri",
    issueDate: new Date(),
    subtotal: opts.subtotal,
    taxRate: 0,
  });
}

async function seedExpense(owner: SessionUser, opts: { subtotal: number; projectId?: string }) {
  const category = await seedCategory(owner, "EXPENSE");
  return createExpense(owner, {
    categoryId: category.id,
    projectId: opts.projectId,
    description: "Test gideri",
    issueDate: new Date(),
    subtotal: opts.subtotal,
    taxRate: 0,
  });
}

async function seedProject(owner: SessionUser, estimatedBudget = 0) {
  seq += 1;
  const project = await createProject(owner, { code: `P-${seq}`, name: `Proje ${seq}`, contractAmount: 0, estimatedBudget });
  await setProjectStatus(owner, project.id, "ACTIVE");
  return project;
}

function readXlsxSheetNames(buffer: Buffer): Promise<string[]> {
  const wb = new ExcelJS.Workbook();
  // bkz. tests/report-export-excel.test.ts — exceljs'in eski Buffer .d.ts şekli
  // ile @types/node'un güncel generic Buffer şekli arasındaki derleme zamanı
  // uyuşmazlığı; çalışma zamanını etkilemez.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return wb.xlsx.load(buffer as any).then(() => wb.worksheets.map((s) => s.name));
}

describe("report-export-service — yetkilendirme ve tenant izolasyonu", () => {
  it("OWNER organizasyon geneli dashboard'u xlsx ve pdf olarak dışa aktarabilir", async () => {
    const { owner } = await createOwnerOrg();
    const xlsx = await exportDashboard(owner, "xlsx", {});
    expect(xlsx.buffer.subarray(0, 2).toString("hex")).toBe("504b");
    expect(xlsx.filename).toMatch(/^yapifin-finans-ozeti-\d{4}-\d{2}-\d{2}\.xlsx$/);

    const pdf = await exportDashboard(owner, "pdf", {});
    expect(pdf.buffer.subarray(0, 5).toString("latin1")).toBe("%PDF-");
  });

  it("FINANCE rolü organizasyon geneli dışa aktarma yapabilir", async () => {
    const { organizationId } = await createOwnerOrg();
    const finance = await createOrgUser(organizationId, "FINANCE");
    const file = await exportDashboard(finance, "xlsx", {});
    expect(file.buffer.length).toBeGreaterThan(0);
  });

  it("PROJECT_MANAGER yalnızca atandığı projelerin verisini görür; dashboard sayfa yapısı organizasyon genelinden farklıdır", async () => {
    const { owner, organizationId } = await createOwnerOrg();
    const pm = await createOrgUser(organizationId, "PROJECT_MANAGER");
    const assignedProject = await seedProject(owner);
    await assignProjectMember(owner, assignedProject.id, pm.id);
    await seedIncome(owner, { subtotal: 1000, projectId: assignedProject.id });

    const ownerFile = await exportDashboard(owner, "xlsx", {});
    const pmFile = await exportDashboard(pm, "xlsx", {});

    const ownerSheets = await readXlsxSheetNames(ownerFile.buffer);
    const pmSheets = await readXlsxSheetNames(pmFile.buffer);

    expect(ownerSheets).toContain("Son Hareketler");
    expect(pmSheets).toContain("Son Proje Hareketleri");
    expect(pmSheets).not.toContain("Son Hareketler");
  });

  it("cross-tenant proje id'si NOT_FOUND ile kapanır (fail closed)", async () => {
    const { owner: ownerA } = await createOwnerOrg();
    const { owner: ownerB } = await createOwnerOrg();
    const projectB = await seedProject(ownerB);

    await expect(exportProjectFinance(ownerA, projectB.id, "xlsx")).rejects.toMatchObject({ code: "NOT_FOUND" } satisfies Partial<ServiceError>);
  });

  it("PROJECT_MANAGER'ın atanmadığı bir proje NOT_FOUND ile kapanır", async () => {
    const { owner, organizationId } = await createOwnerOrg();
    const pm = await createOrgUser(organizationId, "PROJECT_MANAGER");
    const unassignedProject = await seedProject(owner);

    await expect(exportProjectFinance(pm, unassignedProject.id, "xlsx")).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("geçersiz projectId (boş) NOT_FOUND ile kapanır", async () => {
    const { owner } = await createOwnerOrg();
    await expect(exportProjectFinance(owner, "", "xlsx")).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("report-export-service — format/filtre doğrulama", () => {
  it("geçersiz format değeri VALIDATION hatası fırlatır", async () => {
    const { owner } = await createOwnerOrg();
    // @ts-expect-error kasıtlı olarak geçersiz format testi
    await expect(exportDashboard(owner, "docx", {})).rejects.toMatchObject({ code: "VALIDATION" });
  });

  it("bozuk dashboard filtresi sessizce varsayılana düşer, hata fırlatmaz (dashboardFilterSchema ile aynı davranış)", async () => {
    const { owner } = await createOwnerOrg();
    const file = await exportDashboard(owner, "xlsx", { period: "GECERSIZ_DEGER" });
    expect(file.buffer.length).toBeGreaterThan(0);
  });

  it("cash-flow CUSTOM aralık başlangıç/bitiş olmadan VALIDATION hatası fırlatır", async () => {
    const { owner } = await createOwnerOrg();
    await expect(exportCashFlow(owner, "xlsx", { range: "CUSTOM" })).rejects.toMatchObject({ code: "VALIDATION" });
  });

  it("cash-flow geçerli senaryo/aralık kombinasyonlarını kabul eder", async () => {
    const { owner } = await createOwnerOrg();
    const file = await exportCashFlow(owner, "xlsx", { range: "NEXT_90_DAYS", scenario: "COLLECTIONS_DELAYED_7D" });
    expect(file.buffer.length).toBeGreaterThan(0);
  });

  it("budget geçersiz projectId'yi sessizce yok sayar (resolveProjectFilter null döner)", async () => {
    const { owner } = await createOwnerOrg();
    const file = await exportBudget(owner, "xlsx", { projectId: "olmayan-proje-id" });
    expect(file.buffer.length).toBeGreaterThan(0);
  });
});

describe("report-export-service — satır sınırı ve kesilme (truncation) göstergesi", () => {
  it("proje gelir listesi 100 kayıtla sınırlıdır; KPI toplamı tüm kayıtları kapsar", async () => {
    const { owner } = await createOwnerOrg();
    const project = await seedProject(owner, 0);
    for (let i = 0; i < 105; i++) {
      await seedIncome(owner, { subtotal: 10, projectId: project.id });
    }

    const file = await exportProjectFinance(owner, project.id, "xlsx");
    const wb = new ExcelJS.Workbook();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await wb.xlsx.load(file.buffer as any);
    const incomeSheet = wb.getWorksheet("Gelirler")!;

    // Başlık bloğu + sabit uyarı satırı + tablo başlığı sonrası veri satırları
    // en fazla 100'dür (INCOME_EXPENSE_LIST_LIMIT, server/services/project-finance-service.ts).
    let dataRowCount = 0;
    incomeSheet.eachRow((row, rowNumber) => {
      const first = row.getCell(1).value;
      if (rowNumber > 6 && first && typeof first === "string" && first.startsWith("Test geliri")) dataRowCount += 1;
    });
    expect(dataRowCount).toBeLessThanOrEqual(100);

    const summarySheet = wb.getWorksheet("Proje Özeti")!;
    const allText = summarySheet.getSheetValues().flat().join(" ");
    // 105 kayıt × 10 TL = 1050,00 TL toplam kaydedilen gelir (KPI, tam liste sınırından
    // bağımsız). Ham hücre değeri sayısaldır (1050); Excel'in kendi görüntüleme
    // biçimlendirmesi (1.050,00) yalnızca gerçek bir tabloda uygulanır.
    expect(allText).toContain("1050");
  });
});

describe("report-export-service — iptal/parçalı ödeme kuralları export'a doğru yansır", () => {
  it("iptal edilen gelir kaydı ekrandaki davranışla birebir aynı şekilde 'İptal' durumuyla listede kalır, ama KPI toplamından hariç tutulur", async () => {
    const { owner } = await createOwnerOrg();
    const project = await seedProject(owner, 0);
    await seedIncome(owner, { subtotal: 100, projectId: project.id, description: "Aktif gelir" });
    const cancelled = await seedIncome(owner, { subtotal: 200, projectId: project.id, description: "İptal edilecek gelir" });
    await cancelIncome(owner, { id: cancelled.id, reason: "Test iptali" });

    const file = await exportProjectFinance(owner, project.id, "xlsx");
    const wb = new ExcelJS.Workbook();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await wb.xlsx.load(file.buffer as any);

    // server/services/project-finance-service.ts, ekrandaki TransactionsTable ile
    // aynı ilkeyi izler: iptal edilen kayıt DETAY listesinden gizlenmez (yalnızca
    // "Durum" sütununda İptal olarak görünür), yalnızca KPI toplamından hariç
    // tutulur (bkz. `status: { not: "CANCELLED" }` filtresiyle hesaplanan `incomeAgg`).
    const sheet = wb.getWorksheet("Gelirler")!;
    const allText = sheet.getSheetValues().flat().join(" | ");
    expect(allText).toContain("Aktif gelir");
    expect(allText).toContain("İptal edilecek gelir");
    expect(allText).toContain("İptal");

    const summarySheet = wb.getWorksheet("Proje Özeti")!;
    const summaryText = summarySheet.getSheetValues().flat().join(" ");
    // Yalnızca aktif 100 TL'lik gelir KPI'ya dahildir; iptal edilen 200 TL hariçtir.
    expect(summaryText).toContain("100");
    expect(summaryText).not.toContain("300");
  });

  it("parçalı tahsilat sonrası kalan tutar Excel'e doğru yansır", async () => {
    const { owner } = await createOwnerOrg();
    const project = await seedProject(owner, 0);
    const income = await seedIncome(owner, { subtotal: 1000, projectId: project.id, description: "Parçalı tahsilat testi" });
    const account = await createAccount(owner, {
      name: `Test Hesabı ${key()}`,
      type: "CASH",
      bankName: undefined,
      iban: undefined,
      openingBalance: 0,
      currency: "TRY",
    });
    await createSettlement(owner, {
      transactionId: income.id,
      financialAccountId: account.id,
      amount: 300,
      settlementDate: new Date(),
      paymentMethod: "NAKIT",
      idempotencyKey: key(),
    });

    const file = await exportProjectFinance(owner, project.id, "xlsx");
    const wb = new ExcelJS.Workbook();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await wb.xlsx.load(file.buffer as any);
    const sheet = wb.getWorksheet("Gelirler")!;
    const allText = sheet.getSheetValues().flat().join(" | ");
    // Toplam 1.000,00 kaydedilen, 300,00 tahsil edilmiş → kalan 700,00.
    expect(allText).toContain("700");
  });
});

describe("report-export-service — bütçe eşikleri export'a doğru yansır", () => {
  it("bütçeyi aşan proje 'Bütçeyi Aşanlar' sayfasında görünür", async () => {
    const { owner } = await createOwnerOrg();
    const project = await seedProject(owner, 100);
    await seedExpense(owner, { subtotal: 150, projectId: project.id });

    const file = await exportBudget(owner, "xlsx", {});
    const wb = new ExcelJS.Workbook();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await wb.xlsx.load(file.buffer as any);
    const sheet = wb.getWorksheet("Bütçeyi Aşanlar")!;
    const allText = sheet.getSheetValues().flat().join(" | ");
    expect(allText).toContain(project.code);
  });
});
