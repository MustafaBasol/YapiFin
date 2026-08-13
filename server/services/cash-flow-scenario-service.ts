import { Prisma } from "@prisma/client";
import type { TransactionType } from "@prisma/client";
import type { SessionUser } from "@/lib/auth/session";
import { db } from "@/lib/db";
import { addIstanbulDays, startOfIstanbulDay } from "@/lib/dates";
import { formatDate, formatHalfOpenPeriod, formatMoney } from "@/lib/utils";
import { checkCapability } from "@/lib/entitlements/entitlement-service";
import { toDecimal, ZERO, getOrganizationCashBalance } from "@/server/services/ledger";
import {
  assertResolvedScopeForActor,
  resolveActorReportScope,
  type ActorReportScope,
} from "@/server/services/dashboard-service";
import { AiEntitlementError, requestAiCompletion } from "@/server/services/ai-usage-reporting-service";
import { DEFAULT_INSIGHT_THRESHOLDS, type InsightThresholds } from "@/lib/ai/insights/thresholds";
import type { AiProvider } from "@/lib/ai";
import { createAiCorrelationId, parseStructuredOutput } from "@/lib/ai";
import { cashFlowScenarioPromptTemplate } from "@/lib/ai/cash-flow-scenario/prompt";
import {
  cashFlowScenarioModelResponseSchema,
  cashFlowScenarioSchema,
  type CashFlowScenarioModelResponse,
  type CashFlowScenarioResult,
  type CashScenarioCellDto,
  type CashScenarioDriverDto,
} from "@/lib/ai/cash-flow-scenario/schema";
import {
  CASH_SCENARIO_ASSUMPTION_LABELS,
  CASH_SCENARIO_HORIZON_DAYS,
  CASH_SCENARIO_LABELS,
  CASH_SCENARIO_MAX_HORIZON_DAYS,
  computeCashScenarioCells,
  type CashScenarioAssumptionId,
  type CashScenarioCell,
  type CashScenarioRow,
} from "@/server/services/cash-flow-scenario-math";
import {
  buildCashScenarioDrivers,
  rankCashScenarioDrivers,
  type CashScenarioDriver,
} from "@/server/services/cash-flow-scenario-drivers";

/**
 * YF-705 — AI Nakit Akışı Senaryo ve Risk Tahmini.
 *
 * ## Katmanlar
 *
 * 1. **Deterministik motor** — `cash-flow-scenario-math.ts` (saf, DB'siz).
 *    Üç senaryo × üç ufuk = dokuz hücre, TEK satır kümesinden üretilir.
 * 2. **Deterministik risk sürücüleri** — `cash-flow-scenario-drivers.ts` (saf).
 *    Eşikler YF-702'nin `InsightThresholds`'undan yeniden kullanılır.
 * 3. **AI metinleştirme** — model YALNIZCA nesir üretir ve önceden verilmiş
 *    `scenarioKey`/`driverId` anahtarlarına atıfta bulunur.
 * 4. **Yetki/kota** — `ai.features` yeteneği + YF-711 kota motoru.
 *
 * ## AI'nin DEĞİŞTİREMEYECEĞİ şeyler
 *
 * Tutarlar, tarihler, kırılma tarihi, minimum nakit, önem dereceleri, senaryo
 * toplamları ve varsayımlar. Model yanıt şemasında tek bir sayısal alan
 * YOKTUR; bilinmeyen anahtarlar sessizce düşürülür (`mergeScenarioNarrative`).
 *
 * ## Neden `ai.cash_flow_scenario` yeteneği KULLANILMIYOR
 *
 * Bu kimlik `docs/PLAN_FEATURE_MATRIX.md` §2.3'te tanımlıdır ancak
 * `lib/entitlements/capabilities.ts` içindeki `CAPABILITY_IDS` listesinde
 * YOKTUR; eklenmesi dört kanonik `Plan` satırını güncelleyen bir migration
 * gerektirir (`resolveCapabilityValue` fail-closed `=== true` karşılaştırması
 * yapar) — yani plan matrisinin değiştirilmesi demektir, bu görevin kapsamı
 * dışıdır. YF-704 (yönetim özeti) ve Ask YapiFin ile BİREBİR aynı gerekçe ve
 * aynı şemsiye kapı kullanılır; hiçbir organizasyonun erişimi genişlemez.
 *
 * ## Bilinen, KASITLI olarak devralınan davranış
 *
 * `getOrganizationCashBalance` hesap TÜRÜNE göre filtrelemez: `CREDIT_CARD`
 * (yükümlülük) hesapları da açılış nakdine dahildir. Bu, YF-401 dashboard'u ve
 * YF-403 nakit akışı raporunun ZATEN kullandığı formüldür; burada filtrelemek
 * aynı ekran ailesinde ÜÇÜNCÜ bir "nakit" tanımı yaratırdı. Hatanın yönü
 * tutucudur (kart borcu nakdi azaltır, kırılmayı ERKENE alır) ve
 * `CREDIT_CARD_IN_OPENING_CASH` varsayımıyla kullanıcıya AÇIKÇA bildirilir.
 */

