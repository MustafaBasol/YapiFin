import type { Prisma } from "@prisma/client";
import type { SessionUser } from "@/lib/auth/session";
import { db } from "@/lib/db";
import { formatHalfOpenPeriod } from "@/lib/utils";
import { checkCapability } from "@/lib/entitlements/entitlement-service";
import { budgetFilterSchema, cashFlowFilterSchema } from "@/lib/validation/reports";
import { getBudgetReportWithScope, type BudgetReport } from "@/server/services/budget-report-service";
import { getCashFlowReportWithScope, type CashFlowReport } from "@/server/services/cash-flow-report-service";
import {
  getProjectMarginComparisonForRangesWithScope,
  type ProjectMarginRangeComparison,
} from "@/server/services/project-margin-service";
import { computeProfitMarginPercent } from "@/server/services/project-finance-service";
import {
  getSettlementTotalsForRange,
  getWeeklySummaryRanges,
  resolveActorReportScope,
  type ActorReportScope,
  type DateRange,
} from "@/server/services/dashboard-service";
import { toDecimal, ZERO } from "@/server/services/ledger";
import { runInsightRules, type FinancialSignal } from "@/server/services/ai-insights-rules";
import { DEFAULT_INSIGHT_ACTIONS } from "@/server/services/ai-insights-service";
import { AiEntitlementError, requestAiCompletion } from "@/server/services/ai-usage-reporting-service";
import { DEFAULT_INSIGHT_THRESHOLDS, type InsightThresholds } from "@/lib/ai/insights/thresholds";
import type { AiProvider } from "@/lib/ai";
import { createAiCorrelationId, parseStructuredOutput } from "@/lib/ai";
import { managementSummaryPromptTemplate } from "@/lib/ai/management-summary/prompt";
import {
  managementSummaryModelResponseSchema,
  managementSummarySchema,
  type FavorableDirection,
  type ManagementSummary,
  type ManagementSummaryChange,
  type ManagementSummaryCoverageGap,
  type ManagementSummaryMetric,
  type ManagementSummaryMetricKey,
  type ManagementSummaryRisk,
} from "@/lib/ai/management-summary/schema";

/**
 * YF-704 — Haftalık AI Yönetim Özeti (organizasyon ve proje düzeyi).
 *
 * ## Katmanlar (YF-702 ile AYNI mimari)
 *
 * 1. **Deterministik olgu paketi** — bu modül YALNIZCA kanonik rapor
 *    servislerini çağırır: `getBudgetReportWithScope`,
 *    `getCashFlowReportWithScope`, `getSettlementTotalsForRange`,
 *    `getProjectMarginComparisonForRangesWithScope`. Burada TEK BİR Prisma
 *    sorgusu, TEK BİR ham SQL ve TEK BİR yeniden hesaplanmış finansal formül
 *    YOKTUR. Kâr marjı kanonik `computeProfitMarginPercent` ile hesaplanır;
 *    toplamlar yalnızca kanonik çıktıların Decimal toplamıdır.
 * 2. **Deterministik risk sinyalleri** — kanonik kural motoru
 *    (`runInsightRules`), YF-702 ile aynı kurallar ve aynı eşiklerle.
 * 3. **AI metinleştirme** — model yalnızca nesir üretir ve önceden verilmiş
 *    `metricKey`/`signalId` anahtarlarına atıfta bulunur.
 * 4. **Yetki/kota** — `ai.features` yeteneği + YF-711 kota motoru.
 *
 * ## AI'nin DEĞİŞTİREMEYECEĞİ şeyler
 *
 * Modelin yanıt şemasında tek bir sayısal alan yoktur (bkz.
 * lib/ai/management-summary/schema.ts). Nihai çıktıdaki her tutar, oran,
 * dönem, proje kimliği/adı ve önem derecesi olgu paketinden KOPYALANIR.
 * Model tanımadığımız bir `metricKey`/`signalId` döndürürse o madde sessizce
 * DÜŞÜRÜLÜR — uydurulmuş bir ölçü veya risk nihai çıktıya giremez.
 *
 * ## Dönem
 *
 * Dönem `getWeeklySummaryRanges` ile üretilir: TAMAMLANMIŞ son hafta ve ondan
 * hemen önceki hafta. İki dönem de 7 tam gündür, ÖRTÜŞMEZ
 * (`previous.end === current.start`) ve YARI AÇIKtır. Kullanıcıya gösterilen
 * etiket `formatHalfOpenPeriod` ile üretilir (son gün DAHİL görünür).
 *
 * ## Kapsam ve yetki
 *
 * Kapsam istek başına TEK kez `resolveActorReportScope` ile çözülür ve tüm
 * kanonik servislere taşınır (YF-702-F8 örüntüsü). PROJECT_MANAGER yalnızca
 * atanmış projelerini görür; ataması yoksa kanonik servisler fail-closed
 * davranır ve hiçbir finansal sorgu çalışmadan boş/nötr özet üretilir.
 * Yetkisiz/başka tenant'a ait bir `projectId` HATA DEĞİLDİR: kanonik
 * sözleşme gereği filtre düşer ve aktör KENDİ kapsamında kalır (bkz.
 * `resolveActorReportScope` doküman notu) — özet o durumda organizasyon
 * kapsamında üretilir, istenen projenin verisi ASLA sızmaz.
 */

