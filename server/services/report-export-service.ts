import { z } from "zod";
import { toIstanbul } from "@/lib/dates";
import type { SessionUser } from "@/lib/auth/session";
import { ServiceError, notFound } from "@/server/services/errors";
import { getDashboardData } from "@/server/services/dashboard-service";
import { getProjectFinanceSummary } from "@/server/services/project-finance-service";
import { getCashFlowReport } from "@/server/services/cash-flow-report-service";
import { getBudgetReport } from "@/server/services/budget-report-service";
import { getProjectForUser } from "@/server/services/project-service";
import { parseDashboardFilter, type DashboardPeriod } from "@/lib/validation/dashboard";
import { parseCashFlowFilter, type CashFlowRange, type CashFlowScenario } from "@/lib/validation/reports";
import { parseBudgetFilter } from "@/lib/validation/reports";
import { buildExportFilename, buildContentDisposition } from "@/server/exports/filename";
import {
  buildDashboardWorkbook,
  buildProjectFinanceWorkbook,
  buildCashFlowWorkbook,
  buildBudgetWorkbook,
} from "@/server/exports/excel-exporter";
import { buildDashboardPdf, buildProjectFinancePdf, buildCashFlowPdf, buildBudgetPdf } from "@/server/exports/pdf-exporter";

/**
 * YF-405 — Dışa aktarma katmanı orkestrasyonu. Bu dosya HİÇBİR finansal
 * hesaplama içermez; yalnızca (1) format/filtre doğrulaması, (2) mevcut
 * rapor servisinin (YF-401–404) çağrılması — tenant/rol yetkilendirmesi
 * tamamen bu servisler üzerinden yürür — ve (3) sonucun Excel/PDF
 * dışa aktarıcısına devredilmesinden ibarettir. `next/headers` hiçbir
 * yerde kullanılmaz — bu, `route.ts` katmanının ince bir sarmalayıcı
 * kalmasını ve bu dosyanın diğer tüm servisler gibi doğrudan test
 * edilebilmesini sağlar (bkz. docs/ARCHITECTURE.md §14).
 */

export type ExportFormat = "xlsx" | "pdf";
const exportFormatSchema = z.enum(["xlsx", "pdf"]);

export interface ExportFile {
  buffer: Buffer;
  filename: string;
  contentDisposition: string;
}

export interface ExportMeta {
  organizationName: string;
  generatedAt: Date;
  periodLabel: string;
  scopeNote?: string;
}

type RawParams = Record<string, string | string[] | undefined>;

function parseFormat(raw: string | string[] | undefined): ExportFormat {
  const value = Array.isArray(raw) ? raw[0] : raw;
  const result = exportFormatSchema.safeParse(value);
  if (!result.success) {
    throw new ServiceError("Geçersiz dışa aktarma biçimi. 'xlsx' veya 'pdf' bekleniyor.", "VALIDATION");
  }
  return result.data;
}

