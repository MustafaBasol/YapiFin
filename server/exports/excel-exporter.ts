import ExcelJS from "exceljs";
import { toExcelAmountCell } from "@/server/exports/money";
import { formatDateTime } from "@/lib/utils";
import { transactionStatusLabel } from "@/components/app/transaction-status";
import type { ExportMeta } from "@/server/services/report-export-service";
import type { DashboardData, OrganizationDashboardData, ProjectManagerDashboardData } from "@/server/services/dashboard-service";
import type { ProjectFinanceSummary } from "@/server/services/project-finance-service";
import type { CashFlowReport, MaturityListRow, MaturityBuckets } from "@/server/services/cash-flow-report-service";
import type { BudgetReport } from "@/server/services/budget-report-service";

/**
 * YF-405 — ExcelJS ile `.xlsx` üretimi. Bu dosya hiçbir finansal toplamı
 * yeniden hesaplamaz; yalnızca YF-401–404 servislerinin ürettiği DTO'ları
 * biçimlendirir. Formül/CSV enjeksiyonu (`sanitizeExcelText`) ve Decimal→
 * Excel sayısal hassasiyet sınırı (`toExcelAmountCell`, bkz.
 * server/exports/money.ts) her serbest metin/para hücresinde uygulanır.
 */

// ---------------------------------------------------------------------------
// Formula/CSV enjeksiyon koruması
// ---------------------------------------------------------------------------

const DANGEROUS_LEADING_CHARS = new Set(["=", "+", "-", "@"]);
/** Baştaki boşluk/denetim karakterlerini (sekme, CR, LF, diğer C0) atlayarak ilk "gerçek" karakteri kontrol eder. */
const LEADING_WHITESPACE_OR_CONTROL = /^[\s\x00-\x1F]+/;

export function sanitizeExcelText(raw: string): string {
  const stripped = raw.replace(LEADING_WHITESPACE_OR_CONTROL, "");
  const firstChar = stripped.charAt(0);
  if (firstChar && DANGEROUS_LEADING_CHARS.has(firstChar)) {
    return `'${raw}`;
  }
  return raw;
}

// ---------------------------------------------------------------------------
// Ortak stil/başlık yardımcıları
// ---------------------------------------------------------------------------

const TITLE_FONT: Partial<ExcelJS.Font> = { bold: true, size: 14 };
const META_FONT: Partial<ExcelJS.Font> = { size: 10, color: { argb: "FF64748B" } };
const HEADER_FONT: Partial<ExcelJS.Font> = { bold: true, size: 10, color: { argb: "FFFFFFFF" } };
const HEADER_FILL: ExcelJS.Fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF0F3D3E" } };

function writeHeaderBlock(sheet: ExcelJS.Worksheet, title: string, meta: ExportMeta): number {
  sheet.getCell("A1").value = title;
  sheet.getCell("A1").font = TITLE_FONT;
  sheet.getCell("A2").value = meta.organizationName;
  sheet.getCell("A2").font = META_FONT;
  sheet.getCell("A3").value = `Oluşturulma: ${formatDateTime(meta.generatedAt)}`;
  sheet.getCell("A3").font = META_FONT;
  sheet.getCell("A4").value = `Dönem: ${meta.periodLabel}`;
  sheet.getCell("A4").font = META_FONT;
  let row = 5;
  if (meta.scopeNote) {
    sheet.getCell(`A${row}`).value = meta.scopeNote;
    sheet.getCell(`A${row}`).font = META_FONT;
    row += 1;
  }
  return row + 1; // bir boş satır bırak
}

function writeNoteRow(sheet: ExcelJS.Worksheet, row: number, columnCount: number, note: string): number {
  sheet.mergeCells(row, 1, row, Math.max(columnCount, 1));
  const cell = sheet.getCell(row, 1);
  cell.value = sanitizeExcelText(note);
  cell.font = { italic: true, size: 9, color: { argb: "FFB45309" } };
  return row + 1;
}

type ColumnType = "text" | "money" | "date" | "datetime" | "percent" | "number";

interface ColumnDef<T> {
  header: string;
  width?: number;
  type: ColumnType;
  get: (row: T) => string | number | Date | null;
}

