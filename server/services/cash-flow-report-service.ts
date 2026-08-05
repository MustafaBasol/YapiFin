import { Prisma } from "@prisma/client";
import type { TransactionStatus, TransactionType } from "@prisma/client";
import { db } from "@/lib/db";
import { canViewAllProjects } from "@/lib/permissions";
import { getOrganizationCashBalance, toDecimal, ZERO } from "@/server/services/ledger";
import {
  getDateRange,
  resolveProjectFilter,
  getSettlementTotalsForRange,
  bucketByMonth,
  type DateRange,
  type MonthLabel,
} from "@/server/services/dashboard-service";
import { startOfIstanbulDay, addIstanbulDays, toIstanbul, fromIstanbulComponents } from "@/lib/dates";
import type { SessionUser } from "@/lib/auth/session";
import type { CashFlowFilterInput, CashFlowScenario } from "@/lib/validation/reports";

/**
 * YF-403 — Vade ve nakit akışı raporu.
 *
 * Üç ayrı nakit akışı kavramı kesin olarak birbirinden ayrılır:
 * - **Gerçekleşen**: `Settlement.status = 'ACTIVE'` olan tahsilat/ödemelerin
 *   `settlementDate`'i seçilen dönem aralığındaysa toplanır (dashboard'daki
 *   `getSettlementTotalsForRange` ile aynı formül, buradan içe aktarılır).
 * - **Planlanan**: Açık/kısmi ödenmiş gelir/gider kayıtlarının vade tarihine
 *   göre kalan tutarı — bkz. `getMaturityBucketsGrouped`. Bu tutarlar asla
 *   "garanti nakit" olarak sunulmaz; UI'da her zaman tahmin ibaresiyle
 *   gösterilir.
 * - **Birleşik projeksiyon**: Güncel kasa/banka bakiyesi (açılış noktası) +
 *   bugünden itibaren seçilen dönem sonuna kadar vadesi gelen planlanan
 *   tahsilat/ödemeler = tahmini kapanış bakiyesi.
 *
 * Zaman dilimi: tüm gün/ay sınırları `Europe/Istanbul` sabit UTC+3 kabul
 * edilerek hesaplanır (bkz. lib/dates.ts, docs/ARCHITECTURE.md §8/§12).
 * Vade bucket sınırları (bugün, sonraki 7/30/60/90 gün) bu nedenle mevcut
 * `getOpenAndOverdueTotals`'ın kullandığı SQL `NOW()`'dan daha kesindir —
 * `NOW()` UTC anlık zamanı temsil eder ve Istanbul gece yarısı sınırında
 * yanlış sınıflandırma riski taşır; bu rapor bunun yerine önceden hesaplanmış
 * Istanbul gün sınırlarını parametre olarak bağlar.
 *
 * İptal/ters kayıt/parçalı ödeme kuralları dashboard-service.ts ile birebir
 * aynıdır: `FinancialTransaction.status = CANCELLED` tamamen hariç, kalan
 * tutar satır bazında `totalAmount - Σ(aktif settlement)` türetilir, ters
 * kayıt (REVERSAL) orijinal AccountMovement'ı silmez ama ilişkili Settlement
 * `CANCELLED` olduğundan Settlement bazlı toplamlarda otomatik dışlanır.
 * Transfer hareketleri (`AccountTransfer`/`AAccountMovement.TRANSFER_IN|OUT`)
 * bu raporun kaynağı olan `FinancialTransaction`/`Settlement` tablolarında
 * hiç yer almadığından gelir/gider olarak asla sızmaz.
 */

const MATURITY_LIST_LIMIT = 100;
const NO_DUE_DATE_LIST_LIMIT = 50;
const PROJECT_COMPARISON_LIMIT = 50;
const MONTHLY_PROJECTION_ROW_CAP = 5000;
const MONTHLY_PROJECTION_MAX_MONTHS = 14; // 366 günlük azami özel aralık en çok 13-14 takvim ayına yayılır.

const OPEN_STATUSES: TransactionStatus[] = ["OPEN", "PARTIALLY_PAID", "OVERDUE"];
const OPEN_STATUSES_NO_DUE_DATE: TransactionStatus[] = ["OPEN", "PARTIALLY_PAID"];

const DELAY_DAYS_BY_SCENARIO: Record<CashFlowScenario, { collectionDelayDays: number; paymentDelayDays: number }> = {
  ON_DUE_DATE: { collectionDelayDays: 0, paymentDelayDays: 0 },
  COLLECTIONS_DELAYED_7D: { collectionDelayDays: 7, paymentDelayDays: 0 },
  PAYMENTS_DELAYED_7D: { collectionDelayDays: 0, paymentDelayDays: 7 },
};

export interface MaturityBuckets {
  overdue: string;
  dueToday: string;
  next7Days: string;
  next30Days: string;
  days31to60: string;
  days61to90: string;
  over90Days: string;
  noDueDate: string;
}

export interface MaturityListRow {
  id: string;
  description: string;
  counterpartName: string | null;
  projectName: string | null;
  documentNumber: string | null;
  originalAmount: string;
  collectedOrPaidAmount: string;
  remainingAmount: string;
  dueDate: Date | null;
  daysOverdueOrRemaining: number | null; // negatif = vadesi geçen gün sayısı, pozitif = kalan gün sayısı
  isOverdue: boolean;
  currency: string;
}

