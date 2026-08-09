import type { SessionUser } from "@/lib/auth/session";
import { getBudgetReport } from "@/server/services/budget-report-service";
import { getCashFlowReport, type MaturityBuckets } from "@/server/services/cash-flow-report-service";
import { budgetFilterSchema, cashFlowFilterSchema } from "@/lib/validation/reports";
import { toDecimal, ZERO } from "@/server/services/ledger";
import { requestAiCompletion } from "@/server/services/ai-usage-reporting-service";
import type { AiProvider, StructuredOutputResult } from "@/lib/ai";
import { createAiCorrelationId, parseStructuredOutput } from "@/lib/ai";
import { aiInsightsPromptTemplate } from "@/lib/ai/insights/prompt";
import {
  aiInsightModelResponseSchema,
  aiInsightsResultSchema,
  type AiInsight,
  type AiInsightsResult,
  type InsightSeverity,
  type InsightType,
} from "@/lib/ai/insights/schema";

/**
 * YF-702 — Deterministik finansal sinyal çıkarımı + AI destekli
 * içgörü/erken uyarı üretimi.
 *
 * Mimari (bkz. görev talimatı "deterministic signal extraction -> structured
 * AI-safe context -> AI explanation/prioritization"):
 * 1. `extractFinancialSignals` YALNIZCA mevcut kanonik rapor servislerini
 *    (`getBudgetReport`, `getCashFlowReport` — ikisi de zaten tenant/rol
 *    kapsamlıdır, bkz. server/services/budget-report-service.ts,
 *    cash-flow-report-service.ts) çağırır. Burada TEK bir yeni Prisma sorgusu
 *    YOKTUR — yalnızca bu servislerin zaten ürettiği toplam/oran alanları
 *    eşik karşılaştırmasından geçirilir (aynı `BUDGET_CRITICAL_RATIO` deseni,
 *    bkz. budget-report-service.ts). Sonuç tamamen deterministiktir; AI bu
 *    aşamada hiç ÇAĞRILMAZ.
 * 2. `getAiInsights` sinyalleri (yalnızca id/tür/önem/proje adı/kısa Türkçe
 *    olgu cümlesi — ham satır/PII yok) `requestAiCompletion` (YF-711 kota/
 *    yetenek/idempotency katmanı) üzerinden modele iletir. Modelden İSTENEN
 *    JSON şekli (bkz. lib/ai/insights/schema.ts `aiInsightModelResponseSchema`)
 *    yalnızca metin alanları içerir — hiçbir sayısal/finansal alan modelden
 *    KABUL EDİLMEZ. Nihai `evidence`/`severity` her zaman adım 1'in
 *    deterministik çıktısından kopyalanır; model çıktısı yalnızca
 *    title/explanation/suggestedAction'a katkıda bulunur (bkz. `mergeInsight`).
 */

const MAX_SIGNALS = 15;
/** Tutucu bir üst sınır — sinyal başına ~120 token'lık bir yanıt varsayımıyla (bkz. lib/ai/credits.ts). */
const INSIGHTS_MAX_OUTPUT_TOKENS = 1600;

export interface FinancialSignal {
  id: string;
  type: InsightType;
  severity: InsightSeverity;
  affectedProjectId: string | null;
  affectedProjectName: string | null;
  /** Tamamen deterministik, Decimal/string kaynaklı kanıt alanları — AI bunları asla üretmez/değiştirmez. */
  metrics: Record<string, string>;
  /** Modelin yorumlayacağı, önceden hesaplanmış Türkçe olgu cümlesi. */
  facts: string;
}

const SEVERITY_RANK: Record<InsightSeverity, number> = { CRITICAL: 3, HIGH: 2, MEDIUM: 1, LOW: 0 };

const DEFAULT_TITLES: Record<InsightType, string> = {
  BUDGET_OVERRUN: "Bütçe aşıldı",
  BUDGET_NEAR_OVERRUN: "Bütçe sınırına yaklaşıldı",
  CASH_FLOW_PRESSURE: "Nakit akışı baskısı",
  OVERDUE_RECEIVABLES: "Vadesi geçen alacaklar",
  EXPENSE_CONCENTRATION: "Yüksek gider yoğunlaşması",
  PROJECT_DETERIORATION: "Proje finansal durumu kötüleşiyor",
};