function writeCell(sheet: ExcelJS.Worksheet, rowNumber: number, colNumber: number, type: ColumnType, value: string | number | Date | null) {
  const cell = sheet.getCell(rowNumber, colNumber);
  if (value === null || value === undefined) {
    cell.value = "—";
    return;
  }
  switch (type) {
    case "text":
      cell.value = sanitizeExcelText(String(value));
      break;
    case "money": {
      const amount = toExcelAmountCell(String(value));
      if (amount.kind === "numeric") {
        cell.value = amount.value;
        cell.numFmt = '#,##0.00 "₺"';
      } else {
        cell.value = sanitizeExcelText(amount.value);
      }
      break;
    }
    case "percent":
      cell.value = Number(value);
      cell.numFmt = '0.00"%"';
      break;
    case "number":
      cell.value = Number(value);
      cell.numFmt = "#,##0.00";
      break;
    case "date":
      cell.value = value instanceof Date ? value : new Date(value);
      cell.numFmt = "dd.mm.yyyy";
      break;
    case "datetime":
      cell.value = value instanceof Date ? value : new Date(value);
      cell.numFmt = "dd.mm.yyyy hh:mm";
      break;
  }
}

function addTableSheet<T>(
  workbook: ExcelJS.Workbook,
  sheetName: string,
  title: string,
  meta: ExportMeta,
  columns: ColumnDef<T>[],
  rows: T[],
  opts?: { truncationNote?: string; emptyNote?: string },
): ExcelJS.Worksheet {
  const sheet = workbook.addWorksheet(sheetName);
  let row = writeHeaderBlock(sheet, title, meta);

  if (opts?.truncationNote) {
    row = writeNoteRow(sheet, row, columns.length, opts.truncationNote);
  }

  const headerRowNumber = row;
  columns.forEach((col, i) => {
    const cell = sheet.getCell(headerRowNumber, i + 1);
    cell.value = col.header;
    cell.font = HEADER_FONT;
    cell.fill = HEADER_FILL;
    sheet.getColumn(i + 1).width = col.width ?? 18;
  });

  if (rows.length === 0 && opts?.emptyNote) {
    writeNoteRow(sheet, headerRowNumber + 1, columns.length, opts.emptyNote);
  } else {
    rows.forEach((r, rIdx) => {
      columns.forEach((col, cIdx) => {
        writeCell(sheet, headerRowNumber + 1 + rIdx, cIdx + 1, col.type, col.get(r));
      });
    });
  }

  sheet.views = [{ state: "frozen", ySplit: headerRowNumber }];
  if (rows.length > 0) {
    sheet.autoFilter = {
      from: { row: headerRowNumber, column: 1 },
      to: { row: headerRowNumber, column: columns.length },
    };
  }
  return sheet;
}

interface SummaryRow {
  label: string;
  value: string | number;
  type: "text" | "money" | "percent" | "number";
}

function addSummarySheet(workbook: ExcelJS.Workbook, sheetName: string, title: string, meta: ExportMeta, rows: SummaryRow[]): ExcelJS.Worksheet {
  const sheet = workbook.addWorksheet(sheetName);
  const row = writeHeaderBlock(sheet, title, meta);

  const headerRowNumber = row;
  sheet.getCell(headerRowNumber, 1).value = "Metrik";
  sheet.getCell(headerRowNumber, 2).value = "Değer";
  sheet.getRow(headerRowNumber).font = HEADER_FONT;
  sheet.getRow(headerRowNumber).eachCell((c) => (c.fill = HEADER_FILL));
  sheet.getColumn(1).width = 34;
  sheet.getColumn(2).width = 24;

  rows.forEach((r, i) => {
    const rowNumber = headerRowNumber + 1 + i;
    sheet.getCell(rowNumber, 1).value = sanitizeExcelText(r.label);
    writeCell(sheet, rowNumber, 2, r.type, r.value);
  });

  sheet.views = [{ state: "frozen", ySplit: headerRowNumber }];
  return sheet;
}

function newWorkbook(): ExcelJS.Workbook {
  const wb = new ExcelJS.Workbook();
  wb.creator = "YapiFin";
  wb.created = new Date();
  return wb;
}

async function finalize(wb: ExcelJS.Workbook): Promise<Buffer> {
  return Buffer.from(await wb.xlsx.writeBuffer());
}

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------