export interface MaturityListSection {
  rows: MaturityListRow[];
  totalOpenCount: number;
  truncated: boolean;
}

export interface CashFlowMonthlyPoint {
  key: string;
  label: string;
  scheduledIn: number;
  scheduledOut: number;
  net: number;
  /** Yalnızca organizasyon geneli raporda mevcuttur (açılış bakiyesi gerektirir). */
  runningProjectedBalance: number | null;
}

export interface ProjectCashFlowRow {
  projectId: string;
  name: string;
  code: string;
  scheduledInflow: string;
  scheduledOutflow: string;
  projectedNet: string;
  overdueReceivable: string;
  overduePayable: string;
}

interface CashFlowSummary {
  realizedCollections: string;
  realizedPayments: string;
  realizedNet: string;
  scheduledCollections: string;
  scheduledPayments: string;
  scheduledNet: string;
}

export interface OrganizationCashFlowReport {
  scope: "ORGANIZATION";
  filter: CashFlowFilterInput;
  rangeStart: Date;
  rangeEnd: Date;
  projectFilter: { id: string; name: string } | null;
  openingBalance: string;
  projectedClosingBalance: string;
  projectedClosingBalanceIsEstimate: true;
  summary: CashFlowSummary;
  receivableBuckets: MaturityBuckets;
  payableBuckets: MaturityBuckets;
  monthlyProjection: CashFlowMonthlyPoint[];
  receivables: MaturityListSection;
  payables: MaturityListSection;
  receivablesNoDueDate: MaturityListSection;
  payablesNoDueDate: MaturityListSection;
  projectComparison: ProjectCashFlowRow[];
  projectComparisonTruncated: boolean;
}

export interface ProjectManagerCashFlowReport {
  scope: "PROJECT_MANAGER";
  filter: CashFlowFilterInput;
  rangeStart: Date;
  rangeEnd: Date;
  projectFilter: { id: string; name: string } | null;
  hasAssignedProjects: boolean;
  summary: CashFlowSummary;
  receivableBuckets: MaturityBuckets;
  payableBuckets: MaturityBuckets;
  monthlyProjection: CashFlowMonthlyPoint[];
  receivables: MaturityListSection;
  payables: MaturityListSection;
  receivablesNoDueDate: MaturityListSection;
  payablesNoDueDate: MaturityListSection;
  projectComparison: ProjectCashFlowRow[];
  projectComparisonTruncated: boolean;
}

export type CashFlowReport = OrganizationCashFlowReport | ProjectManagerCashFlowReport;

/**
 * Seçilen filtreyi somut bir [start, end) tarih aralığına çevirir. `CUSTOM`
 * için başlangıç/bitiş takvim günü kabul edilir (bitiş dahil) — bkz.
 * lib/validation/reports.ts `cashFlowFilterSchema` (azami 366 gün, sunucuda
 * doğrulanır). Diğer aralıklar bugünden (Istanbul takvimi) ileriye dönük
 * sabit pencerelerdir.
 */
export function resolveCashFlowRange(filter: CashFlowFilterInput, now: Date): DateRange {
  if (filter.range === "CURRENT_MONTH") return getDateRange("CURRENT_MONTH", now);
  if (filter.range === "CURRENT_YEAR") return getDateRange("CURRENT_YEAR", now);
  if (filter.range === "NEXT_30_DAYS") {
    const start = startOfIstanbulDay(now);
    return { start, end: addIstanbulDays(start, 30) };
  }
  if (filter.range === "NEXT_90_DAYS") {
    const start = startOfIstanbulDay(now);
    return { start, end: addIstanbulDays(start, 90) };
  }
  // CUSTOM: şema başlangıç/bitişi zorunlu kılar; savunma amaçlı, eksikse
  // NEXT_30_DAYS'e düşer (bu servise doğrulanmamış veri hiç ulaşmamalıdır —
  // bkz. lib/validation/reports.ts parseCashFlowFilter, çağıran sorumludur).
  if (filter.startDate && filter.endDate && filter.endDate > filter.startDate) {
    const start = startOfIstanbulDay(filter.startDate);
    const end = addIstanbulDays(startOfIstanbulDay(filter.endDate), 1);
    return { start, end };
  }
  const start = startOfIstanbulDay(now);
  return { start, end: addIstanbulDays(start, 30) };
}

interface MaturityBoundaries {
  todayStart: Date;
  todayEnd: Date;
  next7End: Date;
  next30End: Date;
  next60End: Date;
  next90End: Date;
}

function buildMaturityBoundaries(now: Date): MaturityBoundaries {
  const todayStart = startOfIstanbulDay(now);
  return {
    todayStart,
    todayEnd: addIstanbulDays(todayStart, 1),
    next7End: addIstanbulDays(todayStart, 8),
    next30End: addIstanbulDays(todayStart, 31),
    next60End: addIstanbulDays(todayStart, 61),
    next90End: addIstanbulDays(todayStart, 91),
  };
}

const EMPTY_BUCKETS: MaturityBuckets = {
  overdue: "0",
  dueToday: "0",
  next7Days: "0",
  next30Days: "0",
  days31to60: "0",
  days61to90: "0",
  over90Days: "0",
  noDueDate: "0",
};