function isoDateIstanbul(now: Date): string {
  const ist = toIstanbul(now);
  const y = ist.getUTCFullYear();
  const m = String(ist.getUTCMonth() + 1).padStart(2, "0");
  const d = String(ist.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

const DASHBOARD_PERIOD_LABELS: Record<DashboardPeriod, string> = {
  CURRENT_MONTH: "Bu Ay",
  CURRENT_YEAR: "Bu Yıl",
  LAST_12_MONTHS: "Son 12 Ay",
};

const CASH_FLOW_RANGE_LABELS: Record<CashFlowRange, string> = {
  CURRENT_MONTH: "Bu Ay",
  NEXT_30_DAYS: "Önümüzdeki 30 Gün",
  NEXT_90_DAYS: "Önümüzdeki 90 Gün",
  CURRENT_YEAR: "Bu Yıl",
  CUSTOM: "Özel Aralık",
};

const CASH_FLOW_SCENARIO_LABELS: Record<CashFlowScenario, string> = {
  ON_DUE_DATE: "Vadesinde",
  COLLECTIONS_DELAYED_7D: "Tahsilatlar 7 Gün Gecikmeli",
  PAYMENTS_DELAYED_7D: "Ödemeler 7 Gün Gecikmeli",
};

function scopeNoteFor(scope: "ORGANIZATION" | "PROJECT_MANAGER"): string | undefined {
  return scope === "PROJECT_MANAGER" ? "Bu rapor yalnızca atandığınız projeleri kapsar." : undefined;
}

async function toFile(buffer: Buffer, reportSlug: string, format: ExportFormat, now: Date, entitySlug?: string): Promise<ExportFile> {
  const filename = buildExportFilename(reportSlug, format, isoDateIstanbul(now), entitySlug);
  return { buffer, filename, contentDisposition: buildContentDisposition(filename) };
}

export async function exportDashboard(actor: SessionUser, format: ExportFormat, rawParams: RawParams): Promise<ExportFile> {
  format = parseFormat(format);
  const now = new Date();
  const filter = parseDashboardFilter(rawParams);
  const data = await getDashboardData(actor, filter);

  const projectLabel = data.projectFilter ? ` · ${data.projectFilter.name}` : "";
  const meta: ExportMeta = {
    organizationName: actor.organizationName,
    generatedAt: now,
    periodLabel: `${DASHBOARD_PERIOD_LABELS[filter.period]}${projectLabel}`,
    scopeNote: scopeNoteFor(data.scope),
  };

  const buffer = format === "xlsx" ? await buildDashboardWorkbook(data, meta) : await buildDashboardPdf(data, meta);
  return toFile(buffer, "yapifin-finans-ozeti", format, now);
}

export async function exportProjectFinance(actor: SessionUser, projectId: string, format: ExportFormat): Promise<ExportFile> {
  format = parseFormat(format);
  if (!projectId) throw notFound("Proje bulunamadı");
  const now = new Date();
  // getProjectForUser (proje servisi) organizasyon + (varsa) atanmış proje
  // kapsamını doğrular; cross-tenant/atanmamış proje id'si burada NOT_FOUND
  // ile kapanır — bkz. server/services/project-service.ts.
  await getProjectForUser(actor, projectId);
  const data = await getProjectFinanceSummary(actor, projectId);

  const meta: ExportMeta = {
    organizationName: actor.organizationName,
    generatedAt: now,
    periodLabel: `${data.projectCode} · Tüm zamanlar`,
  };

  const buffer = format === "xlsx" ? await buildProjectFinanceWorkbook(data, meta) : await buildProjectFinancePdf(data, meta);
  return toFile(buffer, "yapifin-proje-finans", format, now, data.projectName);
}

export async function exportCashFlow(actor: SessionUser, format: ExportFormat, rawParams: RawParams): Promise<ExportFile> {
  format = parseFormat(format);
  const now = new Date();
  const parsed = parseCashFlowFilter(rawParams);
  if (!parsed.success) {
    throw new ServiceError(parsed.error, "VALIDATION");
  }
  const filter = parsed.data;
  const data = await getCashFlowReport(actor, filter);

  const projectLabel = data.projectFilter ? ` · ${data.projectFilter.name}` : "";
  const meta: ExportMeta = {
    organizationName: actor.organizationName,
    generatedAt: now,
    periodLabel: `${CASH_FLOW_RANGE_LABELS[filter.range]} · ${CASH_FLOW_SCENARIO_LABELS[filter.scenario]}${projectLabel}`,
    scopeNote: scopeNoteFor(data.scope),
  };

  const buffer = format === "xlsx" ? await buildCashFlowWorkbook(data, meta) : await buildCashFlowPdf(data, meta);
  return toFile(buffer, "yapifin-nakit-akisi", format, now);
}

export async function exportBudget(actor: SessionUser, format: ExportFormat, rawParams: RawParams): Promise<ExportFile> {
  format = parseFormat(format);
  const now = new Date();
  const filter = parseBudgetFilter(rawParams);
  const data = await getBudgetReport(actor, filter);

  const projectLabel = data.projectFilter ? ` · ${data.projectFilter.name}` : "";
  const meta: ExportMeta = {
    organizationName: actor.organizationName,
    generatedAt: now,
    periodLabel: `Bütçe ve gider kategori analizi${projectLabel}`,
    scopeNote: scopeNoteFor(data.scope),
  };

  const buffer = format === "xlsx" ? await buildBudgetWorkbook(data, meta) : await buildBudgetPdf(data, meta);
  return toFile(buffer, "yapifin-butce-analizi", format, now);
}

export function requireExportFormat(raw: string | string[] | undefined): ExportFormat {
  return parseFormat(raw);
}