export async function buildDashboardWorkbook(data: DashboardData, meta: ExportMeta): Promise<Buffer> {
  const wb = newWorkbook();
  const isOrg = data.scope === "ORGANIZATION";

  const summaryRows: SummaryRow[] = [
    { label: "Toplam Tahsilat", value: data.kpis.collectedIncome, type: "money" },
    { label: "Toplam Ödeme", value: data.kpis.paidExpense, type: "money" },
    { label: "Net Nakit Akışı", value: data.kpis.netCashFlow, type: "money" },
    { label: "Açık Alacak", value: data.kpis.openReceivable, type: "money" },
    { label: "Vadesi Geçen Alacak", value: data.kpis.overdueReceivable, type: "money" },
    { label: "Açık Borç", value: data.kpis.openPayable, type: "money" },
    { label: "Vadesi Geçen Borç", value: data.kpis.overduePayable, type: "money" },
    { label: "Aktif Proje", value: data.kpis.activeProjectCount, type: "number" },
    { label: "Toplam/Atanmış Proje", value: data.kpis.totalProjectCount, type: "number" },
    { label: "Bütçesi Kritik Proje", value: data.kpis.budgetCriticalProjectCount, type: "number" },
  ];
  if (isOrg) {
    const org = data as OrganizationDashboardData;
    summaryRows.splice(4, 0, { label: "Kasa ve Banka Bakiyesi", value: org.kpis.cashAndBankBalance, type: "money" });
    summaryRows.push(
      { label: "Aktif Müşteri", value: org.kpis.activeCustomerCount, type: "number" },
      { label: "Aktif Tedarikçi/Taşeron", value: org.kpis.activeSupplierCount, type: "number" },
    );
  }
  addSummarySheet(wb, "Özet", "YapiFin — Finansal Panel Özeti", meta, summaryRows);

  addTableSheet(
    wb,
    "Aylık Nakit Akışı",
    "Aylık Tahsilat / Ödeme",
    meta,
    [
      { header: "Ay", width: 14, type: "text", get: (r: DashboardData["monthlySeries"][number]) => r.label },
      { header: "Tahsilat", width: 18, type: "number", get: (r) => r.collected },
      { header: "Ödeme", width: 18, type: "number", get: (r) => r.paid },
      { header: "Net", width: 18, type: "number", get: (r) => r.net },
    ],
    data.monthlySeries,
  );

  addTableSheet(
    wb,
    "Gider Kategorileri",
    "Gider Kategorisi Dağılımı",
    meta,
    [
      { header: "Kategori", width: 28, type: "text", get: (r: DashboardData["expenseCategoryDistribution"][number]) => r.name },
      { header: "Tutar", width: 18, type: "money", get: (r) => r.amount },
    ],
    data.expenseCategoryDistribution,
    { emptyNote: "Seçilen dönemde gider kaydı bulunmuyor." },
  );

  if (isOrg) {
    const org = data as OrganizationDashboardData;
    addTableSheet(
      wb,
      "Son Hareketler",
      "Son Finansal Hareketler",
      meta,
      [
        { header: "Tarih", width: 18, type: "datetime", get: (r: OrganizationDashboardData["recentMovements"][number]) => r.occurredAt },
        { header: "Hesap", width: 20, type: "text", get: (r) => r.accountName },
        { header: "Açıklama", width: 30, type: "text", get: (r) => r.description },
        { header: "Proje", width: 20, type: "text", get: (r) => r.relatedProjectName ?? "—" },
        { header: "Yön", width: 10, type: "text", get: (r) => (r.direction === "CREDIT" ? "Giriş" : "Çıkış") },
        { header: "Tutar", width: 18, type: "money", get: (r) => r.amount },
      ],
      org.recentMovements,
      { emptyNote: "Hareket bulunmuyor." },
    );
  } else {
    const pm = data as ProjectManagerDashboardData;
    addTableSheet(
      wb,
      "Son Proje Hareketleri",
      "Son Proje Hareketleri",
      meta,
      [
        { header: "Tarih", width: 16, type: "date", get: (r: ProjectManagerDashboardData["recentProjectActivity"][number]) => r.issueDate },
        { header: "Proje", width: 20, type: "text", get: (r) => r.projectName },
        { header: "Açıklama", width: 30, type: "text", get: (r) => r.description },
        { header: "Tür", width: 12, type: "text", get: (r) => (r.type === "INCOME" ? "Gelir" : "Gider") },
        { header: "Tutar", width: 18, type: "money", get: (r) => r.totalAmount },
      ],
      pm.recentProjectActivity,
      { emptyNote: "Hareket bulunmuyor." },
    );
  }

  addTableSheet(
    wb,
    "Yaklaşan Tahsilatlar",
    "Yaklaşan Tahsilatlar (30 gün)",
    meta,
    [
      { header: "Açıklama", width: 28, type: "text", get: (r: DashboardData["upcomingCollections"][number]) => r.description },
      { header: "Müşteri", width: 22, type: "text", get: (r) => r.counterpartName ?? "—" },
      { header: "Proje", width: 20, type: "text", get: (r) => r.projectName ?? "—" },
      { header: "Vade Tarihi", width: 14, type: "date", get: (r) => r.dueDate },
      { header: "Kalan Tutar", width: 18, type: "money", get: (r) => r.remainingAmount },
    ],
    data.upcomingCollections,
    { emptyNote: "Yaklaşan tahsilat bulunmuyor." },
  );

  addTableSheet(
    wb,
    "Yaklaşan Ödemeler",
    "Yaklaşan Ödemeler (30 gün)",
    meta,
    [
      { header: "Açıklama", width: 28, type: "text", get: (r: DashboardData["upcomingPayments"][number]) => r.description },
      { header: "Tedarikçi/Taşeron", width: 22, type: "text", get: (r) => r.counterpartName ?? "—" },
      { header: "Proje", width: 20, type: "text", get: (r) => r.projectName ?? "—" },
      { header: "Vade Tarihi", width: 14, type: "date", get: (r) => r.dueDate },
      { header: "Kalan Tutar", width: 18, type: "money", get: (r) => r.remainingAmount },
    ],
    data.upcomingPayments,
    { emptyNote: "Yaklaşan ödeme bulunmuyor." },
  );

  return finalize(wb);
}