interface MaturityBucketRow {
  project_id: string | null;
  overdue: string;
  due_today: string;
  next7: string;
  next30: string;
  b31_60: string;
  b61_90: string;
  over90: string;
  no_due_date: string;
}

function toMaturityBuckets(row: MaturityBucketRow | undefined): MaturityBuckets {
  if (!row) return EMPTY_BUCKETS;
  return {
    overdue: row.overdue,
    dueToday: row.due_today,
    next7Days: row.next7,
    next30Days: row.next30,
    days31to60: row.b31_60,
    days61to90: row.b61_90,
    over90Days: row.over90,
    noDueDate: row.no_due_date,
  };
}

/**
 * Vade bucket toplamlarını proje bazında (NULL proje dahil) tek bir sınırlı
 * SQL sorgusuyla hesaplar — kayıt sayısından bağımsız, sabit maliyetli.
 * Kalan tutar (remaining) satır bazında `totalAmount - Σ(aktif settlement)`
 * alt sorguda türetilir (bkz. `getOpenAndOverdueTotals` ile aynı desen,
 * server/services/ledger.ts). `CANCELLED` kayıtlar tamamen hariç tutulur.
 */
async function getMaturityBucketsGrouped(params: {
  organizationId: string;
  type: TransactionType;
  projectIds?: string[];
  boundaries: MaturityBoundaries;
}): Promise<Map<string | null, MaturityBuckets>> {
  const { organizationId, type, projectIds, boundaries } = params;
  if (projectIds && projectIds.length === 0) return new Map();
  const projectFilter = projectIds ? Prisma.sql`AND ft."projectId" = ANY(${projectIds})` : Prisma.sql``;
  const { todayStart, todayEnd, next7End, next30End, next60End, next90End } = boundaries;

  const rows = await db.$queryRaw<MaturityBucketRow[]>(Prisma.sql`
    SELECT
      sub.project_id AS project_id,
      COALESCE(SUM(CASE WHEN sub.remaining > 0 AND sub.due_date IS NOT NULL AND sub.due_date < ${todayStart} THEN sub.remaining ELSE 0 END), 0)::text AS overdue,
      COALESCE(SUM(CASE WHEN sub.remaining > 0 AND sub.due_date IS NOT NULL AND sub.due_date >= ${todayStart} AND sub.due_date < ${todayEnd} THEN sub.remaining ELSE 0 END), 0)::text AS due_today,
      COALESCE(SUM(CASE WHEN sub.remaining > 0 AND sub.due_date IS NOT NULL AND sub.due_date >= ${todayEnd} AND sub.due_date < ${next7End} THEN sub.remaining ELSE 0 END), 0)::text AS next7,
      COALESCE(SUM(CASE WHEN sub.remaining > 0 AND sub.due_date IS NOT NULL AND sub.due_date >= ${next7End} AND sub.due_date < ${next30End} THEN sub.remaining ELSE 0 END), 0)::text AS next30,
      COALESCE(SUM(CASE WHEN sub.remaining > 0 AND sub.due_date IS NOT NULL AND sub.due_date >= ${next30End} AND sub.due_date < ${next60End} THEN sub.remaining ELSE 0 END), 0)::text AS b31_60,
      COALESCE(SUM(CASE WHEN sub.remaining > 0 AND sub.due_date IS NOT NULL AND sub.due_date >= ${next60End} AND sub.due_date < ${next90End} THEN sub.remaining ELSE 0 END), 0)::text AS b61_90,
      COALESCE(SUM(CASE WHEN sub.remaining > 0 AND sub.due_date IS NOT NULL AND sub.due_date >= ${next90End} THEN sub.remaining ELSE 0 END), 0)::text AS over90,
      COALESCE(SUM(CASE WHEN sub.remaining > 0 AND sub.due_date IS NULL THEN sub.remaining ELSE 0 END), 0)::text AS no_due_date
    FROM (
      SELECT
        ft.id,
        ft."projectId" AS project_id,
        ft."dueDate" AS due_date,
        ft."totalAmount" - COALESCE(s.settled, 0) AS remaining
      FROM "FinancialTransaction" ft
      LEFT JOIN (
        SELECT "transactionId", SUM(amount) AS settled
        FROM "Settlement"
        WHERE status = 'ACTIVE'
        GROUP BY "transactionId"
      ) s ON s."transactionId" = ft.id
      WHERE ft."organizationId" = ${organizationId}
        AND ft.type = ${type}::"TransactionType"
        AND ft.status != 'CANCELLED'
        ${projectFilter}
    ) sub
    GROUP BY sub.project_id
  `);

  return new Map(rows.map((r) => [r.project_id, toMaturityBuckets(r)]));
}

function sumBuckets(map: Map<string | null, MaturityBuckets>): MaturityBuckets {
  let acc = { ...EMPTY_BUCKETS };
  for (const b of map.values()) {
    acc = {
      overdue: toDecimal(acc.overdue).plus(toDecimal(b.overdue)).toString(),
      dueToday: toDecimal(acc.dueToday).plus(toDecimal(b.dueToday)).toString(),
      next7Days: toDecimal(acc.next7Days).plus(toDecimal(b.next7Days)).toString(),
      next30Days: toDecimal(acc.next30Days).plus(toDecimal(b.next30Days)).toString(),
      days31to60: toDecimal(acc.days31to60).plus(toDecimal(b.days31to60)).toString(),
      days61to90: toDecimal(acc.days61to90).plus(toDecimal(b.days61to90)).toString(),
      over90Days: toDecimal(acc.over90Days).plus(toDecimal(b.over90Days)).toString(),
      noDueDate: toDecimal(acc.noDueDate).plus(toDecimal(b.noDueDate)).toString(),
    };
  }
  return acc;
}