/** Tek sorguda çekilecek azami satır. Aşılırsa `ROWS_TRUNCATED` varsayımı eklenir. */
export const CASH_SCENARIO_ROW_CAP = 20_000;
const MAX_DRIVERS = 6;
const MAX_DRIVERS_IN_PROMPT = 10;
const MAX_ACTIONS = 3;
const SCENARIO_MAX_OUTPUT_TOKENS = 900;
const AI_FEATURES_CAPABILITY = "ai.features" as const;

async function assertCashFlowScenarioEntitlement(actor: SessionUser): Promise<void> {
  const capability = await checkCapability(db, actor.organizationId, AI_FEATURES_CAPABILITY);
  if (!capability.allowed) {
    throw new AiEntitlementError(
      "AI nakit akışı senaryosu mevcut planınıza dahil değil. Devam etmek için planınızı yükseltmeniz gerekir.",
      "FORBIDDEN",
      "AI_PLAN_REQUIRED",
    );
  }
}

interface RawDatedRow {
  id: string;
  type: TransactionType;
  due_date: Date;
  remaining: string;
  currency: string;
}

/**
 * Q1 — vadesi girilmiş, kalanı pozitif açık kayıtlar. TEK sorgu, HER İKİ tür
 * (INCOME/EXPENSE) birlikte; tür bir WHERE koşulu değil, dönen bir KOLONdur.
 *
 * `dueDate < end90` sınırı ispatlıdır: kaydırılmış yüklem `dueDate + δ < end_N`
 * cebirsel olarak `dueDate < end_N − δ`'dir ve tüm `δ ≥ 0`, `N ≤ 90` için
 * `end_N − δ ≤ end_90`. Negatif kaydırma bu sınırı geçersiz kılacağından
 * matematik modülünde açıkça yasaklanmıştır.
 *
 * Settlement ALT SORGUDA ÖNCEDEN TOPLANIR (`GROUP BY "transactionId"`). Düz bir
 * `LEFT JOIN "Settlement"` satırı settlement sayısı kadar ÇOĞALTIR ve
 * `totalAmount`'ı katlar — bu görevdeki en olası mükerrer sayım hatasıdır.
 * Desen `cash-flow-report-service.ts` içinden birebir kopyalanmıştır.
 *
 * `status <> 'CANCELLED'` kullanılır; `status IN ('OPEN',...)` KULLANILMAZ —
 * saklanan durum kolonu bayat olabilir (yalnızca settlement olaylarında
 * yeniden türetilir), açıklık `remaining > 0` ile türetilir.
 */
