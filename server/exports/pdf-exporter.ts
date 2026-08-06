import fs from "node:fs";
import PdfPrinter from "pdfmake/js/Printer";
import URLResolver from "pdfmake/js/URLResolver";
import { getRobotoFontPaths } from "@/server/exports/font";
import { formatMoney, formatDate, formatDateTime } from "@/lib/utils";
import { transactionStatusLabel } from "@/components/app/transaction-status";
import type { ExportMeta } from "@/server/services/report-export-service";
import type { PdfDocDefinition, PdfContent, PdfTableNode } from "@/server/exports/pdf-doc-types";
import type { DashboardData, OrganizationDashboardData, ProjectManagerDashboardData } from "@/server/services/dashboard-service";
import type { ProjectFinanceSummary } from "@/server/services/project-finance-service";
import type { CashFlowReport, MaturityBuckets } from "@/server/services/cash-flow-report-service";
import type { BudgetReport } from "@/server/services/budget-report-service";
import { FORECAST_UNAVAILABLE_LABELS, type ProjectBudgetVarianceReport } from "@/server/services/project-budget-variance-service";

/**
 * YF-405 — pdfmake ile `.pdf` üretimi. Excel'in aksine PDF hücreleri her
 * zaman metindir; bu nedenle Decimal→double hassasiyet sorunu burada söz
 * konusu değildir — tutarlar doğrudan `formatMoney` (mevcut, tr-TR
 * `Intl.NumberFormat`) ile biçimlendirilir. Grafikler sunucu tarafında
 * Recharts/Chromium ile üretilmez; bunun yerine aynı veriler kompakt
 * tablolar olarak sunulur (bkz. görev talimatları "Chart handling").
 */

let cachedPrinter: InstanceType<typeof PdfPrinter> | null = null;

function getPrinter(): InstanceType<typeof PdfPrinter> {
  if (cachedPrinter) return cachedPrinter;
  const { normal, bold } = getRobotoFontPaths();
  cachedPrinter = new PdfPrinter(
    { Roboto: { normal, bold, italics: normal, bolditalics: bold } },
    null,
    new URLResolver(fs),
    undefined,
  );
  return cachedPrinter;
}

async function renderPdf(docDefinition: PdfDocDefinition): Promise<Buffer> {
  const printer = getPrinter();
  const doc = await printer.createPdfKitDocument(docDefinition);
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    doc.on("data", (chunk: Buffer) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
    doc.end();
  });
}

// ---------------------------------------------------------------------------
// Biçimlendirme yardımcıları (PDF metin hücreleri için)
// ---------------------------------------------------------------------------

const money = (v: string | null | undefined) => (v == null ? "—" : formatMoney(v));
const pct = (v: string | null | undefined) => (v == null ? "—" : `%${v.replace(".", ",")}`);
const dateStr = (d: Date | null | undefined) => (d == null ? "—" : formatDate(d));
/** UI ile aynı sözlü işaret kuralı (bkz. components/app/project-budget-variance-section.tsx) — sapma yalnızca renge bırakılmaz. */
const varianceDirectionLabel = (amount: string) => {
  const n = Number(amount);
  if (n > 0) return "Aşım";
  if (n < 0) return "Tasarruf";
  return "Dengede";
};

// ---------------------------------------------------------------------------
// Ortak belge iskeleti
// ---------------------------------------------------------------------------

function buildDocDefinition(title: string, meta: ExportMeta, sections: PdfContent[]): PdfDocDefinition {
  const headerBlock: PdfContent[] = [
    { text: title, style: "title" },
    { text: meta.organizationName, style: "meta" },
    { text: `Oluşturulma: ${formatDateTime(meta.generatedAt)}`, style: "meta" },
    { text: `Dönem: ${meta.periodLabel}`, style: "meta" },
  ];
  if (meta.scopeNote) headerBlock.push({ text: meta.scopeNote, style: "scopeNote" });

  return {
    pageSize: "A4",
    pageMargins: [32, 36, 32, 40],
    defaultStyle: { font: "Roboto", fontSize: 9 },
    styles: {
      title: { fontSize: 16, bold: true, margin: [0, 0, 0, 4] },
      meta: { fontSize: 8.5, color: "#64748B", margin: [0, 0, 0, 1] },
      scopeNote: { fontSize: 8.5, color: "#B45309", margin: [0, 2, 0, 0] },
      sectionTitle: { fontSize: 11, bold: true, margin: [0, 14, 0, 4] },
      note: { fontSize: 7.5, italics: true, color: "#B45309", margin: [0, 2, 0, 4] },
      tableHeader: { bold: true, fontSize: 8, color: "#FFFFFF" },
    },
    content: [...headerBlock, ...sections],
    footer: (currentPage, pageCount) => ({
      text: `Sayfa ${currentPage}/${pageCount} · Oluşturulma: ${formatDateTime(meta.generatedAt)}`,
      alignment: "center",
      fontSize: 7.5,
      color: "#94A3B8",
      margin: [0, 8, 0, 0],
    }),
  };
}