/** Modelin en fazla kaç madde öne çıkarabileceği (nihai çıktıdaki üst sınır). */
const MAX_HIGHLIGHTS = 3;

/** Tutucu bir üst sınır — ~3 madde + genel bakış metni varsayımıyla (bkz. lib/ai/credits.ts). */
const SUMMARY_MAX_OUTPUT_TOKENS = 1200;

/**
 * Modele iletilen en fazla sinyal sayısı. Kural motoru kendi
 * `thresholds.maxSignals` sınırını uygular; özet zaten en fazla üç riski
 * gösterdiğinden modele daha fazlasını göndermek kota harcar.
 */
const MAX_SIGNALS_IN_PROMPT = 8;

/** Ölçü etiketleri ve "hangi yön iyi" tanımları — tek kaynak. */
const METRIC_META: Record<ManagementSummaryMetricKey, { label: string; favorable: FavorableDirection }> = {
  cashOpeningBalance: { label: "Nakit mevcut bakiye", favorable: "UP" },
  // Kanonik nakit akışı raporunun varsayılan penceresi İLERİ dönük 30 gündür
  // (bkz. lib/validation/reports.ts `cashFlowFilterSchema` — `NEXT_30_DAYS`).
  // Etiket bu ufku AÇIKÇA söyler: haftalık bir kartın içinde ufuksuz bir
  // "projeksiyon kapanışı" okuyucuya haftalık bir değermiş gibi görünürdü.
  cashProjectedClosingBalance: { label: "Projeksiyon kapanış bakiyesi (30 gün)", favorable: "UP" },
  collections: { label: "Gerçekleşen tahsilat", favorable: "UP" },
  payments: { label: "Gerçekleşen ödeme", favorable: "NONE" },
  netSettlement: { label: "Net nakit akışı", favorable: "UP" },
  revenue: { label: "Kaydedilen gelir", favorable: "UP" },
  expense: { label: "Kaydedilen gider", favorable: "NONE" },
  profit: { label: "Dönem kârı", favorable: "UP" },
  margin: { label: "Kâr marjı", favorable: "UP" },
  budgetTotal: { label: "Toplam proje bütçesi", favorable: "NONE" },
  budgetRealizedExpenses: { label: "Bütçeye karşı gerçekleşen gider", favorable: "NONE" },
  budgetRemaining: { label: "Kalan bütçe", favorable: "UP" },
  budgetUsagePercentage: { label: "Bütçe kullanım oranı", favorable: "DOWN" },
  overdueReceivable: { label: "Vadesi geçmiş alacak", favorable: "DOWN" },
  overduePayable: { label: "Vadesi geçmiş borç", favorable: "DOWN" },
};