interface ScheduledRow {
  project_id: string | null;
  scheduled: string;
}

/**
 * "Bugünden itibaren, senaryoya göre kaydırılmış vade `<` seçilen dönem
 * sonu" kesişimindeki kalan tutarı proje bazında toplar. Vadesi geçmiş
 * kayıtlar da dahildir (hâlâ tahsil/ödeme bekleniyor, yalnızca gecikmiş) —
 * bu, standart alacak/borç nakit projeksiyonu yaklaşımıdır. Senaryo
 * kaydırması yalnızca karşılaştırma tarihini değiştirir, DB'deki vade
 * tarihini asla değiştirmez (sunum amaçlı, bkz. lib/validation/reports.ts).
 */
async function getScheduledTotalsGrouped(params: {
  organizationId: string;
  type: TransactionType;
  projectIds?: string[];
  cutoff: Date;
  delayDays: number;
}): Promise<Map<string | null, Prisma.Decimal>> {
  const { organizationId, type, projectIds, cutoff, delayDays } = params;
  if (projectIds && projectIds.length === 0) return new Map();
  const projectFilter = projectIds ? Prisma.sql`AND ft."projectId" = ANY(${projectIds})` : Prisma.sql``;

  const rows = await db.$queryRaw<ScheduledRow[]>(Prisma.sql`
    SELECT
      sub.project_id AS project_id,
      COALESCE(SUM(CASE
        WHEN sub.remaining > 0 AND sub.due_date IS NOT NULL
          AND (sub.due_date + (${delayDays}::int * INTERVAL '1 day')) < ${cutoff}
        THEN sub.remaining ELSE 0 END), 0)::text AS scheduled
    FROM (
      SELECT
        ft.id,
        ft."projectId" AS project_id,
        ft."dueDate" AS due_date,
        ft."totalAmount" - COALESCE(s.settled, 0) AS remaining
      FROM "FinancialTransaction" ft
      LEFT JOIN (
        SELECT "transactionId", SUM(amount) AS settled
        FROM "Settlement"
        WHERE status = 'ACTIVE'
        GROUP BY "transactionId"
      ) s ON s."transactionId" = ft.id
      WHERE ft."organizationId" = ${organizationId}
        AND ft.type = ${type}::"TransactionType"
        AND ft.status != 'CANCELLED'
        ${projectFilter}
    ) sub
    GROUP BY sub.project_id
  `);

  return new Map(rows.map((r) => [r.project_id, toDecimal(r.scheduled)]));
}

function sumScheduled(map: Map<string | null, Prisma.Decimal>): Prisma.Decimal {
  let total = ZERO;
  for (const v of map.values()) total = total.plus(v);
  return total;
}

/** Sabit boyutlu (bounded) aday listesi: durum indeksini kullanır, yalnızca açık/kısmi/vadesi geçen kayıtlar taranır. */
async function findMaturityListSection(params: {
  organizationId: string;
  type: TransactionType;
  projectIds?: string[];
  now: Date;
  limit: number;
}): Promise<MaturityListSection> {
  const { organizationId, type, projectIds, now, limit } = params;
  if (projectIds && projectIds.length === 0) return { rows: [], totalOpenCount: 0, truncated: false };

  const where = {
    organizationId,
    type,
    status: { in: OPEN_STATUSES },
    dueDate: { not: null },
    ...(projectIds ? { projectId: { in: projectIds } } : {}),
  };

  const [candidates, totalOpenCount] = await Promise.all([
    db.financialTransaction.findMany({
      where,
      orderBy: [{ dueDate: "asc" }, { id: "asc" }],
      take: limit,
      select: {
        id: true,
        description: true,
        documentNumber: true,
        totalAmount: true,
        dueDate: true,
        currency: true,
        customer: { select: { name: true } },
        supplier: { select: { name: true } },
        project: { select: { name: true } },
      },
    }),
    db.financialTransaction.count({ where }),
  ]);
  if (candidates.length === 0) return { rows: [], totalOpenCount, truncated: false };

  const settled = await db.settlement.groupBy({
    by: ["transactionId"],
    where: { transactionId: { in: candidates.map((c) => c.id) }, status: "ACTIVE" },
    _sum: { amount: true },
  });
  const settledMap = new Map(settled.map((s) => [s.transactionId, toDecimal(s._sum.amount ?? ZERO)]));
  const todayStart = startOfIstanbulDay(now);

  const rows: MaturityListRow[] = candidates
    .map((c) => {
      const settledAmount = settledMap.get(c.id) ?? ZERO;
      const remaining = toDecimal(c.totalAmount).minus(settledAmount);
      const dueDate = c.dueDate as Date;
      const diffDays = Math.round((dueDate.getTime() - todayStart.getTime()) / (24 * 60 * 60 * 1000));
      return {
        id: c.id,
        description: c.description,
        counterpartName: c.customer?.name ?? c.supplier?.name ?? null,
        projectName: c.project?.name ?? null,
        documentNumber: c.documentNumber,
        originalAmount: toDecimal(c.totalAmount).toString(),
        collectedOrPaidAmount: settledAmount.toString(),
        remainingAmount: remaining.toString(),
        dueDate,
        daysOverdueOrRemaining: diffDays,
        isOverdue: diffDays < 0,
        currency: c.currency,
      };
    })
    .filter((r) => toDecimal(r.remainingAmount).greaterThan(ZERO));

  return { rows, totalOpenCount, truncated: totalOpenCount > rows.length };
}