async function fetchDatedRows(params: {
  organizationId: string;
  projectIds: string[] | undefined;
  maxCutoff: Date;
}): Promise<{ rows: CashScenarioRow[]; truncated: boolean }> {
  const { organizationId, projectIds, maxCutoff } = params;
  if (projectIds && projectIds.length === 0) return { rows: [], truncated: false };
  const projectFilter = projectIds ? Prisma.sql`AND ft."projectId" = ANY(${projectIds})` : Prisma.sql``;

  const raw = await db.$queryRaw<RawDatedRow[]>(Prisma.sql`
    SELECT sub.id, sub.type, sub.due_date, sub.remaining::text AS remaining, sub.currency
    FROM (
      SELECT
        ft.id,
        ft.type,
        ft."dueDate" AS due_date,
        ft.currency,
        ft."totalAmount" - COALESCE(s.settled, 0) AS remaining
      FROM "FinancialTransaction" ft
      LEFT JOIN (
        SELECT "transactionId", SUM(amount) AS settled
        FROM "Settlement"
        WHERE status = 'ACTIVE'
        GROUP BY "transactionId"
      ) s ON s."transactionId" = ft.id
      WHERE ft."organizationId" = ${organizationId}
        AND ft.status <> 'CANCELLED'
        AND ft."dueDate" IS NOT NULL
        AND ft."dueDate" < ${maxCutoff}
        ${projectFilter}
    ) sub
    WHERE sub.remaining > 0
    ORDER BY sub.due_date ASC, sub.id ASC
    LIMIT ${CASH_SCENARIO_ROW_CAP + 1}
  `);

  const truncated = raw.length > CASH_SCENARIO_ROW_CAP;
  const rows = (truncated ? raw.slice(0, CASH_SCENARIO_ROW_CAP) : raw).map((r) => ({
    id: r.id,
    type: r.type,
    dueDate: r.due_date,
    remaining: toDecimal(r.remaining),
    currency: r.currency,
  }));
  return { rows, truncated };
}

interface RawUndatedRow {
  type: TransactionType;
  total: string;
  cnt: number;
}

/** Q2 — vadesi GİRİLMEMİŞ açık kayıtlar. Tahmine girmez; kapsam açığı olarak raporlanır. */
async function fetchUndatedCoverage(params: {
  organizationId: string;
  projectIds: string[] | undefined;
}): Promise<{ receivable: Prisma.Decimal; payable: Prisma.Decimal; count: number }> {
  const { organizationId, projectIds } = params;
  if (projectIds && projectIds.length === 0) return { receivable: ZERO, payable: ZERO, count: 0 };
  const projectFilter = projectIds ? Prisma.sql`AND ft."projectId" = ANY(${projectIds})` : Prisma.sql``;

  const rows = await db.$queryRaw<RawUndatedRow[]>(Prisma.sql`
    SELECT sub.type, COALESCE(SUM(sub.remaining), 0)::text AS total, COUNT(*)::int AS cnt
    FROM (
      SELECT
        ft.type,
        ft."totalAmount" - COALESCE(s.settled, 0) AS remaining
      FROM "FinancialTransaction" ft
      LEFT JOIN (
        SELECT "transactionId", SUM(amount) AS settled
        FROM "Settlement"
        WHERE status = 'ACTIVE'
        GROUP BY "transactionId"
      ) s ON s."transactionId" = ft.id
      WHERE ft."organizationId" = ${organizationId}
        AND ft.status <> 'CANCELLED'
        AND ft."dueDate" IS NULL
        ${projectFilter}
    ) sub
    WHERE sub.remaining > 0
    GROUP BY sub.type
  `);

  let receivable = ZERO;
  let payable = ZERO;
  let count = 0;
  for (const r of rows) {
    count += r.cnt;
    if (r.type === "INCOME") receivable = toDecimal(r.total);
    else payable = toDecimal(r.total);
  }
  return { receivable, payable, count };
}

export interface GetCashFlowScenariosOptions {
  provider: AiProvider;
  projectId?: string;
  now?: Date;
  idempotencyKey?: string;
  model?: string;
  thresholds?: InsightThresholds;
}

interface ScenarioFacts {
  actorScope: "ORGANIZATION" | "PROJECT_MANAGER";
  projectId: string | null;
  projectName: string | null;
  cashVisibility: boolean;
  cashUnavailableReason: "PROJECT_MANAGER_NO_CASH_VISIBILITY" | "PROJECT_FILTER_SCOPED" | null;
  cells: CashScenarioCell[];
  drivers: CashScenarioDriver[];
  assumptionIds: CashScenarioAssumptionId[];
  coverageGaps: { section: string; reason: string }[];
  isEmptyForecast: boolean;
  todayStart: Date;
}