// ---------------------------------------------------------------------------
// Project finance
// ---------------------------------------------------------------------------

const PROJECT_LIST_CAP_NOTE = "Bu liste en fazla 100 kayıt gösterir; KPI toplamları tüm kayıtları kapsar.";

export async function buildProjectFinanceWorkbook(data: ProjectFinanceSummary, meta: ExportMeta): Promise<Buffer> {
  const wb = newWorkbook();

  const summaryRows: SummaryRow[] = [
    { label: "Proje", value: `${data.projectCode} — ${data.projectName}`, type: "text" },
    { label: "Müşteri", value: data.customerName ?? "—", type: "text" },
    { label: "Sözleşme Bedeli", value: data.contractAmount, type: "money" },
    { label: "Tahmini Bütçe", value: data.estimatedBudget, type: "money" },
    { label: "Kaydedilen Gelir", value: data.totalRecordedIncome, type: "money" },
    { label: "Tahsil Edilen", value: data.totalCollected, type: "money" },
    { label: "Kalan Alacak", value: data.remainingReceivable, type: "money" },
    { label: "Kaydedilen Gider", value: data.totalRecordedExpense, type: "money" },
    { label: "Ödenen", value: data.totalPaid, type: "money" },
    { label: "Kalan Borç", value: data.remainingPayable, type: "money" },
    { label: "Nakit Pozisyonu", value: data.cashPosition, type: "money" },
    { label: "Tahakkuk Bazlı Sonuç", value: data.accrualResult, type: "money" },
    {
      label: "Tahmini Brüt Kâr",
      value: data.estimatedProfitAvailable && data.estimatedGrossProfit ? data.estimatedGrossProfit : "Desteklenmiyor",
      type: data.estimatedProfitAvailable ? "money" : "text",
    },
    {
      label: "Tahmini Kâr Marjı",
      value: data.estimatedProfitMargin ? `%${data.estimatedProfitMargin}` : "Desteklenmiyor",
      type: "text",
    },
    { label: "Bütçe Kullanımı", value: data.budgetAvailable ? `%${data.budgetUsedRatio}` : "Bütçe girilmemiş", type: "text" },
    { label: "Kalan Bütçe", value: data.remainingBudget, type: "money" },
    { label: "Bütçe Aşıldı mı?", value: data.isBudgetOverrun ? "Evet" : "Hayır", type: "text" },
  ];
  addSummarySheet(wb, "Proje Özeti", `Proje Finans Özeti — ${data.projectCode}`, meta, summaryRows);

  // Not: bu liste, ekrandaki TransactionsTable ile aynı ilkeyi izler — iptal
  // edilmiş kayıtlar listeden gizlenmez, "Durum" sütununda "İptal" olarak
  // işaretlenir (bkz. server/services/project-finance-service.ts — yalnızca
  // KPI toplamları status != CANCELLED filtresiyle hesaplanır, detay listesi
  // değil). Export bu davranışı DEĞİŞTİRMEZ, yalnızca aynı şekilde sunar.
  const txColumns = (type: "INCOME" | "EXPENSE"): ColumnDef<ProjectFinanceSummary["incomeList"][number]>[] => [
    { header: "Açıklama", width: 26, type: "text", get: (r) => r.description },
    { header: "Kategori", width: 18, type: "text", get: (r) => r.categoryName },
    { header: "Karşı Taraf", width: 20, type: "text", get: (r) => r.counterpartName ?? "—" },
    { header: "Tutar", width: 15, type: "money", get: (r) => r.totalAmount },
    { header: "Kalan", width: 15, type: "money", get: (r) => r.remainingAmount },
    { header: "Düzenleme Tarihi", width: 15, type: "date", get: (r) => r.issueDate },
    { header: "Vade Tarihi", width: 13, type: "date", get: (r) => r.dueDate },
    { header: "Durum", width: 16, type: "text", get: (r) => transactionStatusLabel(r.status, type) },
  ];
  addTableSheet(wb, "Gelirler", "Gelirler", meta, txColumns("INCOME"), data.incomeList, {
    truncationNote: PROJECT_LIST_CAP_NOTE,
    emptyNote: "Gelir kaydı bulunmuyor.",
  });
  addTableSheet(wb, "Giderler", "Giderler", meta, txColumns("EXPENSE"), data.expenseList, {
    truncationNote: PROJECT_LIST_CAP_NOTE,
    emptyNote: "Gider kaydı bulunmuyor.",
  });

  const settlementColumns: ColumnDef<ProjectFinanceSummary["settlements"][number]>[] = [
    { header: "Tarih", width: 14, type: "date", get: (r) => r.settlementDate },
    { header: "Hesap", width: 20, type: "text", get: (r) => r.accountName },
    { header: "İlgili Kayıt", width: 28, type: "text", get: (r) => r.relatedDescription },
    { header: "Tutar", width: 16, type: "money", get: (r) => r.amount },
  ];
  addTableSheet(
    wb,
    "Tahsilatlar",
    "Tahsilatlar",
    meta,
    settlementColumns,
    data.settlements.filter((s) => s.type === "COLLECTION"),
    { emptyNote: "Tahsilat kaydı bulunmuyor." },
  );
  addTableSheet(
    wb,
    "Ödemeler",
    "Ödemeler",
    meta,
    settlementColumns,
    data.settlements.filter((s) => s.type === "PAYMENT"),
    { emptyNote: "Ödeme kaydı bulunmuyor." },
  );

  addTableSheet(
    wb,
    "Aylık Trend",
    "Aylık Gelir / Gider (Tahakkuk Bazlı, Son 12 Ay)",
    meta,
    [
      { header: "Ay", width: 14, type: "text", get: (r: ProjectFinanceSummary["monthlyTrend"][number]) => r.label },
      { header: "Gelir", width: 18, type: "number", get: (r) => r.income },
      { header: "Gider", width: 18, type: "number", get: (r) => r.expense },
    ],
    data.monthlyTrend,
  );

  addTableSheet(
    wb,
    "Kategori Dağılımı",
    "Gider Kategorisi Dağılımı (Tüm Zamanlar)",
    meta,
    [
      { header: "Kategori", width: 28, type: "text", get: (r: ProjectFinanceSummary["categoryDistribution"][number]) => r.name },
      { header: "Tutar", width: 18, type: "money", get: (r) => r.amount },
    ],
    data.categoryDistribution,
    { emptyNote: "Gider kaydı bulunmuyor." },
  );

  return finalize(wb);
}