/**
 * `ai.features` şemsiye yetkisini, AĞIR rapor sorgularından ÖNCE fail-closed
 * doğrular.
 *
 * `requestAiCompletion` bu yeteneği zaten iki katmanlı olarak kontrol eder;
 * buradaki ön kapı onun YERİNE geçmez, ona EKtir ve YF-702 ile aynı iki
 * gerekçeye sahiptir: (1) yetkisiz bir organizasyon için bütçe + nakit akışı
 * + marj sorguları hiç çalıştırılmaz, (2) "plana dahil değil" ile "bu hafta
 * veri yok" durumları kullanıcıya karışmaz.
 *
 * Neden `ai.management_summary` DEĞİL: bu kimlik `docs/PLAN_FEATURE_MATRIX.md`
 * §2.3'te tanımlıdır ancak `lib/entitlements/capabilities.ts` içindeki
 * `CAPABILITY_IDS` listesinde YOKTUR; eklenmesi dört kanonik `Plan` satırını
 * güncelleyen bir migration gerektirir (`resolveCapabilityValue` fail-closed
 * `=== true` karşılaştırması yapar), yani plan matrisinin değiştirilmesi
 * demektir — bu görevin kapsamı dışında. Plan matrisinde
 * `ai.management_summary` ile `ai.features` TÜM planlarda aynı değere
 * sahiptir (Starter hariç dahil), bu nedenle şemsiye kapı bugün BİREBİR aynı
 * erişimi verir; hiçbir organizasyonun erişimi genişlemez. Aynı yaklaşım Ask
 * YapiFin'de de kullanılmıştır (bkz. server/services/ask-yapifin-service.ts —
 * `featureCapability` geçmez).
 */
const AI_FEATURES_CAPABILITY = "ai.features" as const;

async function assertManagementSummaryEntitlement(actor: SessionUser): Promise<void> {
  const capability = await checkCapability(db, actor.organizationId, AI_FEATURES_CAPABILITY);
  if (!capability.allowed) {
    throw new AiEntitlementError(
      "AI yönetim özeti mevcut planınıza dahil değil. Devam etmek için planınızı yükseltmeniz gerekir.",
      "FORBIDDEN",
      "AI_PLAN_REQUIRED",
    );
  }
}

interface PeriodMoney {
  current: Prisma.Decimal;
  previous: Prisma.Decimal;
}

/** Dönemsel bir parasal ölçüyü, işaretli değişimiyle birlikte kurar. */
function periodMetric(key: ManagementSummaryMetricKey, totals: PeriodMoney): ManagementSummaryMetric {
  const change = totals.current.minus(totals.previous);
  return {
    key,
    label: METRIC_META[key].label,
    value: totals.current.toString(),
    kind: "MONEY",
    previousValue: totals.previous.toString(),
    change: change.toString(),
    changeKind: "MONEY",
    direction: change.isZero() ? "FLAT" : change.isPositive() ? "UP" : "DOWN",
    favorableDirection: METRIC_META[key].favorable,
  };
}

/** Anlık (dönemsel olmayan) bir ölçü — karşılaştırma alanları UYDURULMAZ, `null` kalır. */
function pointInTimeMetric(
  key: ManagementSummaryMetricKey,
  value: string,
  kind: ManagementSummaryMetric["kind"] = "MONEY",
): ManagementSummaryMetric {
  return {
    key,
    label: METRIC_META[key].label,
    value,
    kind,
    previousValue: null,
    change: null,
    changeKind: null,
    direction: null,
    favorableDirection: METRIC_META[key].favorable,
  };
}

/**
 * Kâr marjı ölçüsü. Marj kendisi bir YÜZDE olduğundan iki dönem arasındaki
 * fark YÜZDE PUANdır (bkz. YF-702-F3). Gelir sıfır/negatifse marj TANIMSIZDIR
 * (`computeProfitMarginPercent` `null` döner) — `%0` UYDURULMAZ, ölçü hiç
 * eklenmez.
 */
function marginMetric(currentMargin: string | null, previousMargin: string | null): ManagementSummaryMetric | null {
  if (currentMargin === null) return null;
  const previousAvailable = previousMargin !== null;
  const change = previousAvailable ? toDecimal(currentMargin).minus(toDecimal(previousMargin)) : null;
  return {
    key: "margin",
    label: METRIC_META.margin.label,
    value: currentMargin,
    kind: "PERCENT",
    previousValue: previousMargin,
    change: change ? change.toString() : null,
    changeKind: change ? "PERCENTAGE_POINT" : null,
    direction: change ? (change.isZero() ? "FLAT" : change.isPositive() ? "UP" : "DOWN") : null,
    favorableDirection: METRIC_META.margin.favorable,
  };
}

/**
 * Kapsamdaki projelerin dönemsel gelir/gider toplamlarını kanonik marj
 * karşılaştırmasından toplar.
 *
 * Bu bir YENİDEN HESAPLAMA değildir: satır değerleri kanonik servisin
 * ürettiği dönem toplamlarıdır, burada yalnızca Decimal olarak toplanır ve
 * marj tek kanonik formülle (`computeProfitMarginPercent`) türetilir.
 */