/** Bir senaryo hücresini modele giden, DEĞİŞTİRİLEMEZ Türkçe olgu cümlesine çevirir. */
function cellFactSentence(cell: CashScenarioCell): string {
  const label = formatHalfOpenPeriod(cell.windowStart, cell.windowEnd);
  const parts = [
    `${CASH_SCENARIO_LABELS[cell.scenario]} (${cell.horizonDays} gün, ${label})`,
    `beklenen tahsilat ${formatMoney(cell.expectedCollections)}`,
    `beklenen ödeme ${formatMoney(cell.expectedPayments)}`,
    `net değişim ${formatMoney(cell.netChange)}`,
  ];
  if (cell.openingCash !== null) parts.push(`açılış nakdi ${formatMoney(cell.openingCash)}`);
  if (cell.endingCash !== null) parts.push(`tahmini kapanış nakdi ${formatMoney(cell.endingCash)}`);
  if (cell.minimumCashPoint) {
    parts.push(
      `en düşük nakit ${formatMoney(cell.minimumCashPoint.amount)} (${
        cell.minimumCashPoint.isOpeningPoint ? "açılış anı" : formatDate(cell.minimumCashPoint.date)
      })`,
    );
  }
  if (cell.breakDate) {
    parts.push(
      cell.alreadyNegativeAtOpening
        ? "nakit açılışta ZATEN negatif"
        : `kritik kırılma tarihi ${formatDate(cell.breakDate)}`,
    );
  } else if (cell.openingCash !== null) {
    parts.push("bu pencerede kırılma yok");
  }
  return `${parts.join("; ")}.`;
}

function toCellDto(cell: CashScenarioCell, aiComment: string | null): CashScenarioCellDto {
  return {
    scenario: cell.scenario,
    horizonDays: cell.horizonDays,
    windowStart: cell.windowStart.toISOString(),
    windowEnd: cell.windowEnd.toISOString(),
    windowLabel: formatHalfOpenPeriod(cell.windowStart, cell.windowEnd),
    openingCash: cell.openingCash,
    expectedCollections: cell.expectedCollections,
    expectedPayments: cell.expectedPayments,
    netChange: cell.netChange,
    endingCash: cell.endingCash,
    minimumCashPoint: cell.minimumCashPoint
      ? {
          dayIndex: cell.minimumCashPoint.dayIndex,
          date: cell.minimumCashPoint.date.toISOString(),
          amount: cell.minimumCashPoint.amount,
          isOpeningPoint: cell.minimumCashPoint.isOpeningPoint,
        }
      : null,
    breakDayIndex: cell.breakDayIndex,
    breakDate: cell.breakDate ? cell.breakDate.toISOString() : null,
    willBreak: cell.willBreak,
    alreadyNegativeAtOpening: cell.alreadyNegativeAtOpening,
    overdueReceivableIncluded: cell.overdueReceivableIncluded,
    overduePayableIncluded: cell.overduePayableIncluded,
    assumptions: cell.assumptions.map((id) => ({ id, label: CASH_SCENARIO_ASSUMPTION_LABELS[id] })),
    aiComment,
  };
}

function toDriverDto(driver: CashScenarioDriver, aiComment: string | null): CashScenarioDriverDto {
  return {
    id: driver.id,
    type: driver.type,
    severity: driver.severity,
    scenario: driver.scenario,
    horizonDays: driver.horizonDays,
    title: driver.title,
    evidence: driver.evidence,
    aiComment,
  };
}

/** BAZ/30 hücresi — deterministik yedek metinlerin çapası. */
function anchorCell(cells: CashScenarioCell[]): CashScenarioCell | undefined {
  return cells.find((c) => c.scenario === "BASE" && c.horizonDays === 30);
}

function fallbackHeadline(facts: ScenarioFacts): string {
  if (facts.isEmptyForecast) {
    return "Vade tarihli açık kayıt bulunmadığı için nakit projeksiyonu üretilemedi.";
  }
  const earliestBreak = facts.cells
    .filter((c) => c.breakDate !== null)
    .sort((a, b) => (a.breakDate!.getTime() - b.breakDate!.getTime()))[0];
  if (earliestBreak) {
    return `${CASH_SCENARIO_LABELS[earliestBreak.scenario]} altında nakit ${formatDate(earliestBreak.breakDate!)} tarihinde kritik seviyeye iniyor.`;
  }
  const base = anchorCell(facts.cells);
  if (base && base.endingCash !== null) {
    return `30 günlük baz senaryoda tahmini kapanış nakdi ${formatMoney(base.endingCash)}.`;
  }
  return "Önümüzdeki 90 gün için tahsilat ve ödeme projeksiyonu hazırlandı.";
}