const DEFAULT_ACTIONS: Record<InsightType, string> = {
  BUDGET_OVERRUN: "Proje bütçesini gözden geçirin ve ek maliyetlerin nedenini analiz edin.",
  BUDGET_NEAR_OVERRUN: "Kalan bütçeyi yakından izleyin, kritik olmayan harcamaları erteleyin.",
  CASH_FLOW_PRESSURE: "Tahsilatları hızlandırmayı veya planlanan ödemeleri yeniden planlamayı değerlendirin.",
  OVERDUE_RECEIVABLES: "Vadesi geçen alacaklar için tahsilat takibini önceliklendirin.",
  EXPENSE_CONCENTRATION: "Bu kategorideki harcamaları detaylı inceleyin, tedarikçi/fiyat alternatiflerini değerlendirin.",
  PROJECT_DETERIORATION: "Bu projenin bütçe ve tahsilat durumunu birlikte gözden geçirin, gerekirse yönetime raporlayın.",
};

function sumMaturityBuckets(buckets: MaturityBuckets) {
  return (
    [
      buckets.overdue,
      buckets.dueToday,
      buckets.next7Days,
      buckets.next30Days,
      buckets.days31to60,
      buckets.days61to90,
      buckets.over90Days,
      buckets.noDueDate,
    ] as const
  ).reduce((sum, v) => sum.plus(toDecimal(v)), ZERO);
}

/**
 * Yalnızca mevcut kanonik rapor servislerinin çıktısından, ek Prisma sorgusu
 * ÜRETMEDEN, eşik karşılaştırmasıyla aday sinyal listesi çıkarır. Rol/tenant
 * kapsaması tamamen `getBudgetReport`/`getCashFlowReport`'a devredilir —
 * burada tekrarlanmaz (bkz. modül başlığı).
 */