function sectionTitle(text: string): PdfContent {
  return { text, style: "sectionTitle" };
}

function note(text: string): PdfContent {
  return { text, style: "note" };
}

function headerCell(text: string): { text: string; style: string } {
  return { text, style: "tableHeader" };
}

function dataTable(headers: string[], rows: string[][], widths?: (string | number)[]): PdfTableNode {
  return {
    table: {
      headerRows: 1,
      widths: widths ?? headers.map(() => "*"),
      body: [headers.map(headerCell), ...rows],
      dontBreakRows: true,
    },
    layout: {
      fillColor: (rowIndex: number) => (rowIndex === 0 ? "#0F3D3E" : rowIndex % 2 === 0 ? "#F8FAFC" : null),
      hLineWidth: () => 0.5,
      vLineWidth: () => 0,
      hLineColor: () => "#E2E8F0",
    },
    margin: [0, 0, 0, 8],
  };
}

function summaryTable(rows: [string, string][]): PdfTableNode {
  return dataTable(
    ["Metrik", "Değer"],
    rows,
    ["*", "auto"],
  );
}

function emptyOrNote(rows: unknown[], emptyText: string): PdfContent[] {
  return rows.length === 0 ? [note(emptyText)] : [];
}

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------

export async function buildDashboardPdf(data: DashboardData, meta: ExportMeta): Promise<Buffer> {
  const isOrg = data.scope === "ORGANIZATION";
  const summaryRows: [string, string][] = [
    ["Toplam Tahsilat", money(data.kpis.collectedIncome)],
    ["Toplam Ödeme", money(data.kpis.paidExpense)],
    ["Net Nakit Akışı", money(data.kpis.netCashFlow)],
    ["Açık Alacak", money(data.kpis.openReceivable)],
    ["Vadesi Geçen Alacak", money(data.kpis.overdueReceivable)],
    ["Açık Borç", money(data.kpis.openPayable)],
    ["Vadesi Geçen Borç", money(data.kpis.overduePayable)],
    ["Aktif Proje", String(data.kpis.activeProjectCount)],
    ["Toplam/Atanmış Proje", String(data.kpis.totalProjectCount)],
    ["Bütçesi Kritik Proje", String(data.kpis.budgetCriticalProjectCount)],
  ];
  if (isOrg) {
    const org = data as OrganizationDashboardData;
    summaryRows.splice(4, 0, ["Kasa ve Banka Bakiyesi", money(org.kpis.cashAndBankBalance)]);
    summaryRows.push(["Aktif Müşteri", String(org.kpis.activeCustomerCount)], ["Aktif Tedarikçi/Taşeron", String(org.kpis.activeSupplierCount)]);
  }

  const monthlyRows = data.monthlySeries.map((m) => [m.label, String(m.collected), String(m.paid), String(m.net)]);
  const categoryRows = data.expenseCategoryDistribution.map((c) => [c.name, money(c.amount)]);
  const upcomingCollectionRows = data.upcomingCollections.map((u) => [u.description, u.counterpartName ?? "—", dateStr(u.dueDate), money(u.remainingAmount)]);
  const upcomingPaymentRows = data.upcomingPayments.map((u) => [u.description, u.counterpartName ?? "—", dateStr(u.dueDate), money(u.remainingAmount)]);

  const recentSection: PdfContent[] = isOrg
    ? [
        sectionTitle("Son Finansal Hareketler"),
        ...emptyOrNote((data as OrganizationDashboardData).recentMovements, "Hareket bulunmuyor."),
        ...((data as OrganizationDashboardData).recentMovements.length
          ? [
              dataTable(
                ["Tarih", "Hesap", "Açıklama", "Yön", "Tutar"],
                (data as OrganizationDashboardData).recentMovements
                  .slice(0, 15)
                  .map((m) => [formatDateTime(m.occurredAt), m.accountName, m.description, m.direction === "CREDIT" ? "Giriş" : "Çıkış", money(m.amount)]),
              ),
            ]
          : []),
      ]
    : [
        sectionTitle("Son Proje Hareketleri"),
        ...emptyOrNote((data as ProjectManagerDashboardData).recentProjectActivity, "Hareket bulunmuyor."),
        ...((data as ProjectManagerDashboardData).recentProjectActivity.length
          ? [
              dataTable(
                ["Tarih", "Proje", "Açıklama", "Tür", "Tutar"],
                (data as ProjectManagerDashboardData).recentProjectActivity
                  .slice(0, 15)
                  .map((a) => [dateStr(a.issueDate), a.projectName, a.description, a.type === "INCOME" ? "Gelir" : "Gider", money(a.totalAmount)]),
              ),
            ]
          : []),
      ];

  const docDefinition = buildDocDefinition("Finans Panel Özeti", meta, [
    sectionTitle("Özet"),
    summaryTable(summaryRows),
    sectionTitle("Aylık Tahsilat / Ödeme"),
    dataTable(["Ay", "Tahsilat", "Ödeme", "Net"], monthlyRows),
    sectionTitle("Gider Kategorisi Dağılımı"),
    ...emptyOrNote(categoryRows, "Seçilen dönemde gider kaydı bulunmuyor."),
    ...(categoryRows.length ? [dataTable(["Kategori", "Tutar"], categoryRows)] : []),
    sectionTitle("Yaklaşan Tahsilatlar (30 gün)"),
    ...emptyOrNote(upcomingCollectionRows, "Yaklaşan tahsilat bulunmuyor."),
    ...(upcomingCollectionRows.length ? [dataTable(["Açıklama", "Müşteri", "Vade", "Kalan"], upcomingCollectionRows)] : []),
    sectionTitle("Yaklaşan Ödemeler (30 gün)"),
    ...emptyOrNote(upcomingPaymentRows, "Yaklaşan ödeme bulunmuyor."),
    ...(upcomingPaymentRows.length ? [dataTable(["Açıklama", "Tedarikçi/Taşeron", "Vade", "Kalan"], upcomingPaymentRows)] : []),
    ...recentSection,
  ]);

  return renderPdf(docDefinition);
}