// ---------------------------------------------------------------------------
// Cash flow
// ---------------------------------------------------------------------------

const BUCKET_LABELS: { key: keyof MaturityBuckets; label: string }[] = [
  { key: "overdue", label: "Vadesi Geçmiş" },
  { key: "dueToday", label: "Bugün Vadesi Gelen" },
  { key: "next7Days", label: "Gelecek 7 Gün" },
  { key: "next30Days", label: "Gelecek 30 Gün" },
  { key: "days31to60", label: "31–60 Gün" },
  { key: "days61to90", label: "61–90 Gün" },
  { key: "over90Days", label: "90 Gün Üzeri" },
  { key: "noDueDate", label: "Vade Tarihi Girilmemiş" },
];

export async function buildCashFlowWorkbook(data: CashFlowReport, meta: ExportMeta): Promise<Buffer> {
  const wb = newWorkbook();
  const isOrg = data.scope === "ORGANIZATION";

  const summaryRows: SummaryRow[] = [
    { label: "Gerçekleşen Tahsilat", value: data.summary.realizedCollections, type: "money" },
    { label: "Gerçekleşen Ödeme", value: data.summary.realizedPayments, type: "money" },
    { label: "Gerçekleşen Net Nakit Akışı", value: data.summary.realizedNet, type: "money" },
    { label: "Planlanan Tahsilatlar", value: data.summary.scheduledCollections, type: "money" },
    { label: "Planlanan Ödemeler", value: data.summary.scheduledPayments, type: "money" },
    { label: "Beklenen Net Nakit (Tahmini)", value: data.summary.scheduledNet, type: "money" },
  ];
  if (isOrg) {
    summaryRows.unshift({ label: "Açılış Bakiyesi", value: data.openingBalance, type: "money" });
    summaryRows.push({ label: "Tahmini Kapanış Bakiyesi (Garanti Değildir)", value: data.projectedClosingBalance, type: "money" });
  }
  addSummarySheet(wb, "Özet", "YapiFin — Nakit Akışı Raporu Özeti", meta, summaryRows);

  const maturitySheet = wb.addWorksheet("Vade Analizi");
  const headerRow = writeHeaderBlock(maturitySheet, "Vade Tarihi Dağılımı (Güncel Duruma Göre)", meta);
  maturitySheet.getCell(headerRow, 1).value = "Vade Aralığı";
  maturitySheet.getCell(headerRow, 2).value = "Alacaklar";
  maturitySheet.getCell(headerRow, 3).value = "Borçlar";
  maturitySheet.getRow(headerRow).font = HEADER_FONT;
  maturitySheet.getRow(headerRow).eachCell((c) => (c.fill = HEADER_FILL));
  maturitySheet.getColumn(1).width = 26;
  maturitySheet.getColumn(2).width = 18;
  maturitySheet.getColumn(3).width = 18;
  BUCKET_LABELS.forEach((b, i) => {
    const r = headerRow + 1 + i;
    maturitySheet.getCell(r, 1).value = b.label;
    writeCell(maturitySheet, r, 2, "money", data.receivableBuckets[b.key]);
    writeCell(maturitySheet, r, 3, "money", data.payableBuckets[b.key]);
  });
  maturitySheet.views = [{ state: "frozen", ySplit: headerRow }];

  const maturityListColumns = (label: string): ColumnDef<MaturityListRow>[] => [
    { header: "Açıklama", width: 26, type: "text", get: (r) => r.description },
    { header: label, width: 22, type: "text", get: (r) => r.counterpartName ?? "—" },
    { header: "Proje", width: 20, type: "text", get: (r) => r.projectName ?? "—" },
    { header: "Belge No", width: 16, type: "text", get: (r) => r.documentNumber ?? "—" },
    { header: "Tutar", width: 16, type: "money", get: (r) => r.originalAmount },
    { header: "Tahsil/Ödenen", width: 16, type: "money", get: (r) => r.collectedOrPaidAmount },
    { header: "Kalan", width: 16, type: "money", get: (r) => r.remainingAmount },
    { header: "Vade Tarihi", width: 14, type: "date", get: (r) => r.dueDate },
    { header: "Vadesi Geçti mi?", width: 14, type: "text", get: (r) => (r.isOverdue ? "Evet" : "Hayır") },
  ];
  const truncNote = (section: CashFlowReport["receivables"]) =>
    section.truncated ? `İlk ${section.rows.length} kayıt gösterilmektedir (toplam açık kayıt: ${section.totalOpenCount}).` : undefined;

  addTableSheet(wb, "Alacaklar", "Alacak Vade Listesi", meta, maturityListColumns("Müşteri"), data.receivables.rows, {
    truncationNote: truncNote(data.receivables),
    emptyNote: "Açık alacak bulunmuyor.",
  });
  addTableSheet(wb, "Borçlar", "Borç Vade Listesi", meta, maturityListColumns("Tedarikçi/Taşeron"), data.payables.rows, {
    truncationNote: truncNote(data.payables),
    emptyNote: "Açık borç bulunmuyor.",
  });

  addTableSheet(
    wb,
    "Aylık Projeksiyon",
    "Aylık Planlanan Nakit Akışı Projeksiyonu (Tahmini)",
    meta,
    [
      { header: "Ay", width: 14, type: "text", get: (r: CashFlowReport["monthlyProjection"][number]) => r.label },
      { header: "Planlanan Giriş", width: 18, type: "number", get: (r) => r.scheduledIn },
      { header: "Planlanan Çıkış", width: 18, type: "number", get: (r) => r.scheduledOut },
      { header: "Net", width: 18, type: "number", get: (r) => r.net },
      ...(isOrg
        ? [{ header: "Tahmini Kümülatif Bakiye", width: 22, type: "number" as const, get: (r: CashFlowReport["monthlyProjection"][number]) => r.runningProjectedBalance }]
        : []),
    ],
    data.monthlyProjection,
  );

  addTableSheet(
    wb,
    "Proje Karşılaştırması",
    "Proje Bazlı Nakit Akışı Karşılaştırması",
    meta,
    [
      { header: "Proje", width: 26, type: "text", get: (r: CashFlowReport["projectComparison"][number]) => `${r.code} — ${r.name}` },
      { header: "Planlanan Giriş", width: 18, type: "money", get: (r) => r.scheduledInflow },
      { header: "Planlanan Çıkış", width: 18, type: "money", get: (r) => r.scheduledOutflow },
      { header: "Net", width: 18, type: "money", get: (r) => r.projectedNet },
      { header: "Vadesi Geçen Alacak", width: 18, type: "money", get: (r) => r.overdueReceivable },
      { header: "Vadesi Geçen Borç", width: 18, type: "money", get: (r) => r.overduePayable },
    ],
    data.projectComparison,
    { truncationNote: data.projectComparisonTruncated ? "En riskli/hareketli ilk 50 proje gösterilmektedir." : undefined },
  );

  const noDueDateColumns: ColumnDef<MaturityListRow>[] = [
    { header: "Açıklama", width: 26, type: "text", get: (r) => r.description },
    { header: "Karşı Taraf", width: 22, type: "text", get: (r) => r.counterpartName ?? "—" },
    { header: "Proje", width: 20, type: "text", get: (r) => r.projectName ?? "—" },
    { header: "Tutar", width: 16, type: "money", get: (r) => r.originalAmount },
    { header: "Kalan", width: 16, type: "money", get: (r) => r.remainingAmount },
  ];
  const combinedNoDueDate = [
    ...data.receivablesNoDueDate.rows.map((r) => ({ ...r, _tur: "Alacak" })),
    ...data.payablesNoDueDate.rows.map((r) => ({ ...r, _tur: "Borç" })),
  ];
  addTableSheet(
    wb,
    "Vadesiz Kayıtlar",
    "Vade Tarihi Girilmemiş Kayıtlar",
    meta,
    [{ header: "Tür", width: 10, type: "text", get: (r: (typeof combinedNoDueDate)[number]) => r._tur }, ...noDueDateColumns],
    combinedNoDueDate,
    { emptyNote: "Vade tarihi girilmemiş kayıt yok." },
  );

  return finalize(wb);
}