async function findNoDueDateSection(params: {
  organizationId: string;
  type: TransactionType;
  projectIds?: string[];
  limit: number;
}): Promise<MaturityListSection> {
  const { organizationId, type, projectIds, limit } = params;
  if (projectIds && projectIds.length === 0) return { rows: [], totalOpenCount: 0, truncated: false };

  const where = {
    organizationId,
    type,
    status: { in: OPEN_STATUSES_NO_DUE_DATE },
    dueDate: null,
    ...(projectIds ? { projectId: { in: projectIds } } : {}),
  };

  const [candidates, totalOpenCount] = await Promise.all([
    db.financialTransaction.findMany({
      where,
      orderBy: [{ issueDate: "desc" }, { id: "asc" }],
      take: limit,
      select: {
        id: true,
        description: true,
        documentNumber: true,
        totalAmount: true,
        currency: true,
        customer: { select: { name: true } },
        supplier: { select: { name: true } },
        project: { select: { name: true } },
      },
    }),
    db.financialTransaction.count({ where }),
  ]);
  if (candidates.length === 0) return { rows: [], totalOpenCount, truncated: false };

  const settled = await db.settlement.groupBy({
    by: ["transactionId"],
    where: { transactionId: { in: candidates.map((c) => c.id) }, status: "ACTIVE" },
    _sum: { amount: true },
  });
  const settledMap = new Map(settled.map((s) => [s.transactionId, toDecimal(s._sum.amount ?? ZERO)]));

  const rows: MaturityListRow[] = candidates
    .map((c) => {
      const settledAmount = settledMap.get(c.id) ?? ZERO;
      const remaining = toDecimal(c.totalAmount).minus(settledAmount);
      return {
        id: c.id,
        description: c.description,
        counterpartName: c.customer?.name ?? c.supplier?.name ?? null,
        projectName: c.project?.name ?? null,
        documentNumber: c.documentNumber,
        originalAmount: toDecimal(c.totalAmount).toString(),
        collectedOrPaidAmount: settledAmount.toString(),
        remainingAmount: remaining.toString(),
        dueDate: null,
        daysOverdueOrRemaining: null,
        isOverdue: false,
        currency: c.currency,
      };
    })
    .filter((r) => toDecimal(r.remainingAmount).greaterThan(ZERO));

  return { rows, totalOpenCount, truncated: totalOpenCount > rows.length };
}

/** [todayStart, periodEnd) penceresini kapsayan takvim ayı etiketlerini üretir — ileri dönük, değişken uzunlukta. */
function buildForwardMonthLabels(window: DateRange): MonthLabel[] {
  if (window.end <= window.start) return [];
  const startIst = toIstanbul(window.start);
  const endIst = toIstanbul(new Date(window.end.getTime() - 1));
  const y0 = startIst.getUTCFullYear();
  const m0 = startIst.getUTCMonth();
  const y1 = endIst.getUTCFullYear();
  const m1 = endIst.getUTCMonth();
  const totalMonths = Math.min((y1 - y0) * 12 + (m1 - m0) + 1, MONTHLY_PROJECTION_MAX_MONTHS);

  const months: MonthLabel[] = [];
  for (let i = 0; i < totalMonths; i++) {
    const monthStart = fromIstanbulComponents(y0, m0 + i, 1);
    const ist = toIstanbul(monthStart);
    const key = `${ist.getUTCFullYear()}-${String(ist.getUTCMonth() + 1).padStart(2, "0")}`;
    const label = new Intl.DateTimeFormat("tr-TR", { month: "short", year: "2-digit", timeZone: "Europe/Istanbul" }).format(
      monthStart,
    );
    months.push({ key, label, monthStart });
  }
  return months;
}

async function findScheduledRowsForMonthlyProjection(
  organizationId: string,
  type: TransactionType,
  projectIds: string[] | undefined,
  window: DateRange,
): Promise<{ id: string; dueDate: Date | null; totalAmount: Prisma.Decimal }[]> {
  if (window.end <= window.start) return [];
  if (projectIds && projectIds.length === 0) return [];
  return db.financialTransaction.findMany({
    where: {
      organizationId,
      type,
      status: { in: OPEN_STATUSES },
      dueDate: { gte: window.start, lt: window.end },
      ...(projectIds ? { projectId: { in: projectIds } } : {}),
    },
    orderBy: [{ dueDate: "asc" }, { id: "asc" }],
    take: MONTHLY_PROJECTION_ROW_CAP,
    select: { id: true, dueDate: true, totalAmount: true },
  });
}