// ---------------------------------------------------------------------------
// Project finance
// ---------------------------------------------------------------------------

/**
 * YF-512 — YF-407'nin ürettiği bütçe sapması ve tamamlanma tahmini
 * verilerini proje finans PDF'ine ekler. Hiçbir tutar burada yeniden
 * hesaplanmaz; yalnızca `ProjectBudgetVarianceReport` DTO'su biçimlendirilir.
 * Tahmin üretilemeyen projelerde sahte/`0` bir tahmin gösterilmez —
 * yalnızca nedeni ekrandakiyle birebir aynı Türkçe metinle belirtilir.
 */
function buildVarianceSection(variance: ProjectBudgetVarianceReport): PdfContent[] {
  const summaryRows: [string, string][] = [
    ["Toplam Planlanan Bütçe", money(variance.totalPlannedBudget)],
    ["Toplam Gerçekleşen Gider", money(variance.totalRealizedExpense)],
    ["Kalan Bütçe", money(variance.totalRemainingBudget)],
    ["Bütçe Kullanım Oranı", pct(variance.totalUsagePercentage)],
    ["Genel Durum", BUDGET_STATUS_LABELS[variance.status] ?? variance.status],
    ["Bütçe Sapması (Gerçekleşen − Planlanan)", `${money(variance.varianceAmount)} — ${varianceDirectionLabel(variance.varianceAmount)}`],
    ["Sapma Yüzdesi", pct(variance.variancePercentage)],
  ];

  const categoryRows = variance.items.map((item) => [
    item.categoryName,
    money(item.plannedAmount),
    money(item.realizedExpense),
    money(item.remainingAmount),
    item.usagePercentage ? pct(item.usagePercentage) : "—",
    money(item.varianceAmount),
    varianceDirectionLabel(item.varianceAmount),
    BUDGET_STATUS_LABELS[item.status] ?? item.status,
  ]);

  const { forecast } = variance;
  const forecastRows: [string, string][] = forecast.forecastAvailable
    ? [
        ["Geçen Süre", `${forecast.elapsedDays} gün`],
        ["Günlük Ortalama Gider", money(forecast.dailyBurnRate)],
        ...(forecast.projectedTotalExpenseAvailable
          ? ([
              ["Tahmini Toplam Gider", money(forecast.projectedTotalExpense)],
              [
                "Tahmini Aşım / Tasarruf",
                `${money(forecast.projectedOverrunOrSavings)} — ${varianceDirectionLabel(forecast.projectedOverrunOrSavings ?? "0")}`,
              ],
            ] as [string, string][])
          : []),
        [
          "Bütçenin Yeteceği Süre",
          forecast.estimatedDaysRemainingOnBudget === 0 ? "Bütçe tükendi" : `${forecast.estimatedDaysRemainingOnBudget} gün`,
        ],
      ]
    : [];

  return [
    sectionTitle("Bütçe Sapması ve Tamamlanma Tahmini (YF-407)"),
    summaryTable(summaryRows),
    ...emptyOrNote(categoryRows, "Bu proje için bütçe kalemi girilmemiş; kategori bazlı sapma hesaplanamıyor."),
    ...(categoryRows.length
      ? [dataTable(["Kategori", "Planlanan", "Gerçekleşen", "Kalan", "Kullanım", "Sapma", "Yön", "Durum"], categoryRows)]
      : []),
    ...(forecast.forecastAvailable
      ? [
          summaryTable(forecastRows),
          ...(forecast.projectedTotalExpenseAvailable
            ? []
            : [
                note(
                  "Projenin planlanan bitiş tarihi girilmediği için tahmini toplam gider hesaplanamıyor; yalnızca bütçenin kaç gün daha yeteceği yukarıda gösterilmiştir.",
                ),
              ]),
          note(
            "Bu tahmin muhasebesel bir kesin sonuç değildir; mevcut harcama hızının değişmeden devam edeceği varsayımına dayanan operasyonel bir projeksiyondur.",
          ),
        ]
      : [note(forecast.unavailableReason ? FORECAST_UNAVAILABLE_LABELS[forecast.unavailableReason] : "Tahmin üretilemiyor.")]),
  ];
}