function rollUpMargin(comparison: ProjectMarginRangeComparison) {
  const acc = {
    currentRevenue: ZERO,
    currentExpense: ZERO,
    previousRevenue: ZERO,
    previousExpense: ZERO,
  };
  for (const row of comparison.rows) {
    acc.currentRevenue = acc.currentRevenue.plus(toDecimal(row.current.revenue));
    acc.currentExpense = acc.currentExpense.plus(toDecimal(row.current.expense));
    acc.previousRevenue = acc.previousRevenue.plus(toDecimal(row.prior.revenue));
    acc.previousExpense = acc.previousExpense.plus(toDecimal(row.prior.expense));
  }
  const currentProfit = acc.currentRevenue.minus(acc.currentExpense);
  const previousProfit = acc.previousRevenue.minus(acc.previousExpense);
  return {
    revenue: { current: acc.currentRevenue, previous: acc.previousRevenue },
    expense: { current: acc.currentExpense, previous: acc.previousExpense },
    profit: { current: currentProfit, previous: previousProfit },
    currentMargin: computeProfitMarginPercent(currentProfit, acc.currentRevenue),
    previousMargin: computeProfitMarginPercent(previousProfit, acc.previousRevenue),
  };
}

/**
 * Bir ölçüyü modele iletilecek Türkçe olgu cümlesine çevirir. Biçim, kural
 * motorunun `facts` cümleleriyle AYNIdır: ham Decimal string + birim (bkz.
 * server/services/ai-insights-rules.ts) — sunum biçimlendirmesi (₺, tr-TR
 * ayraçları) yalnızca arayüzün işidir.
 */
function metricFactSentence(metric: ManagementSummaryMetric, periodLabel: string, previousPeriodLabel: string): string {
  const unit = metric.kind === "MONEY" ? " TL" : metric.kind === "PERCENT" ? "%" : "";
  const value = metric.kind === "PERCENT" ? `%${metric.value}` : `${metric.value}${unit}`;
  if (metric.previousValue === null || metric.change === null) {
    return `${metric.label}: ${value} (${periodLabel} itibarıyla).`;
  }
  const previous = metric.kind === "PERCENT" ? `%${metric.previousValue}` : `${metric.previousValue}${unit}`;
  const changeUnit = metric.changeKind === "PERCENTAGE_POINT" ? " puan" : metric.kind === "MONEY" ? " TL" : "";
  const changeText = `${metric.change}${changeUnit}`;
  return `${metric.label}: ${periodLabel} döneminde ${value}, önceki dönemde (${previousPeriodLabel}) ${previous}; değişim ${changeText}.`;
}

export interface ManagementSummaryFacts {
  scope: ManagementSummary["scope"];
  actorScope: ManagementSummary["actorScope"];
  projectId: string | null;
  projectName: string | null;
  period: DateRange;
  previousPeriod: DateRange;
  periodLabel: string;
  previousPeriodLabel: string;
  metrics: ManagementSummaryMetric[];
  signals: FinancialSignal[];
  coverageGaps: ManagementSummaryCoverageGap[];
  /** Dönem boyunca hiçbir hareket yok VE hiç sinyal yoksa `true` — sağlayıcı çağrılmaz. */
  isEmptyPeriod: boolean;
}

interface BuildFactsInput {
  actorScope: ActorReportScope;
  budget: BudgetReport;
  cashFlow: CashFlowReport;
  margin: ProjectMarginRangeComparison;
  currentSettlement: { collected: Prisma.Decimal; paid: Prisma.Decimal; net: Prisma.Decimal };
  previousSettlement: { collected: Prisma.Decimal; paid: Prisma.Decimal; net: Prisma.Decimal };
  signals: FinancialSignal[];
  period: DateRange;
  previousPeriod: DateRange;
}