async function buildMonthlyProjection(params: {
  organizationId: string;
  projectIds?: string[];
  now: Date;
  periodEnd: Date;
  openingBalance: Prisma.Decimal | null;
  collectionDelayDays: number;
  paymentDelayDays: number;
}): Promise<CashFlowMonthlyPoint[]> {
  const { organizationId, projectIds, now, periodEnd, openingBalance, collectionDelayDays, paymentDelayDays } = params;
  const window: DateRange = { start: startOfIstanbulDay(now), end: periodEnd };
  const months = buildForwardMonthLabels(window);
  if (months.length === 0) return [];

  const [incomeRows, expenseRows] = await Promise.all([
    findScheduledRowsForMonthlyProjection(organizationId, "INCOME", projectIds, window),
    findScheduledRowsForMonthlyProjection(organizationId, "EXPENSE", projectIds, window),
  ]);

  const incomeIds = incomeRows.map((r) => r.id);
  const expenseIds = expenseRows.map((r) => r.id);
  const [incomeSettled, expenseSettled] = await Promise.all([
    incomeIds.length
      ? db.settlement.groupBy({ by: ["transactionId"], where: { transactionId: { in: incomeIds }, status: "ACTIVE" }, _sum: { amount: true } })
      : Promise.resolve([]),
    expenseIds.length
      ? db.settlement.groupBy({ by: ["transactionId"], where: { transactionId: { in: expenseIds }, status: "ACTIVE" }, _sum: { amount: true } })
      : Promise.resolve([]),
  ]);
  const incomeSettledMap = new Map(incomeSettled.map((s) => [s.transactionId, toDecimal(s._sum.amount ?? ZERO)]));
  const expenseSettledMap = new Map(expenseSettled.map((s) => [s.transactionId, toDecimal(s._sum.amount ?? ZERO)]));

  const shift = (d: Date, days: number) => (days === 0 ? d : addIstanbulDays(d, days));

  const incomeBucketRows = incomeRows
    .map((r) => ({
      amount: toDecimal(r.totalAmount).minus(incomeSettledMap.get(r.id) ?? ZERO),
      date: shift(r.dueDate as Date, collectionDelayDays),
    }))
    .filter((r) => r.amount.greaterThan(ZERO));
  const expenseBucketRows = expenseRows
    .map((r) => ({
      amount: toDecimal(r.totalAmount).minus(expenseSettledMap.get(r.id) ?? ZERO),
      date: shift(r.dueDate as Date, paymentDelayDays),
    }))
    .filter((r) => r.amount.greaterThan(ZERO));

  const scheduledInBuckets = bucketByMonth(incomeBucketRows, months);
  const scheduledOutBuckets = bucketByMonth(expenseBucketRows, months);

  let running = openingBalance;
  return months.map((m, i) => {
    const scheduledIn = scheduledInBuckets[i];
    const scheduledOut = scheduledOutBuckets[i];
    const net = scheduledIn.minus(scheduledOut);
    if (running !== null) running = running.plus(net);
    return {
      key: m.key,
      label: m.label,
      scheduledIn: Number(scheduledIn.toFixed(2)),
      scheduledOut: Number(scheduledOut.toFixed(2)),
      net: Number(net.toFixed(2)),
      runningProjectedBalance: running !== null ? Number(running.toFixed(2)) : null,
    };
  });
}

async function buildProjectComparison(params: {
  organizationId: string;
  projectIds: string[] | undefined;
  now: Date;
  periodEnd: Date;
  collectionDelayDays: number;
  paymentDelayDays: number;
  boundaries: MaturityBoundaries;
}): Promise<{ rows: ProjectCashFlowRow[]; truncated: boolean }> {
  const { organizationId, projectIds, periodEnd, collectionDelayDays, paymentDelayDays, boundaries } = params;

  const [projects, incomeOverdueMap, expenseOverdueMap, incomeScheduledMap, expenseScheduledMap] = await Promise.all([
    db.project.findMany({
      where: { organizationId, ...(projectIds ? { id: { in: projectIds } } : {}) },
      select: { id: true, name: true, code: true },
    }),
    getMaturityBucketsGrouped({ organizationId, type: "INCOME", projectIds, boundaries }),
    getMaturityBucketsGrouped({ organizationId, type: "EXPENSE", projectIds, boundaries }),
    getScheduledTotalsGrouped({ organizationId, type: "INCOME", projectIds, cutoff: periodEnd, delayDays: collectionDelayDays }),
    getScheduledTotalsGrouped({ organizationId, type: "EXPENSE", projectIds, cutoff: periodEnd, delayDays: paymentDelayDays }),
  ]);

  const rows: ProjectCashFlowRow[] = projects.map((p) => {
    const scheduledInflow = incomeScheduledMap.get(p.id) ?? ZERO;
    const scheduledOutflow = expenseScheduledMap.get(p.id) ?? ZERO;
    const overdueReceivable = toDecimal(incomeOverdueMap.get(p.id)?.overdue ?? "0");
    const overduePayable = toDecimal(expenseOverdueMap.get(p.id)?.overdue ?? "0");
    return {
      projectId: p.id,
      name: p.name,
      code: p.code,
      scheduledInflow: scheduledInflow.toString(),
      scheduledOutflow: scheduledOutflow.toString(),
      projectedNet: scheduledInflow.minus(scheduledOutflow).toString(),
      overdueReceivable: overdueReceivable.toString(),
      overduePayable: overduePayable.toString(),
    };
  });

  rows.sort((a, b) => {
    const exposureA = Math.abs(Number(a.overdueReceivable)) + Math.abs(Number(a.overduePayable)) + Math.abs(Number(a.projectedNet));
    const exposureB = Math.abs(Number(b.overdueReceivable)) + Math.abs(Number(b.overduePayable)) + Math.abs(Number(b.projectedNet));
    if (exposureB !== exposureA) return exposureB - exposureA;
    return a.code.localeCompare(b.code);
  });

  return { rows: rows.slice(0, PROJECT_COMPARISON_LIMIT), truncated: rows.length > PROJECT_COMPARISON_LIMIT };
}