function fallbackOverview(facts: ScenarioFacts): string {
  if (facts.isEmptyForecast) {
    return "Vade tarihi girilmiş, kalanı olan açık bir alacak veya borç kaydı bulunmadığı için senaryo tabloları boştur. Vade tarihi girilen kayıtlar eklendikçe tahmin otomatik olarak oluşur.";
  }
  const sentences: string[] = [];
  for (const horizonDays of CASH_SCENARIO_HORIZON_DAYS) {
    const base = facts.cells.find((c) => c.scenario === "BASE" && c.horizonDays === horizonDays);
    if (!base) continue;
    sentences.push(
      base.endingCash !== null
        ? `${horizonDays} günde baz senaryo kapanışı ${formatMoney(base.endingCash)}.`
        : `${horizonDays} günde beklenen tahsilat ${formatMoney(base.expectedCollections)}, beklenen ödeme ${formatMoney(base.expectedPayments)}.`,
    );
  }
  sentences.push(
    "Risk senaryosu tahsilatların 30 gün geciktiğini, iyimser senaryo ödemelerin 15 gün ötelendiğini varsayar; hiçbir senaryoda yeni gelir eklenmez.",
  );
  return sentences.join(" ");
}

function fallbackActions(drivers: CashScenarioDriver[]): string[] {
  const actions: string[] = [];
  for (const driver of drivers) {
    if (actions.includes(driver.defaultAction)) continue;
    actions.push(driver.defaultAction);
    if (actions.length === MAX_ACTIONS) break;
  }
  return actions;
}

/**
 * Modelin nesrini deterministik olgulara BAĞLAR.
 *
 * Model yalnızca bir ANAHTAR (`scenarioKey`/`driverId`) ve bir YORUM üretir.
 * Anahtar sunucunun kendi haritasında yoksa UYDURULMUŞ demektir ve sessizce
 * DÜŞÜRÜLÜR — nihai çıktıya giren tüm sayısal/tarihsel değerler her durumda
 * deterministik motordan kopyalanır.
 */
function mergeScenarioNarrative(params: {
  facts: ScenarioFacts;
  model: CashFlowScenarioModelResponse | null;
}): { cells: CashScenarioCellDto[]; drivers: CashScenarioDriverDto[] } {
  const { facts, model } = params;

  // Model sözleşmesinde yorum SENARYO düzeyindedir (`scenarioKey` bir ufuk
  // boyutu taşımaz), bu yüzden o senaryonun üç ufkuna da iliştirilir.
  // Yalnızca tek bir ufka bağlamak keyfî olurdu ve kullanıcı 60/90 gün
  // görünümüne geçtiğinde yorum sessizce kaybolurdu.
  // Bilinmeyen anahtar zaten Zod enum'u tarafından reddedilir; yinelenen
  // anahtar ilk yorumla sabitlenir.
  const commentByScenario = new Map<string, string>();
  for (const item of model?.scenarioObservations ?? []) {
    if (commentByScenario.has(item.scenarioKey)) continue;
    commentByScenario.set(item.scenarioKey, item.comment);
  }

  const driverById = new Map(facts.drivers.map((d) => [d.id, d]));
  const commentByDriver = new Map<string, string>();
  for (const item of model?.riskDriverReferences ?? []) {
    // Bilinmeyen driverId = uydurulmuş risk; sessizce düşürülür.
    if (!driverById.has(item.driverId)) continue;
    if (commentByDriver.has(item.driverId)) continue;
    commentByDriver.set(item.driverId, item.comment);
  }

  const cells = facts.cells.map((cell) => toCellDto(cell, commentByScenario.get(cell.scenario) ?? null));
  const drivers = facts.drivers.map((driver) => toDriverDto(driver, commentByDriver.get(driver.id) ?? null));
  return { cells, drivers };
}