function buildFacts(input: BuildFactsInput): ManagementSummaryFacts {
  const { actorScope, budget, cashFlow, margin, currentSettlement, previousSettlement, signals } = input;
  const periodLabel = formatHalfOpenPeriod(input.period.start, input.period.end);
  const previousPeriodLabel = formatHalfOpenPeriod(input.previousPeriod.start, input.previousPeriod.end);
  const projectFilter = actorScope.projectFilter;
  const scope = projectFilter ? "PROJECT" : "ORGANIZATION";

  const metrics: ManagementSummaryMetric[] = [];
  const coverageGaps: ManagementSummaryCoverageGap[] = [];

  // --- Nakit pozisyonu -----------------------------------------------------
  // Açılış/projeksiyon bakiyesi organizasyon geneli bir ölçüdür ve kanonik
  // rapor onu yalnızca ORGANIZATION kapsamında üretir (PROJECT_MANAGER için
  // nakit/banka görünürlüğü yoktur — bkz. lib/permissions.ts
  // `canViewCashAndBank`). Proje özetinde de gösterilmez: organizasyonun
  // nakdini tek bir projeye atfetmek yanıltıcı olurdu.
  if (scope === "ORGANIZATION" && cashFlow.scope === "ORGANIZATION") {
    metrics.push(pointInTimeMetric("cashOpeningBalance", cashFlow.openingBalance));
    metrics.push(pointInTimeMetric("cashProjectedClosingBalance", cashFlow.projectedClosingBalance));
  } else if (scope === "PROJECT") {
    coverageGaps.push({
      section: "Nakit pozisyonu",
      reason: "Nakit bakiyesi organizasyon geneli bir ölçüdür; proje özetinde gösterilmez.",
    });
  } else {
    coverageGaps.push({
      section: "Nakit pozisyonu",
      reason: "Nakit ve banka bakiyeleri proje yöneticisi rolünde görüntülenemez.",
    });
  }

  // --- Tahsilat / ödeme ----------------------------------------------------
  metrics.push(periodMetric("collections", { current: currentSettlement.collected, previous: previousSettlement.collected }));
  metrics.push(periodMetric("payments", { current: currentSettlement.paid, previous: previousSettlement.paid }));
  metrics.push(periodMetric("netSettlement", { current: currentSettlement.net, previous: previousSettlement.net }));

  // --- Kârlılık ------------------------------------------------------------
  const rolled = rollUpMargin(margin);
  metrics.push(periodMetric("revenue", rolled.revenue));
  metrics.push(periodMetric("expense", rolled.expense));
  metrics.push(periodMetric("profit", rolled.profit));
  const margins = marginMetric(rolled.currentMargin, rolled.previousMargin);
  if (margins) {
    metrics.push(margins);
  } else {
    coverageGaps.push({
      section: "Kâr marjı",
      reason: "Dönemde kaydedilen gelir olmadığı için kâr marjı hesaplanamaz.",
    });
  }
  if (scope === "ORGANIZATION") {
    // İki ölçü ailesi FARKLI kapsamlara sahiptir ve bu fark kullanıcıya
    // açıkça söylenmelidir: aksi hâlde "tahsilat" ile "kâr" satırlarının
    // neden birbirini tutmadığı özetten anlaşılamaz.
    coverageGaps.push({
      section: "Kârlılık kapsamı",
      reason:
        "Kârlılık ölçüleri (gelir/gider/kâr/marj) yalnızca bir projeye atanmış kayıtları içerir; projesiz gelir/gider bu ölçülere dahil DEĞİLDİR. Buna karşılık tahsilat/ödeme ölçüleri projesiz kayıtları da İÇERİR — bu yüzden iki grup birebir örtüşmez.",
    });
  }

  // --- Bütçe ---------------------------------------------------------------
  // Bütçe raporu dönemsel DEĞİLDİR (proje ömrü boyunca birikmiş durumdur),
  // bu yüzden haftalık bir değişim türetilmez — uydurulmuş bir karşılaştırma
  // yerine anlık durum olarak taşınır.
  coverageGaps.push({
    section: "Bütçe ölçüleri",
    reason:
      "Bütçe rakamları proje ömrü boyunca birikmiş ANLIK durumdur, haftalık bir değişim değildir; bu yüzden önceki dönemle karşılaştırılmaz.",
  });
  metrics.push(pointInTimeMetric("budgetTotal", budget.metrics.totalProjectBudget));
  metrics.push(pointInTimeMetric("budgetRealizedExpenses", budget.metrics.totalRealizedExpenses));
  metrics.push(pointInTimeMetric("budgetRemaining", budget.metrics.totalRemainingBudget));
  if (budget.metrics.budgetUsagePercentage !== null) {
    metrics.push(pointInTimeMetric("budgetUsagePercentage", budget.metrics.budgetUsagePercentage, "PERCENT"));
  } else {
    coverageGaps.push({
      section: "Bütçe kullanım oranı",
      reason: "Kapsamdaki projelerde tanımlı bütçe olmadığı için kullanım oranı hesaplanamaz.",
    });
  }

  // --- Vadesi geçmiş alacak/borç ------------------------------------------
  metrics.push(pointInTimeMetric("overdueReceivable", cashFlow.receivableBuckets.overdue));
  metrics.push(pointInTimeMetric("overduePayable", cashFlow.payableBuckets.overdue));

  // Dönem "boş" sayılır: dönemsel ölçülerin hepsi iki dönemde de sıfırsa VE
  // kural motoru hiç sinyal üretmediyse. Bu durumda sağlayıcı ÇAĞRILMAZ.
  const periodMovement = metrics.some(
    (m) => m.previousValue !== null && (!toDecimal(m.value).isZero() || !toDecimal(m.previousValue).isZero()),
  );
  const isEmptyPeriod = !periodMovement && signals.length === 0;

  return {
    scope,
    actorScope: actorScope.scope,
    projectId: projectFilter?.id ?? null,
    projectName: projectFilter?.name ?? null,
    period: input.period,
    previousPeriod: input.previousPeriod,
    periodLabel,
    previousPeriodLabel,
    metrics,
    signals,
    coverageGaps,
    isEmptyPeriod,
  };
}