export async function extractFinancialSignals(actor: SessionUser): Promise<FinancialSignal[]> {
  const [budget, cashFlow] = await Promise.all([
    getBudgetReport(actor, budgetFilterSchema.parse({})),
    getCashFlowReport(actor, cashFlowFilterSchema.parse({})),
  ]);

  const signals: FinancialSignal[] = [];

  for (const row of budget.overBudgetProjects) {
    signals.push({
      id: `budget_overrun:${row.projectId}`,
      type: "BUDGET_OVERRUN",
      severity: "CRITICAL",
      affectedProjectId: row.projectId,
      affectedProjectName: row.name,
      metrics: {
        estimatedBudget: row.estimatedBudget,
        realizedExpenses: row.realizedExpenses,
        overrunAmount: row.overrunAmount,
        overrunPercentage: row.overrunPercentage,
      },
      facts: `"${row.name}" projesi planlanan bütçeyi ${row.overrunAmount} TL (%${row.overrunPercentage}) aştı. Planlanan bütçe: ${row.estimatedBudget} TL, gerçekleşen gider: ${row.realizedExpenses} TL.`,
    });
  }

  for (const row of budget.atRiskProjects) {
    signals.push({
      id: `budget_near_overrun:${row.projectId}`,
      type: "BUDGET_NEAR_OVERRUN",
      severity: "HIGH",
      affectedProjectId: row.projectId,
      affectedProjectName: row.name,
      metrics: {
        estimatedBudget: row.estimatedBudget,
        realizedExpenses: row.realizedExpenses,
        remainingAmount: row.remainingAmount,
        usagePercentage: row.usagePercentage ?? "0",
      },
      facts: `"${row.name}" projesi bütçesinin %${row.usagePercentage}'ini kullandı. Planlanan bütçe: ${row.estimatedBudget} TL, kalan: ${row.remainingAmount} TL.`,
    });
  }

  if (cashFlow.scope === "ORGANIZATION") {
    const openingBalance = toDecimal(cashFlow.openingBalance);
    const projectedClosingBalance = toDecimal(cashFlow.projectedClosingBalance);
    if (projectedClosingBalance.lessThan(ZERO)) {
      signals.push({
        id: "cash_flow_pressure:org",
        type: "CASH_FLOW_PRESSURE",
        severity: "CRITICAL",
        affectedProjectId: null,
        affectedProjectName: null,
        metrics: { openingBalance: cashFlow.openingBalance, projectedClosingBalance: cashFlow.projectedClosingBalance },
        facts: `Güncel kasa/banka bakiyesi ${cashFlow.openingBalance} TL. Planlanan tahsilat ve ödemeler gerçekleştiğinde tahmini kapanış bakiyesi ${cashFlow.projectedClosingBalance} TL (negatif) olacak.`,
      });
    } else if (openingBalance.greaterThan(ZERO) && projectedClosingBalance.lessThan(openingBalance.mul("0.2"))) {
      signals.push({
        id: "cash_flow_pressure:org",
        type: "CASH_FLOW_PRESSURE",
        severity: "HIGH",
        affectedProjectId: null,
        affectedProjectName: null,
        metrics: { openingBalance: cashFlow.openingBalance, projectedClosingBalance: cashFlow.projectedClosingBalance },
        facts: `Güncel kasa/banka bakiyesi ${cashFlow.openingBalance} TL. Planlanan tahsilat ve ödemeler sonrası tahmini kapanış bakiyesi ${cashFlow.projectedClosingBalance} TL'ye düşüyor (açılış bakiyesinin %20'sinin altında).`,
      });
    }
  }

  const totalOpenReceivable = sumMaturityBuckets(cashFlow.receivableBuckets);
  const overdueReceivable = toDecimal(cashFlow.receivableBuckets.overdue);
  if (overdueReceivable.greaterThan(ZERO)) {
    const ratio = totalOpenReceivable.greaterThan(ZERO) ? overdueReceivable.div(totalOpenReceivable) : ZERO;
    signals.push({
      id: "overdue_receivables:org",
      type: "OVERDUE_RECEIVABLES",
      severity: ratio.greaterThanOrEqualTo("0.3") ? "HIGH" : "MEDIUM",
      affectedProjectId: null,
      affectedProjectName: null,
      metrics: { overdueReceivable: cashFlow.receivableBuckets.overdue, totalOpenReceivable: totalOpenReceivable.toString() },
      facts: `Vadesi geçmiş toplam alacak ${cashFlow.receivableBuckets.overdue} TL (açık toplam alacağın %${ratio.mul(100).toDecimalPlaces(1)}'i).`,
    });
  }

  const overdueProjectIds = new Set<string>();
  const topOverdueProjects = cashFlow.projectComparison
    .filter((p) => toDecimal(p.overdueReceivable).greaterThan(ZERO))
    .sort((a, b) => toDecimal(b.overdueReceivable).comparedTo(toDecimal(a.overdueReceivable)))
    .slice(0, 5);
  for (const row of topOverdueProjects) {
    overdueProjectIds.add(row.projectId);
    signals.push({
      id: `overdue_receivables:${row.projectId}`,
      type: "OVERDUE_RECEIVABLES",
      severity: "MEDIUM",
      affectedProjectId: row.projectId,
      affectedProjectName: row.name,
      metrics: { overdueReceivable: row.overdueReceivable },
      facts: `"${row.name}" projesinde vadesi geçmiş ${row.overdueReceivable} TL alacak bulunuyor.`,
    });
  }

  if (budget.categoryAnalysis.length >= 2) {
    const top = budget.categoryAnalysis[0];
    const share = toDecimal(top.shareOfTotal ?? "0");
    if (share.greaterThanOrEqualTo("40")) {
      signals.push({
        id: `expense_concentration:${top.categoryId}`,
        type: "EXPENSE_CONCENTRATION",
        severity: share.greaterThanOrEqualTo("60") ? "HIGH" : "MEDIUM",
        affectedProjectId: null,
        affectedProjectName: null,
        metrics: { categoryName: top.name, recordedExpense: top.recordedExpense, shareOfTotal: top.shareOfTotal ?? "0" },
        facts: `"${top.name}" gider kategorisi toplam giderlerin %${top.shareOfTotal}'ini oluşturuyor (${top.recordedExpense} TL).`,
      });
    }
  }

  const deterioratingStatuses = new Set(["OVER_BUDGET", "CRITICAL"]);
  for (const row of budget.projectComparison) {
    if (!deterioratingStatuses.has(row.status)) continue;
    if (!overdueProjectIds.has(row.projectId)) continue;
    const cashRow = cashFlow.projectComparison.find((p) => p.projectId === row.projectId);
    if (!cashRow) continue;
    signals.push({
      id: `project_deterioration:${row.projectId}`,
      type: "PROJECT_DETERIORATION",
      severity: "CRITICAL",
      affectedProjectId: row.projectId,
      affectedProjectName: row.name,
      metrics: {
        budgetStatus: row.status,
        usagePercentage: row.usagePercentage ?? "0",
        overdueReceivable: cashRow.overdueReceivable,
      },
      facts: `"${row.name}" projesi hem bütçe baskısı altında (durum: ${row.status}, kullanım %${row.usagePercentage}) hem de ${cashRow.overdueReceivable} TL vadesi geçmiş alacağa sahip — birleşik risk.`,
    });
  }

  signals.sort((a, b) => {
    const rankDiff = SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity];
    if (rankDiff !== 0) return rankDiff;
    return a.id.localeCompare(b.id);
  });

  return signals;
}