function toResult(params: {
  facts: ScenarioFacts;
  generatedAt: string;
  model: CashFlowScenarioModelResponse | null;
}): CashFlowScenarioResult {
  const { facts, generatedAt, model } = params;
  const { cells, drivers } = mergeScenarioNarrative({ facts, model });

  const recommendedActions = (
    model?.recommendedActions && model.recommendedActions.length > 0
      ? model.recommendedActions
      : fallbackActions(facts.drivers)
  ).slice(0, MAX_ACTIONS);

  return cashFlowScenarioSchema.parse({
    actorScope: facts.actorScope,
    projectId: facts.projectId,
    projectName: facts.projectName,
    cashVisibility: facts.cashVisibility,
    cashUnavailableReason: facts.cashUnavailableReason,
    generatedAt,
    cells,
    drivers,
    headline: model?.headline ?? fallbackHeadline(facts),
    overview: model?.overview ?? fallbackOverview(facts),
    recommendedActions,
    dataCoverage: facts.coverageGaps,
    isEmptyForecast: facts.isEmptyForecast,
    driverCount: facts.drivers.length,
    isAiGenerated: model !== null,
  });
}

async function buildScenarioFacts(params: {
  actor: SessionUser;
  actorScope: ActorReportScope;
  now: Date;
  thresholds: InsightThresholds;
}): Promise<ScenarioFacts> {
  const { actor, actorScope, now, thresholds } = params;
  const todayStart = startOfIstanbulDay(now);
  const maxCutoff = addIstanbulDays(todayStart, CASH_SCENARIO_MAX_HORIZON_DAYS);

  const projectId = actorScope.projectFilter?.id ?? null;
  const projectName = actorScope.projectFilter?.name ?? null;

  // Nakit çapalı alanlar YALNIZCA organizasyon geneli ve proje filtresi YOKKEN
  // üretilir. Kasa/banka bakiyesi organizasyon geneli bir ölçüdür: proje
  // filtreli akışlarla birleştirilirse anlamsız bir "bu projenin kapanış
  // nakdi" sayısı üretir. Aynı kural YF-704'te de uygulanır.
  const cashVisibility = actorScope.scope === "ORGANIZATION" && actorScope.projectFilter === null;
  const cashUnavailableReason = cashVisibility
    ? null
    : actorScope.scope === "PROJECT_MANAGER"
      ? ("PROJECT_MANAGER_NO_CASH_VISIBILITY" as const)
      : ("PROJECT_FILTER_SCOPED" as const);

  const coverageGaps: { section: string; reason: string }[] = [];

  // Fail-closed: atanmış projesi olmayan PROJECT_MANAGER için organizasyon
  // geneline DÜŞÜLMEZ; hiçbir finansal sorgu çalıştırılmadan boş sonuç döner.
  if (actorScope.scope === "PROJECT_MANAGER" && actorScope.assignedProjectIds.length === 0) {
    coverageGaps.push({
      section: "Proje ataması",
      reason: "Henüz bir projeye atanmadığınız için nakit akışı senaryosu üretilemedi.",
    });
    return {
      actorScope: actorScope.scope,
      projectId,
      projectName,
      cashVisibility: false,
      cashUnavailableReason,
      cells: computeCashScenarioCells({ rows: [], todayStart, openingCash: null, assumptions: [] }),
      drivers: [],
      assumptionIds: [],
      coverageGaps,
      isEmptyForecast: true,
      todayStart,
    };
  }

  const moneyScope = actorScope.moneyScope;

  const [dated, undated, openingCash, accountBreakdown] = await Promise.all([
    fetchDatedRows({ organizationId: actor.organizationId, projectIds: moneyScope, maxCutoff }),
    fetchUndatedCoverage({ organizationId: actor.organizationId, projectIds: moneyScope }),
    cashVisibility ? getOrganizationCashBalance(db, actor.organizationId) : Promise.resolve(null),
    // Açılış nakdine giren aktif hesapların tür ve para birimi dağılımı —
    // TEK `groupBy`, hesap başına sorgu yok.
    cashVisibility
      ? db.financialAccount.groupBy({
          by: ["type", "currency"],
          where: { organizationId: actor.organizationId, isActive: true },
          _count: { _all: true },
        })
      : Promise.resolve([] as { type: string; currency: string }[]),
  ]);

  const creditCardCount = accountBreakdown.filter((a) => a.type === "CREDIT_CARD").length;
  const accountCurrencies = new Set(accountBreakdown.map((a) => a.currency));

  const assumptionIds: CashScenarioAssumptionId[] = [
    "CASH_BASIS_DUE_DATE",
    "NO_NEW_BUSINESS",
    "TRANSFERS_EXCLUDED",
    "PROGRESS_PAYMENTS_UNAPPROVED_EXCLUDED",
  ];
  if (cashVisibility) assumptionIds.push("OPENING_CASH_ALL_ACTIVE_ACCOUNTS");
  else assumptionIds.push("NO_CASH_VISIBILITY");
  if (creditCardCount > 0) assumptionIds.push("CREDIT_CARD_IN_OPENING_CASH");
  if (dated.rows.length === 0) assumptionIds.push("NO_DATED_RECORDS");
  if (dated.truncated) assumptionIds.push("ROWS_TRUNCATED");

  const undatedTotal = undated.receivable.plus(undated.payable);
  if (undatedTotal.greaterThan(ZERO)) {
    assumptionIds.push("NULL_DUE_DATE_EXCLUDED");
    coverageGaps.push({
      section: "Vadesi girilmemiş kayıtlar",
      reason: `Vade tarihi girilmemiş ${undated.count} kayıt (${formatMoney(undatedTotal.toString())}) zaman çizelgesine yerleştirilemediği için nakit tahminine dahil edilmemiştir.`,
    });
  }

  // Para birimi karışımı İKİ kaynaktan gelebilir ve İKİSİ de kontrol edilir:
  // (a) vadeli işlem satırları, (b) açılış nakdini besleyen aktif hesaplar.
  // Yalnızca (a) kontrol edilseydi, tüm faturaları TRY olan ama TRY + USD
  // hesabı bulunan bir organizasyonda açılış nakdi sessizce iki para birimini
  // toplar ve kırılma tarihi bu karışık tabana göre hesaplanırdı.
  const distinctCurrencies = new Set([
    ...dated.rows.map((r) => r.currency),
    ...accountCurrencies,
  ]);
  if (distinctCurrencies.size > 1) {
    assumptionIds.push("MULTI_CURRENCY_NOT_CONVERTED");
    coverageGaps.push({
      section: "Para birimi",
      reason: `Farklı para birimlerindeki tutarlar (${[...distinctCurrencies].sort().join(", ")}) kur çevrimi yapılmadan toplanmıştır.`,
    });
  }

  if (dated.truncated) {
    coverageGaps.push({
      section: "Kayıt sayısı",
      reason: `Kayıt sayısı üst sınırı (${CASH_SCENARIO_ROW_CAP}) aşıldığı için tahmin eksiktir.`,
    });
  }

  if (!cashVisibility) {
    coverageGaps.push({
      section: "Nakit pozisyonu",
      reason:
        cashUnavailableReason === "PROJECT_MANAGER_NO_CASH_VISIBILITY"
          ? "Kasa ve banka bakiyeleri proje yöneticisi rolünde görüntülenemez; yalnızca tahsilat/ödeme akışları gösterilir."
          : "Nakit bakiyesi organizasyon geneli bir ölçüdür; proje filtresi seçiliyken kapanış nakdi ve kırılma tarihi hesaplanmaz.",
    });
  }

  // Bütçe aşımı ve marj bozulması bu tahminde SESSİZCE atlanmaz — YF-702'de
  // zaten mevcutturlar ve tahakkuk bazlı oldukları için nakit ufkuna doğrudan
  // çevrilemezler.
  coverageGaps.push({
    section: "Bütçe ve kârlılık sinyalleri",
    reason:
      "Bütçe aşımı ve proje marjı bozulması tahakkuk bazlı ölçülerdir; nakit senaryosuna dahil edilmez, AI İçgörüleri ekranında ayrıca izlenir.",
  });

  const cells = computeCashScenarioCells({
    rows: dated.rows,
    todayStart,
    openingCash,
    assumptions: assumptionIds,
  });

  const allDrivers = cells.flatMap((cell) =>
    buildCashScenarioDrivers({ cell, rows: dated.rows, thresholds, formatDate }),
  );
  const drivers = rankCashScenarioDrivers(allDrivers, MAX_DRIVERS);

  return {
    actorScope: actorScope.scope,
    projectId,
    projectName,
    cashVisibility,
    cashUnavailableReason,
    cells,
    drivers,
    assumptionIds,
    coverageGaps,
    isEmptyForecast: dated.rows.length === 0,
    todayStart,
  };
}