/** Değişim büyüklüğüne göre deterministik sıralama — AI yanıt vermediğinde/eksik seçtiğinde kullanılır. */
function rankedChangeMetrics(metrics: ManagementSummaryMetric[]): ManagementSummaryMetric[] {
  return metrics
    .filter((m) => m.change !== null && !toDecimal(m.change).isZero())
    .sort((a, b) => {
      const diff = toDecimal(b.change ?? "0").abs().comparedTo(toDecimal(a.change ?? "0").abs());
      if (diff !== 0) return diff;
      return a.key.localeCompare(b.key);
    });
}

function fallbackHeadline(facts: ManagementSummaryFacts): string {
  if (facts.isEmptyPeriod) {
    return `${facts.periodLabel} döneminde finansal hareket kaydedilmedi.`;
  }
  const net = facts.metrics.find((m) => m.key === "netSettlement");
  const direction = net && toDecimal(net.value).isNegative() ? "negatif" : "pozitif";
  return `${facts.periodLabel} haftalık özeti: net nakit akışı ${direction}.`;
}

function fallbackOverview(facts: ManagementSummaryFacts): string {
  if (facts.isEmptyPeriod) {
    return `${facts.periodLabel} döneminde tahsilat, ödeme veya kaydedilen gelir/gider hareketi bulunmadı. Karşılaştırma dönemi ${facts.previousPeriodLabel}.`;
  }
  const highlights = rankedChangeMetrics(facts.metrics)
    .slice(0, MAX_HIGHLIGHTS)
    .map((m) => metricFactSentence(m, facts.periodLabel, facts.previousPeriodLabel));
  if (highlights.length === 0) {
    return `${facts.periodLabel} döneminde önceki döneme göre kayda değer bir değişim oluşmadı.`;
  }
  return highlights.join(" ");
}

function fallbackActions(signals: FinancialSignal[]): string[] {
  const actions: string[] = [];
  for (const signal of signals) {
    const action = DEFAULT_INSIGHT_ACTIONS[signal.type];
    if (!actions.includes(action)) actions.push(action);
    if (actions.length === MAX_HIGHLIGHTS) break;
  }
  return actions;
}

/**
 * Modelin seçtiği anahtarları deterministik olgularla birleştirir.
 *
 * Model yalnızca SIRALAMA ve YORUM üretir: hangi ölçü/risk öne çıkacak ve ona
 * dair tek cümlelik yorum. Tanınmayan veya tekrar eden anahtarlar DÜŞÜRÜLÜR;
 * eksik kalan yerler deterministik sıralamayla TAMAMLANIR, böylece model
 * hiçbir şey seçmese bile özet boş kalmaz.
 */