// ---------------------------------------------------------------------------
// Budget
// ---------------------------------------------------------------------------

export async function buildBudgetWorkbook(data: BudgetReport, meta: ExportMeta): Promise<Buffer> {
  const wb = newWorkbook();
  const { metrics } = data;

  addSummarySheet(wb, "Özet", "YapiFin — Bütçe ve Gider Kategori Analizi Özeti", meta, [
    { label: "Toplam Proje Bütçesi", value: metrics.totalProjectBudget, type: "money" },
    { label: "Gerçekleşen Gider", value: metrics.totalRealizedExpenses, type: "money" },
    { label: "Ödenen Gider", value: metrics.totalPaidExpenses, type: "money" },
    { label: "Kalan Bütçe", value: metrics.totalRemainingBudget, type: "money" },
    { label: "Bütçe Kullanım Oranı", value: metrics.budgetUsagePercentage ? `%${metrics.budgetUsagePercentage}` : "Bütçe girilmemiş", type: "text" },
    { label: "Bütçe Aşan Proje (Aktif)", value: metrics.projectsOverBudgetCount, type: "number" },
    { label: "Bütçesi Kritik Proje (Aktif)", value: metrics.projectsAtRiskCount, type: "number" },
    { label: "Bütçesiz Aktif Proje", value: metrics.projectsWithoutBudgetCount, type: "number" },
    {
      label: "Ortalama Bütçe Kullanımı (Bütçeli Aktif Projeler)",
      value: metrics.averageBudgetUtilization ? `%${metrics.averageBudgetUtilization}` : "—",
      type: "text",
    },
  ]);

  const STATUS_LABELS: Record<string, string> = { NORMAL: "Normal", CRITICAL: "Kritik", OVER_BUDGET: "Bütçe Aşıldı", NO_BUDGET: "Bütçe Girilmemiş" };
  addTableSheet(
    wb,
    "Proje Bütçeleri",
    "Proje Bütçe Karşılaştırması",
    meta,
    [
      { header: "Proje", width: 26, type: "text", get: (r: BudgetReport["projectComparison"][number]) => `${r.code} — ${r.name}` },
      { header: "Bütçe", width: 18, type: "money", get: (r) => r.estimatedBudget },
      { header: "Gerçekleşen Gider", width: 18, type: "money", get: (r) => r.realizedExpenses },
      { header: "Ödenen", width: 18, type: "money", get: (r) => r.paidExpenses },
      { header: "Kalan Bütçe", width: 18, type: "money", get: (r) => r.remainingBudget },
      { header: "Kullanım", width: 14, type: "text", get: (r) => (r.usagePercentage ? `%${r.usagePercentage}` : "—") },
      { header: "Durum", width: 16, type: "text", get: (r) => STATUS_LABELS[r.status] ?? r.status },
    ],
    data.projectComparison,
  );

  addTableSheet(
    wb,
    "Kategori Analizi",
    "Gider Kategori Analizi",
    meta,
    [
      { header: "Kategori", width: 26, type: "text", get: (r: BudgetReport["categoryAnalysis"][number]) => r.name },
      { header: "Kaydedilen Gider", width: 18, type: "money", get: (r) => r.recordedExpense },
      { header: "Ödenen", width: 18, type: "money", get: (r) => r.paidExpense },
      { header: "Toplam İçindeki Payı", width: 16, type: "text", get: (r) => (r.shareOfTotal ? `%${r.shareOfTotal}` : "—") },
      { header: "Proje Sayısı", width: 14, type: "number", get: (r) => r.projectCount },
      { header: "İşlem Sayısı", width: 14, type: "number", get: (r) => r.transactionCount },
    ],
    data.categoryAnalysis,
  );

  const trendSheet = wb.addWorksheet("Aylık Trend");
  let trendRow = writeHeaderBlock(trendSheet, "Aylık Kategori Trendi (Son 12 Ay)", meta);
  data.categoryMonthlyTrend.forEach((series) => {
    trendSheet.getCell(trendRow, 1).value = sanitizeExcelText(series.name);
    trendSheet.getCell(trendRow, 1).font = { bold: true };
    trendRow += 1;
    const headerR = trendRow;
    trendSheet.getCell(headerR, 1).value = "Ay";
    trendSheet.getCell(headerR, 2).value = "Tutar";
    trendSheet.getRow(headerR).font = HEADER_FONT;
    trendSheet.getRow(headerR).eachCell((c) => (c.fill = HEADER_FILL));
    trendRow += 1;
    series.points.forEach((p) => {
      trendSheet.getCell(trendRow, 1).value = p.label;
      writeCell(trendSheet, trendRow, 2, "number", p.amount);
      trendRow += 1;
    });
    trendRow += 1;
  });
  trendSheet.getColumn(1).width = 22;
  trendSheet.getColumn(2).width = 18;

  addTableSheet(
    wb,
    "Proje Kategori Analizi",
    "Proje × Kategori Dağılımı",
    meta,
    [
      { header: "Proje", width: 22, type: "text", get: (r: BudgetReport["projectCategoryMatrix"][number]) => r.projectName },
      { header: "Kategori", width: 22, type: "text", get: (r) => r.categoryName },
      { header: "Gerçekleşen", width: 18, type: "money", get: (r) => r.amount },
      { header: "Planlanan (varsa)", width: 18, type: "money", get: (r) => r.plannedAmount },
    ],
    data.projectCategoryMatrix,
    { truncationNote: data.projectCategoryMatrixTruncated ? "En yüksek harcamalı ilk 200 kombinasyon gösterilmektedir." : undefined },
  );

  addTableSheet(
    wb,
    "Bütçeyi Aşanlar",
    "Bütçeyi Aşan Projeler (Aktif)",
    meta,
    [
      { header: "Proje", width: 26, type: "text", get: (r: BudgetReport["overBudgetProjects"][number]) => `${r.code} — ${r.name}` },
      { header: "Bütçe", width: 16, type: "money", get: (r) => r.estimatedBudget },
      { header: "Gerçekleşen", width: 16, type: "money", get: (r) => r.realizedExpenses },
      { header: "Aşım Tutarı", width: 16, type: "money", get: (r) => r.overrunAmount },
      { header: "Aşım Yüzdesi", width: 14, type: "percent", get: (r) => r.overrunPercentage },
      { header: "En Çok Harcanan Kategoriler", width: 36, type: "text", get: (r) => r.topCategories.map((c) => c.name).join(", ") || "—" },
    ],
    data.overBudgetProjects,
    { emptyNote: "Bütçeyi aşan proje bulunmuyor." },
  );

  addTableSheet(
    wb,
    "Bütçesiz Projeler",
    "Bütçesi Girilmemiş Projeler (Aktif)",
    meta,
    [
      { header: "Proje", width: 26, type: "text", get: (r: BudgetReport["projectsWithoutBudget"][number]) => `${r.code} — ${r.name}` },
      { header: "Durum", width: 16, type: "text", get: (r) => r.status },
    ],
    data.projectsWithoutBudget,
    {
      truncationNote: data.projectsWithoutBudgetTruncated ? "İlk 100 proje gösterilmektedir." : undefined,
      emptyNote: "Bütçesiz aktif proje bulunmuyor.",
    },
  );

  return finalize(wb);
}