function fallbackInsight(signal: FinancialSignal, generatedAt: string): AiInsight {
  return {
    id: signal.id,
    type: signal.type,
    severity: signal.severity,
    title: DEFAULT_TITLES[signal.type],
    explanation: signal.facts,
    evidence: signal.metrics,
    suggestedAction: DEFAULT_ACTIONS[signal.type],
    affectedProjectId: signal.affectedProjectId,
    affectedProjectName: signal.affectedProjectName,
    generatedAt,
    isAiGenerated: false,
  };
}

function mergeInsight(
  signal: FinancialSignal,
  modelItem: { title: string; explanation: string; suggestedAction: string } | undefined,
  generatedAt: string,
): AiInsight {
  if (!modelItem) return fallbackInsight(signal, generatedAt);
  return {
    id: signal.id,
    type: signal.type,
    severity: signal.severity,
    title: modelItem.title,
    explanation: modelItem.explanation,
    evidence: signal.metrics,
    suggestedAction: modelItem.suggestedAction,
    affectedProjectId: signal.affectedProjectId,
    affectedProjectName: signal.affectedProjectName,
    generatedAt,
    isAiGenerated: true,
  };
}

export interface GetAiInsightsOptions {
  provider: AiProvider;
  /** Belirtilmezse her çağrı için taze bir kimlik üretilir (bkz. lib/ai/correlation.ts) — normal kullanımda çift ücretlendirme riski yoktur. Güvenli yeniden deneme için çağıran aynı anahtarı tekrar geçebilir. */
  idempotencyKey?: string;
  model?: string;
}

/**
 * YF-702 — Ana orkestrasyon: deterministik sinyal çıkarımı + (varsa) AI
 * yorumlama. AI hiçbir zaman `evidence`/`severity` alanlarını ÜRETEMEZ —
 * bunlar her zaman `extractFinancialSignals`'ın deterministik çıktısından
 * kopyalanır (bkz. `mergeInsight`/`fallbackInsight`).
 */
export async function getAiInsights(actor: SessionUser, options: GetAiInsightsOptions): Promise<AiInsightsResult> {
  const allSignals = await extractFinancialSignals(actor);
  const generatedAt = new Date().toISOString();

  if (allSignals.length === 0) {
    return aiInsightsResultSchema.parse({ insights: [], generatedAt, signalCount: 0, truncated: false });
  }

  const truncated = allSignals.length > MAX_SIGNALS;
  const signals = allSignals.slice(0, MAX_SIGNALS);

  const correlationId = createAiCorrelationId();
  const idempotencyKey = options.idempotencyKey ?? correlationId;
  const messages = aiInsightsPromptTemplate.render({
    organizationName: actor.organizationName,
    signals: signals.map((s) => ({ id: s.id, type: s.type, severity: s.severity, affectedProjectName: s.affectedProjectName, facts: s.facts })),
  });

  const outcome = await requestAiCompletion(actor, {
    provider: options.provider,
    idempotencyKey,
    messages,
    promptVersion: aiInsightsPromptTemplate.version,
    model: options.model,
    maxOutputTokens: INSIGHTS_MAX_OUTPUT_TOKENS,
    temperature: 0.2,
    correlationId,
  });

  if (outcome.status === "already_processed") {
    // YF-711 ledger'ı asla ham AI çıktısını saklamaz — bu isteğin daha önce
    // tamamlandığı bilinir ama yanıt metni yeniden üretilemez. Deterministik
    // sinyaller yine de anlamlıdır; AI yorumu olmadan (isAiGenerated=false)
    // döndürülür (bkz. modül başlığı, "AI cannot alter financial truth").
    const insights = signals.map((s) => fallbackInsight(s, generatedAt));
    return aiInsightsResultSchema.parse({ insights, generatedAt, signalCount: allSignals.length, truncated });
  }

  const parsed: StructuredOutputResult<{ insights: { signalId: string; title: string; explanation: string; suggestedAction: string }[] }> =
    parseStructuredOutput(aiInsightModelResponseSchema, outcome.result.text);

  const byId = new Map<string, { title: string; explanation: string; suggestedAction: string }>();
  if (parsed.success) {
    for (const item of parsed.data.insights) {
      byId.set(item.signalId, item);
    }
  }

  const insights = signals.map((s) => mergeInsight(s, byId.get(s.id), generatedAt));
  return aiInsightsResultSchema.parse({ insights, generatedAt, signalCount: allSignals.length, truncated });
}