function mergeHighlights(
  facts: ManagementSummaryFacts,
  model: { topChanges: { metricKey: string; comment: string }[]; topRisks: { signalId: string; comment: string }[] } | null,
): { topChanges: ManagementSummaryChange[]; topRisks: ManagementSummaryRisk[] } {
  const metricByKey = new Map(facts.metrics.map((m) => [m.key as string, m]));
  const signalById = new Map(facts.signals.map((s) => [s.id, s]));

  const topChanges: ManagementSummaryChange[] = [];
  const usedMetricKeys = new Set<string>();
  for (const item of model?.topChanges ?? []) {
    const metric = metricByKey.get(item.metricKey);
    // Bilinmeyen anahtar = uydurulmuş ölçü; sessizce düşürülür.
    if (!metric || usedMetricKeys.has(metric.key)) continue;
    usedMetricKeys.add(metric.key);
    topChanges.push({ metric, comment: item.comment });
    if (topChanges.length === MAX_HIGHLIGHTS) break;
  }
  for (const metric of rankedChangeMetrics(facts.metrics)) {
    if (topChanges.length === MAX_HIGHLIGHTS) break;
    if (usedMetricKeys.has(metric.key)) continue;
    usedMetricKeys.add(metric.key);
    topChanges.push({
      metric,
      comment: metricFactSentence(metric, facts.periodLabel, facts.previousPeriodLabel),
    });
  }

  const topRisks: ManagementSummaryRisk[] = [];
  const usedSignalIds = new Set<string>();
  const toRisk = (signal: FinancialSignal, comment: string): ManagementSummaryRisk => ({
    signalId: signal.id,
    type: signal.type,
    severity: signal.severity,
    affectedProjectId: signal.affectedProjectId,
    affectedProjectName: signal.affectedProjectName,
    evidence: signal.evidence,
    comment,
  });
  for (const item of model?.topRisks ?? []) {
    const signal = signalById.get(item.signalId);
    // Bilinmeyen signalId = uydurulmuş risk; sessizce düşürülür.
    if (!signal || usedSignalIds.has(signal.id)) continue;
    usedSignalIds.add(signal.id);
    topRisks.push(toRisk(signal, item.comment));
    if (topRisks.length === MAX_HIGHLIGHTS) break;
  }
  // `facts.signals` kural motoru tarafından önem derecesine göre sıralanmıştır.
  for (const signal of facts.signals) {
    if (topRisks.length === MAX_HIGHLIGHTS) break;
    if (usedSignalIds.has(signal.id)) continue;
    usedSignalIds.add(signal.id);
    topRisks.push(toRisk(signal, signal.facts));
  }

  return { topChanges, topRisks };
}

function toResult(
  facts: ManagementSummaryFacts,
  generatedAt: string,
  model: {
    headline: string;
    overview: string;
    topChanges: { metricKey: string; comment: string }[];
    topRisks: { signalId: string; comment: string }[];
    recommendedActions: string[];
  } | null,
): ManagementSummary {
  const { topChanges, topRisks } = mergeHighlights(facts, model);
  const recommendedActions = (model?.recommendedActions ?? []).slice(0, MAX_HIGHLIGHTS);
  return managementSummarySchema.parse({
    scope: facts.scope,
    actorScope: facts.actorScope,
    projectId: facts.projectId,
    projectName: facts.projectName,
    periodStart: facts.period.start.toISOString(),
    periodEnd: facts.period.end.toISOString(),
    periodLabel: facts.periodLabel,
    previousPeriodStart: facts.previousPeriod.start.toISOString(),
    previousPeriodEnd: facts.previousPeriod.end.toISOString(),
    previousPeriodLabel: facts.previousPeriodLabel,
    headline: model?.headline ?? fallbackHeadline(facts),
    overview: model?.overview ?? fallbackOverview(facts),
    metrics: facts.metrics,
    topChanges,
    topRisks,
    recommendedActions: recommendedActions.length > 0 ? recommendedActions : fallbackActions(facts.signals),
    dataCoverage: facts.coverageGaps,
    signalCount: facts.signals.length,
    isEmptyPeriod: facts.isEmptyPeriod,
    generatedAt,
    isAiGenerated: model !== null,
  });
}

export interface GetManagementSummaryOptions {
  provider: AiProvider;
  /** Proje düzeyi özet için proje kimliği. Yetkisiz/başka tenant'a aitse kapsam sessizce aktörün kendi kapsamına düşer. */
  projectId?: string;
  /** Deterministik dönem sınırı testleri için "şimdi" enjeksiyonu; üretim çağrılarında verilmez. */
  now?: Date;
  /** Belirtilmezse her çağrı için taze bir kimlik üretilir; güvenli yeniden deneme için çağıran aynı anahtarı tekrar geçebilir. */
  idempotencyKey?: string;
  model?: string;
  thresholds?: InsightThresholds;
}