export async function getCashFlowReport(actor: SessionUser, filter: CashFlowFilterInput): Promise<CashFlowReport> {
  if (canViewAllProjects(actor.role)) {
    return getOrganizationCashFlowReport(actor, filter);
  }
  return getProjectManagerCashFlowReport(actor, filter);
}

async function getOrganizationCashFlowReport(
  actor: SessionUser,
  filter: CashFlowFilterInput,
): Promise<OrganizationCashFlowReport> {
  const now = new Date();
  const periodRange = resolveCashFlowRange(filter, now);
  const boundaries = buildMaturityBoundaries(now);
  const { collectionDelayDays, paymentDelayDays } = DELAY_DAYS_BY_SCENARIO[filter.scenario];

  const projectFilter = await resolveProjectFilter(actor, filter.projectId);
  const moneyScope = projectFilter ? [projectFilter.id] : undefined;

  const [
    settlementTotals,
    openingBalance,
    incomeBucketsMap,
    expenseBucketsMap,
    scheduledIncomeMap,
    scheduledExpenseMap,
    receivables,
    payables,
    receivablesNoDueDate,
    payablesNoDueDate,
    projectComparison,
  ] = await Promise.all([
    getSettlementTotalsForRange(actor.organizationId, periodRange, moneyScope),
    getOrganizationCashBalance(db, actor.organizationId),
    getMaturityBucketsGrouped({ organizationId: actor.organizationId, type: "INCOME", projectIds: moneyScope, boundaries }),
    getMaturityBucketsGrouped({ organizationId: actor.organizationId, type: "EXPENSE", projectIds: moneyScope, boundaries }),
    getScheduledTotalsGrouped({
      organizationId: actor.organizationId,
      type: "INCOME",
      projectIds: moneyScope,
      cutoff: periodRange.end,
      delayDays: collectionDelayDays,
    }),
    getScheduledTotalsGrouped({
      organizationId: actor.organizationId,
      type: "EXPENSE",
      projectIds: moneyScope,
      cutoff: periodRange.end,
      delayDays: paymentDelayDays,
    }),
    findMaturityListSection({ organizationId: actor.organizationId, type: "INCOME", projectIds: moneyScope, now, limit: MATURITY_LIST_LIMIT }),
    findMaturityListSection({ organizationId: actor.organizationId, type: "EXPENSE", projectIds: moneyScope, now, limit: MATURITY_LIST_LIMIT }),
    findNoDueDateSection({ organizationId: actor.organizationId, type: "INCOME", projectIds: moneyScope, limit: NO_DUE_DATE_LIST_LIMIT }),
    findNoDueDateSection({ organizationId: actor.organizationId, type: "EXPENSE", projectIds: moneyScope, limit: NO_DUE_DATE_LIST_LIMIT }),
    buildProjectComparison({
      organizationId: actor.organizationId,
      projectIds: moneyScope,
      now,
      periodEnd: periodRange.end,
      collectionDelayDays,
      paymentDelayDays,
      boundaries,
    }),
  ]);

  // Aylık projeksiyonun koşan bakiye sütunu gerçek açılış bakiyesine bağımlı
  // olduğundan (yukarıdaki paralel sorgulardan biri), tek geçişte — mükerrer
  // sorgu yapılmadan — burada hesaplanır.
  const monthlyProjection = await buildMonthlyProjection({
    organizationId: actor.organizationId,
    projectIds: moneyScope,
    now,
    periodEnd: periodRange.end,
    openingBalance,
    collectionDelayDays,
    paymentDelayDays,
  });

  const scheduledCollections = sumScheduled(scheduledIncomeMap);
  const scheduledPayments = sumScheduled(scheduledExpenseMap);
  const projectedClosingBalance = openingBalance.plus(scheduledCollections).minus(scheduledPayments);

  return {
    scope: "ORGANIZATION",
    filter,
    rangeStart: periodRange.start,
    rangeEnd: periodRange.end,
    projectFilter,
    openingBalance: openingBalance.toString(),
    projectedClosingBalance: projectedClosingBalance.toString(),
    projectedClosingBalanceIsEstimate: true,
    summary: {
      realizedCollections: settlementTotals.collected.toString(),
      realizedPayments: settlementTotals.paid.toString(),
      realizedNet: settlementTotals.net.toString(),
      scheduledCollections: scheduledCollections.toString(),
      scheduledPayments: scheduledPayments.toString(),
      scheduledNet: scheduledCollections.minus(scheduledPayments).toString(),
    },
    receivableBuckets: sumBuckets(incomeBucketsMap),
    payableBuckets: sumBuckets(expenseBucketsMap),
    monthlyProjection,
    receivables,
    payables,
    receivablesNoDueDate,
    payablesNoDueDate,
    projectComparison: projectComparison.rows,
    projectComparisonTruncated: projectComparison.truncated,
  };
}