async function runCashFlowScenarios(
  actor: SessionUser,
  options: GetCashFlowScenariosOptions,
  actorScope: ActorReportScope,
): Promise<CashFlowScenarioResult> {
  const thresholds = options.thresholds ?? DEFAULT_INSIGHT_THRESHOLDS;
  const now = options.now ?? new Date();

  const facts = await buildScenarioFacts({ actor, actorScope, now, thresholds });
  const generatedAt = new Date().toISOString();

  if (facts.isEmptyForecast) {
    // Anlamlı senaryo verisi yoksa sağlayıcı HİÇ çağrılmaz ve kota TÜKETİLMEZ.
    return toResult({ facts, generatedAt, model: null });
  }

  const correlationId = createAiCorrelationId();
  const idempotencyKey = options.idempotencyKey ?? correlationId;
  const messages = cashFlowScenarioPromptTemplate.render({
    organizationName: actor.organizationName,
    scopeLabel: facts.projectName
      ? `yalnızca "${facts.projectName}" projesi`
      : facts.actorScope === "PROJECT_MANAGER"
        ? "yalnızca size atanmış projeler"
        : "organizasyon geneli",
    cashVisibility: facts.cashVisibility,
    cells: facts.cells.map((c) => ({
      scenario: c.scenario,
      horizonDays: c.horizonDays,
      facts: cellFactSentence(c),
    })),
    drivers: facts.drivers.slice(0, MAX_DRIVERS_IN_PROMPT).map((d) => ({
      id: d.id,
      severity: d.severity,
      title: d.title,
      facts: d.facts,
    })),
    assumptions: facts.assumptionIds.map((id) => CASH_SCENARIO_ASSUMPTION_LABELS[id]),
    coverageGaps: facts.coverageGaps.map((g) => `${g.section}: ${g.reason}`),
  });

  const outcome = await requestAiCompletion(actor, {
    provider: options.provider,
    idempotencyKey,
    messages,
    promptVersion: cashFlowScenarioPromptTemplate.version,
    model: options.model,
    maxOutputTokens: SCENARIO_MAX_OUTPUT_TOKENS,
    temperature: 0.2,
    correlationId,
  });

  if (outcome.status === "already_processed") {
    // YF-711 defteri ham AI çıktısını saklamaz; deterministik olgular yine de
    // anlamlıdır ve AI metni olmadan döndürülür.
    return toResult({ facts, generatedAt, model: null });
  }

  const parsed = parseStructuredOutput(cashFlowScenarioModelResponseSchema, outcome.result.text);
  return toResult({ facts, generatedAt, model: parsed.success ? parsed.data : null });
}