/**
 * YF-704 — Ana orkestrasyon: yetki → deterministik olgu paketi → (gerekiyorsa)
 * AI metinleştirme → doğrulanmış çıktı.
 */
export async function getManagementSummary(
  actor: SessionUser,
  options: GetManagementSummaryOptions,
): Promise<ManagementSummary> {
  await assertManagementSummaryEntitlement(actor);

  const thresholds = options.thresholds ?? DEFAULT_INSIGHT_THRESHOLDS;
  const now = options.now ?? new Date();
  const { current, previous } = getWeeklySummaryRanges(now);

  // YF-702-F8 örüntüsü — kapsam istek başına TEK kez çözülür ve tüm kanonik
  // servislere taşınır; proje sayısından bağımsız, sabit sayıda sorgu.
  const actorScope = await resolveActorReportScope(actor, options.projectId);

  const [budget, cashFlow, currentSettlement, previousSettlement, margin] = await Promise.all([
    getBudgetReportWithScope(actor, budgetFilterSchema.parse({ projectId: options.projectId }), actorScope),
    getCashFlowReportWithScope(actor, cashFlowFilterSchema.parse({ projectId: options.projectId }), actorScope),
    getSettlementTotalsForRange(actor.organizationId, current, actorScope.moneyScope),
    getSettlementTotalsForRange(actor.organizationId, previous, actorScope.moneyScope),
    getProjectMarginComparisonForRangesWithScope(
      actor,
      { currentPeriod: current, priorPeriod: previous, requestedProjectId: options.projectId },
      actorScope,
    ),
  ]);

  const signals = runInsightRules({
    budget,
    cashFlow,
    settlement: {
      collected: currentSettlement.collected.toString(),
      paid: currentSettlement.paid.toString(),
      net: currentSettlement.net.toString(),
      rangeStart: current.start,
      rangeEnd: current.end,
    },
    projectMargin: margin,
    thresholds,
  });

  const facts = buildFacts({
    actorScope,
    budget,
    cashFlow,
    margin,
    currentSettlement,
    previousSettlement,
    signals,
    period: current,
    previousPeriod: previous,
  });

  const generatedAt = new Date().toISOString();

  if (facts.isEmptyPeriod) {
    // Veri yoksa sağlayıcı HİÇ çağrılmaz ve kota tüketilmez — "veri yetersizse
    // yorum/uyarı uydurma" kuralının doğrudan sonucu (YF-702 ile aynı).
    return toResult(facts, generatedAt, null);
  }

  const correlationId = createAiCorrelationId();
  const idempotencyKey = options.idempotencyKey ?? correlationId;
  const messages = managementSummaryPromptTemplate.render({
    organizationName: actor.organizationName,
    scopeLabel: facts.projectName
      ? `yalnızca "${facts.projectName}" projesi`
      : facts.actorScope === "PROJECT_MANAGER"
        ? "yalnızca size atanmış projeler"
        : "organizasyon geneli",
    periodLabel: facts.periodLabel,
    previousPeriodLabel: facts.previousPeriodLabel,
    metrics: facts.metrics.map((m) => ({
      key: m.key,
      facts: metricFactSentence(m, facts.periodLabel, facts.previousPeriodLabel),
    })),
    signals: facts.signals.slice(0, MAX_SIGNALS_IN_PROMPT).map((s) => ({
      id: s.id,
      type: s.type,
      severity: s.severity,
      affectedProjectName: s.affectedProjectName,
      facts: s.facts,
    })),
    coverageGaps: facts.coverageGaps.map((g) => `${g.section}: ${g.reason}`),
  });

  const outcome = await requestAiCompletion(actor, {
    provider: options.provider,
    idempotencyKey,
    messages,
    promptVersion: managementSummaryPromptTemplate.version,
    model: options.model,
    maxOutputTokens: SUMMARY_MAX_OUTPUT_TOKENS,
    temperature: 0.2,
    correlationId,
  });

  if (outcome.status === "already_processed") {
    // YF-711 defteri ham AI çıktısını saklamaz; bu isteğin daha önce
    // tamamlandığı bilinir ama metin yeniden üretilemez. Deterministik olgular
    // yine de anlamlıdır — AI metni olmadan döndürülür.
    return toResult(facts, generatedAt, null);
  }

  const parsed = parseStructuredOutput(managementSummaryModelResponseSchema, outcome.result.text);
  return toResult(facts, generatedAt, parsed.success ? parsed.data : null);
}