async function getProjectManagerCashFlowReport(
  actor: SessionUser,
  filter: CashFlowFilterInput,
): Promise<ProjectManagerCashFlowReport> {
  const now = new Date();
  const periodRange = resolveCashFlowRange(filter, now);
  const boundaries = buildMaturityBoundaries(now);
  const { collectionDelayDays, paymentDelayDays } = DELAY_DAYS_BY_SCENARIO[filter.scenario];

  const memberships = await db.projectMember.findMany({
    where: { organizationId: actor.organizationId, userId: actor.id },
    select: { projectId: true },
  });
  const assignedIds = memberships.map((m) => m.projectId);

  const projectFilter = await resolveProjectFilter(actor, filter.projectId, assignedIds);

  if (assignedIds.length === 0) {
    return {
      scope: "PROJECT_MANAGER",
      filter,
      rangeStart: periodRange.start,
      rangeEnd: periodRange.end,
      projectFilter,
      hasAssignedProjects: false,
      summary: {
        realizedCollections: "0",
        realizedPayments: "0",
        realizedNet: "0",
        scheduledCollections: "0",
        scheduledPayments: "0",
        scheduledNet: "0",
      },
      receivableBuckets: EMPTY_BUCKETS,
      payableBuckets: EMPTY_BUCKETS,
      monthlyProjection: [],
      receivables: { rows: [], totalOpenCount: 0, truncated: false },
      payables: { rows: [], totalOpenCount: 0, truncated: false },
      receivablesNoDueDate: { rows: [], totalOpenCount: 0, truncated: false },
      payablesNoDueDate: { rows: [], totalOpenCount: 0, truncated: false },
      projectComparison: [],
      projectComparisonTruncated: false,
    };
  }

  const moneyScope = projectFilter ? [projectFilter.id] : assignedIds;

  const [
    settlementTotals,
    incomeBucketsMap,
    expenseBucketsMap,
    scheduledIncomeMap,
    scheduledExpenseMap,
    monthlyProjection,
    receivables,
    payables,
    receivablesNoDueDate,
    payablesNoDueDate,
    projectComparison,
  ] = await Promise.all([
    getSettlementTotalsForRange(actor.organizationId, periodRange, moneyScope),
    getMaturityBucketsGrouped({ organizationId: actor.organizationId, type: "INCOME", projectIds: moneyScope, boundaries }),
    getMaturityBucketsGrouped({ organizationId: actor.organizationId, type: "EXPENSE", projectIds: moneyScope, boundaries }),
    getScheduledTotalsGrouped({
      organizationId: actor.organizationId,
      type: "INCOME",
      projectIds: moneyScope,
      cutoff: periodRange.end,
      delayDays: collectionDelayDays,
    }),
    getScheduledTotalsGrouped({
      organizationId: actor.organizationId,
      type: "EXPENSE",
      projectIds: moneyScope,
      cutoff: periodRange.end,
      delayDays: paymentDelayDays,
    }),
    buildMonthlyProjection({
      organizationId: actor.organizationId,
      projectIds: moneyScope,
      now,
      periodEnd: periodRange.end,
      openingBalance: null,
      collectionDelayDays,
      paymentDelayDays,
    }),
    findMaturityListSection({ organizationId: actor.organizationId, type: "INCOME", projectIds: moneyScope, now, limit: MATURITY_LIST_LIMIT }),
    findMaturityListSection({ organizationId: actor.organizationId, type: "EXPENSE", projectIds: moneyScope, now, limit: MATURITY_LIST_LIMIT }),
    findNoDueDateSection({ organizationId: actor.organizationId, type: "INCOME", projectIds: moneyScope, limit: NO_DUE_DATE_LIST_LIMIT }),
    findNoDueDateSection({ organizationId: actor.organizationId, type: "EXPENSE", projectIds: moneyScope, limit: NO_DUE_DATE_LIST_LIMIT }),
    buildProjectComparison({
      organizationId: actor.organizationId,
      projectIds: moneyScope,
      now,
      periodEnd: periodRange.end,
      collectionDelayDays,
      paymentDelayDays,
      boundaries,
    }),
  ]);

  const scheduledCollections = sumScheduled(scheduledIncomeMap);
  const scheduledPayments = sumScheduled(scheduledExpenseMap);

  return {
    scope: "PROJECT_MANAGER",
    filter,
    rangeStart: periodRange.start,
    rangeEnd: periodRange.end,
    projectFilter,
    hasAssignedProjects: true,
    summary: {
      realizedCollections: settlementTotals.collected.toString(),
      realizedPayments: settlementTotals.paid.toString(),
      realizedNet: settlementTotals.net.toString(),
      scheduledCollections: scheduledCollections.toString(),
      scheduledPayments: scheduledPayments.toString(),
      scheduledNet: scheduledCollections.minus(scheduledPayments).toString(),
    },
    receivableBuckets: sumBuckets(incomeBucketsMap),
    payableBuckets: sumBuckets(expenseBucketsMap),
    monthlyProjection,
    receivables,
    payables,
    receivablesNoDueDate,
    payablesNoDueDate,
    projectComparison: projectComparison.rows,
    projectComparisonTruncated: projectComparison.truncated,
  };
}