/**
 * YF-705 — Ana giriş noktası: yetki → deterministik senaryo motoru → risk
 * sürücüleri → (gerekiyorsa) AI metinleştirme → doğrulanmış çıktı.
 */
export async function getCashFlowScenarios(
  actor: SessionUser,
  options: GetCashFlowScenariosOptions,
): Promise<CashFlowScenarioResult> {
  await assertCashFlowScenarioEntitlement(actor);
  const actorScope = await resolveActorReportScope(actor, options.projectId);
  return runCashFlowScenarios(actor, options, actorScope);
}

/**
 * Kapsamı ÖNCEDEN çözülmüş çağrılar için giriş noktası (YF-702-F8 deseni).
 * Taşınan kapsam, gövdeye girmeden ÖNCE kanonik çözümleyiciden geldiği ve bu
 * aktöre/bu filtreye ait olduğu kanıtlanır — "zaten güvenli bir yerden
 * çağrılıyor" istisnası TANINMAZ.
 */
export async function getCashFlowScenariosWithScope(
  actor: SessionUser,
  options: GetCashFlowScenariosOptions,
  actorScope: ActorReportScope,
): Promise<CashFlowScenarioResult> {
  assertResolvedScopeForActor(actor, actorScope, options.projectId);
  await assertCashFlowScenarioEntitlement(actor);
  return runCashFlowScenarios(actor, options, actorScope);
}