export async function buildProjectFinancePdf(data: ProjectFinanceSummary, meta: ExportMeta, variance: ProjectBudgetVarianceReport): Promise<Buffer> {
  const summaryRows: [string, string][] = [
    ["Müşteri", data.customerName ?? "—"],
    ["Sözleşme Bedeli", money(data.contractAmount)],
    ["Tahmini Bütçe", money(data.estimatedBudget)],
    ["Kaydedilen Gelir", money(data.totalRecordedIncome)],
    ["Tahsil Edilen", money(data.totalCollected)],
    ["Kalan Alacak", money(data.remainingReceivable)],
    ["Kaydedilen Gider", money(data.totalRecordedExpense)],
    ["Ödenen", money(data.totalPaid)],
    ["Kalan Borç", money(data.remainingPayable)],
    ["Nakit Pozisyonu", money(data.cashPosition)],
    ["Tahakkuk Bazlı Sonuç", money(data.accrualResult)],
    ["Tahmini Brüt Kâr", data.estimatedProfitAvailable ? money(data.estimatedGrossProfit) : "Desteklenmiyor"],
    ["Tahmini Kâr Marjı", data.estimatedProfitMargin ? pct(data.estimatedProfitMargin) : "Desteklenmiyor"],
    ["Bütçe Kullanımı", data.budgetAvailable ? pct(data.budgetUsedRatio) : "Bütçe girilmemiş"],
    ["Bütçe Aşıldı mı?", data.isBudgetOverrun ? "Evet" : "Hayır"],
  ];

  // Not: ekrandaki TransactionsTable ile aynı ilke — iptal edilmiş kayıtlar
  // gizlenmez, "Durum" sütununda işaretlenir; yalnızca KPI toplamları iptal
  // hariç hesaplanır (bkz. server/services/project-finance-service.ts).
  const txRows = (rows: ProjectFinanceSummary["incomeList"], type: "INCOME" | "EXPENSE") =>
    rows
      .slice(0, 40)
      .map((r) => [r.description, r.categoryName, r.counterpartName ?? "—", money(r.totalAmount), money(r.remainingAmount), dateStr(r.dueDate), transactionStatusLabel(r.status, type)]);

  const settlementRows = (rows: ProjectFinanceSummary["settlements"], type: "COLLECTION" | "PAYMENT") =>
    rows
      .filter((s) => s.type === type)
      .slice(0, 30)
      .map((s) => [dateStr(s.settlementDate), s.accountName, s.relatedDescription, money(s.amount)]);

  const docDefinition = buildDocDefinition(`Proje Finans Özeti — ${data.projectCode}`, meta, [
    sectionTitle("Proje Özeti"),
    summaryTable(summaryRows),
    note("Gelir/Gider detay tabloları en fazla ilk 40 kaydı gösterir; yukarıdaki KPI toplamları her zaman tüm kayıtları kapsar (Excel dışa aktarımı 100 kayda kadar tam liste içerir)."),
    ...buildVarianceSection(variance),
    sectionTitle("Gelirler"),
    ...emptyOrNote(data.incomeList, "Gelir kaydı bulunmuyor."),
    ...(data.incomeList.length ? [dataTable(["Açıklama", "Kategori", "Karşı Taraf", "Tutar", "Kalan", "Vade", "Durum"], txRows(data.incomeList, "INCOME"))] : []),
    sectionTitle("Giderler"),
    ...emptyOrNote(data.expenseList, "Gider kaydı bulunmuyor."),
    ...(data.expenseList.length ? [dataTable(["Açıklama", "Kategori", "Karşı Taraf", "Tutar", "Kalan", "Vade", "Durum"], txRows(data.expenseList, "EXPENSE"))] : []),
    sectionTitle("Tahsilatlar"),
    ...(settlementRows(data.settlements, "COLLECTION").length
      ? [dataTable(["Tarih", "Hesap", "İlgili Kayıt", "Tutar"], settlementRows(data.settlements, "COLLECTION"))]
      : [note("Tahsilat kaydı bulunmuyor.")]),
    sectionTitle("Ödemeler"),
    ...(settlementRows(data.settlements, "PAYMENT").length
      ? [dataTable(["Tarih", "Hesap", "İlgili Kayıt", "Tutar"], settlementRows(data.settlements, "PAYMENT"))]
      : [note("Ödeme kaydı bulunmuyor.")]),
    sectionTitle("Aylık Gelir / Gider (Tahakkuk Bazlı, Son 12 Ay)"),
    dataTable(
      ["Ay", "Gelir", "Gider"],
      data.monthlyTrend.map((m) => [m.label, String(m.income), String(m.expense)]),
    ),
    sectionTitle("Gider Kategorisi Dağılımı (Tüm Zamanlar)"),
    ...emptyOrNote(data.categoryDistribution, "Gider kaydı bulunmuyor."),
    ...(data.categoryDistribution.length ? [dataTable(["Kategori", "Tutar"], data.categoryDistribution.map((c) => [c.name, money(c.amount)]))] : []),
  ]);

  return renderPdf(docDefinition);
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

export async function buildCashFlowPdf(data: CashFlowReport, meta: ExportMeta): Promise<Buffer> {
  const isOrg = data.scope === "ORGANIZATION";
  const summaryRows: [string, string][] = [
    ["Gerçekleşen Tahsilat", money(data.summary.realizedCollections)],
    ["Gerçekleşen Ödeme", money(data.summary.realizedPayments)],
    ["Gerçekleşen Net Nakit Akışı", money(data.summary.realizedNet)],
    ["Planlanan Tahsilatlar", money(data.summary.scheduledCollections)],
    ["Planlanan Ödemeler", money(data.summary.scheduledPayments)],
    ["Beklenen Net Nakit (Tahmini)", money(data.summary.scheduledNet)],
  ];
  if (isOrg) {
    summaryRows.unshift(["Açılış Bakiyesi", money(data.openingBalance)]);
    summaryRows.push(["Tahmini Kapanış Bakiyesi", money(data.projectedClosingBalance)]);
  }

  const bucketRows = BUCKET_LABELS.map((b) => [b.label, money(data.receivableBuckets[b.key]), money(data.payableBuckets[b.key])]);

  const maturityRows = (rows: CashFlowReport["receivables"]["rows"]) =>
    rows.slice(0, 30).map((r) => [r.description, r.counterpartName ?? "—", dateStr(r.dueDate), money(r.remainingAmount)]);

  const truncNote = (section: CashFlowReport["receivables"]) =>
    section.truncated ? `Toplam ${section.totalOpenCount} açık kayıttan ilk ${Math.min(30, section.rows.length)} tanesi gösterilmektedir; PDF görünümü özetlidir, tam liste için Excel dışa aktarımını kullanın.` : undefined;

  const docDefinition = buildDocDefinition("Nakit Akışı Raporu", meta, [
    sectionTitle("Özet"),
    summaryTable(summaryRows),
    note("Planlanan tutarlar ve tahmini kapanış bakiyesi birer tahmindir — garanti nakit değildir."),
    sectionTitle("Vade Tarihi Dağılımı (Güncel Duruma Göre)"),
    dataTable(["Vade Aralığı", "Alacaklar", "Borçlar"], bucketRows),
    sectionTitle("Aylık Planlanan Nakit Akışı Projeksiyonu"),
    dataTable(
      isOrg ? ["Ay", "Planlanan Giriş", "Planlanan Çıkış", "Net", "Tahmini Bakiye"] : ["Ay", "Planlanan Giriş", "Planlanan Çıkış", "Net"],
      data.monthlyProjection.map((m) =>
        isOrg
          ? [m.label, String(m.scheduledIn), String(m.scheduledOut), String(m.net), m.runningProjectedBalance == null ? "—" : String(m.runningProjectedBalance)]
          : [m.label, String(m.scheduledIn), String(m.scheduledOut), String(m.net)],
      ),
    ),
    sectionTitle("Alacak Vade Listesi"),
    ...(truncNote(data.receivables) ? [note(truncNote(data.receivables)!)] : []),
    ...emptyOrNote(data.receivables.rows, "Açık alacak bulunmuyor."),
    ...(data.receivables.rows.length ? [dataTable(["Açıklama", "Müşteri", "Vade", "Kalan"], maturityRows(data.receivables.rows))] : []),
    sectionTitle("Borç Vade Listesi"),
    ...(truncNote(data.payables) ? [note(truncNote(data.payables)!)] : []),
    ...emptyOrNote(data.payables.rows, "Açık borç bulunmuyor."),
    ...(data.payables.rows.length ? [dataTable(["Açıklama", "Tedarikçi/Taşeron", "Vade", "Kalan"], maturityRows(data.payables.rows))] : []),
    sectionTitle("Proje Bazlı Nakit Akışı Karşılaştırması"),
    ...(data.projectComparisonTruncated ? [note("En riskli/hareketli ilk 50 proje gösterilmektedir.")] : []),
    ...emptyOrNote(data.projectComparison, "Karşılaştırma için proje verisi bulunmuyor."),
    ...(data.projectComparison.length
      ? [
          dataTable(
            ["Proje", "Planlanan Giriş", "Planlanan Çıkış", "Net", "Vadesi Geçen Alacak", "Vadesi Geçen Borç"],
            data.projectComparison
              .slice(0, 30)
              .map((r) => [`${r.code} — ${r.name}`, money(r.scheduledInflow), money(r.scheduledOutflow), money(r.projectedNet), money(r.overdueReceivable), money(r.overduePayable)]),
          ),
        ]
      : []),
  ]);

  return renderPdf(docDefinition);
}

// ---------------------------------------------------------------------------
// Budget
// ---------------------------------------------------------------------------

const BUDGET_STATUS_LABELS: Record<string, string> = { NORMAL: "Normal", CRITICAL: "Kritik", OVER_BUDGET: "Bütçe Aşıldı", NO_BUDGET: "Bütçe Girilmemiş" };

export async function buildBudgetPdf(data: BudgetReport, meta: ExportMeta): Promise<Buffer> {
  const { metrics } = data;
  const summaryRows: [string, string][] = [
    ["Toplam Proje Bütçesi", money(metrics.totalProjectBudget)],
    ["Gerçekleşen Gider", money(metrics.totalRealizedExpenses)],
    ["Ödenen Gider", money(metrics.totalPaidExpenses)],
    ["Kalan Bütçe", money(metrics.totalRemainingBudget)],
    ["Bütçe Kullanım Oranı", metrics.budgetUsagePercentage ? pct(metrics.budgetUsagePercentage) : "Bütçe girilmemiş"],
    ["Bütçe Aşan Proje (Aktif)", String(metrics.projectsOverBudgetCount)],
    ["Bütçesi Kritik Proje (Aktif)", String(metrics.projectsAtRiskCount)],
    ["Bütçesiz Aktif Proje", String(metrics.projectsWithoutBudgetCount)],
    ["Ortalama Bütçe Kullanımı", metrics.averageBudgetUtilization ? pct(metrics.averageBudgetUtilization) : "—"],
  ];

  const projectRows = data.projectComparison
    .slice(0, 40)
    .map((r) => [`${r.code} — ${r.name}`, money(r.estimatedBudget), money(r.realizedExpenses), money(r.remainingBudget), r.usagePercentage ? pct(r.usagePercentage) : "—", BUDGET_STATUS_LABELS[r.status] ?? r.status]);

  const categoryRows = data.categoryAnalysis
    .slice(0, 40)
    .map((c) => [c.name, money(c.recordedExpense), money(c.paidExpense), c.shareOfTotal ? pct(c.shareOfTotal) : "—", String(c.projectCount)]);

  const overBudgetRows = data.overBudgetProjects
    .slice(0, 30)
    .map((r) => [`${r.code} — ${r.name}`, money(r.estimatedBudget), money(r.realizedExpenses), money(r.overrunAmount), r.topCategories.map((c) => c.name).join(", ") || "—"]);

  const atRiskRows = data.atRiskProjects
    .slice(0, 30)
    .map((r) => [`${r.code} — ${r.name}`, money(r.estimatedBudget), money(r.realizedExpenses), r.usagePercentage ? pct(r.usagePercentage) : "—"]);

  const noBudgetRows = data.projectsWithoutBudget.slice(0, 40).map((r) => [`${r.code} — ${r.name}`, r.status]);

  const docDefinition = buildDocDefinition("Bütçe ve Gider Kategori Analizi", meta, [
    sectionTitle("Özet"),
    summaryTable(summaryRows),
    sectionTitle("Proje Bütçe Karşılaştırması"),
    ...emptyOrNote(projectRows, "Proje verisi bulunmuyor."),
    ...(projectRows.length ? [dataTable(["Proje", "Bütçe", "Gerçekleşen", "Kalan", "Kullanım", "Durum"], projectRows)] : []),
    sectionTitle("Bütçeyi Aşan Projeler (Aktif)"),
    ...emptyOrNote(overBudgetRows, "Bütçeyi aşan proje bulunmuyor."),
    ...(overBudgetRows.length ? [dataTable(["Proje", "Bütçe", "Gerçekleşen", "Aşım", "En Çok Harcanan Kategoriler"], overBudgetRows)] : []),
    sectionTitle("Bütçe Sınırına Yaklaşan Projeler (Aktif)"),
    ...emptyOrNote(atRiskRows, "Bütçesi kritik proje bulunmuyor."),
    ...(atRiskRows.length ? [dataTable(["Proje", "Bütçe", "Gerçekleşen", "Kullanım"], atRiskRows)] : []),
    ...(data.projectsWithoutBudget.length
      ? [sectionTitle("Bütçesi Girilmemiş Projeler (Aktif)"), dataTable(["Proje", "Durum"], noBudgetRows)]
      : []),
    sectionTitle("Gider Kategori Analizi"),
    ...emptyOrNote(categoryRows, "Kategori verisi bulunmuyor."),
    ...(categoryRows.length ? [dataTable(["Kategori", "Kaydedilen", "Ödenen", "Pay", "Proje Sayısı"], categoryRows)] : []),
  ]);

  return renderPdf(docDefinition);
}
