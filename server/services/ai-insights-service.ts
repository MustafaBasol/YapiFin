import type { SessionUser } from "@/lib/auth/session";
import { db } from "@/lib/db";
import { checkCapability } from "@/lib/entitlements/entitlement-service";
import { getBudgetReport } from "@/server/services/budget-report-service";
import { getCashFlowReport } from "@/server/services/cash-flow-report-service";
import { budgetFilterSchema, cashFlowFilterSchema } from "@/lib/validation/reports";
import { AiEntitlementError, requestAiCompletion } from "@/server/services/ai-usage-reporting-service";
import { runInsightRules, type FinancialSignal, type SettlementPeriodTotals } from "@/server/services/ai-insights-rules";
import {
  getDateRange,
  getSettlementTotalsForRange,
  resolveActorProjectScope,
} from "@/server/services/dashboard-service";
import type { AiProvider, StructuredOutputResult } from "@/lib/ai";
import { createAiCorrelationId, parseStructuredOutput } from "@/lib/ai";
import { aiInsightsPromptTemplate } from "@/lib/ai/insights/prompt";
import { DEFAULT_INSIGHT_THRESHOLDS, type InsightThresholds } from "@/lib/ai/insights/thresholds";
import {
  aiInsightModelResponseSchema,
  aiInsightsResultSchema,
  type AiInsight,
  type AiInsightsResult,
  type InsightType,
} from "@/lib/ai/insights/schema";

/**
 * YF-702 — Deterministik finansal sinyal çıkarımı + AI destekli
 * içgörü/erken uyarı üretimi.
 *
 * Mimari (dört ayrı katman, bkz. görev talimatı):
 * 1. **Finansal sinyal hesaplama** — `server/services/ai-insights-rules.ts`
 *    kural motoru. Bu servis yalnızca kanonik rapor servislerini
 *    (`getBudgetReport`, `getCashFlowReport`, `getSettlementTotalsForRange` —
 *    hepsi zaten tenant/rol kapsamlıdır veya kapsamı `resolveActorProjectScope`
 *    ile alır) çağırıp çıktılarını motora verir. Bu modülde DOĞRUDAN Prisma
 *    sorgusu YOKTUR ve hiçbir finansal formül yeniden hesaplanmaz; üç kanonik
 *    çağrı tek seferde, paralel olarak yapılır (kural başına sorgu veya proje
 *    başına döngü içi sorgu YOKTUR).
 * 2. **İçgörü üretimi** — `getAiInsights` (bu dosya).
 * 3. **AI/sağlayıcı katmanı** — `lib/ai/*` (YF-701, sağlayıcı-nötr).
 * 4. **Yetki/kota** — `ai.insights` yeteneği + YF-711 kota motoru (aşağıya bakınız).
 *
 * AI, sinyalleri (yalnızca id/tür/önem/proje adı/kısa Türkçe olgu cümlesi —
 * ham satır/PII/hesap kimliği yok) modele iletir. Modelden İSTENEN JSON şekli
 * yalnızca metin alanları içerir; hiçbir sayısal/finansal alan modelden KABUL
 * EDİLMEZ. Nihai `evidence`/`severity` her zaman adım 1'in deterministik
 * çıktısından kopyalanır (bkz. `mergeInsight`).
 */

/** Tutucu bir üst sınır — sinyal başına ~120 token'lık bir yanıt varsayımıyla (bkz. lib/ai/credits.ts). */
const INSIGHTS_MAX_OUTPUT_TOKENS = 1600;

/**
 * YF-702 — Bu modülün plan yetkisi. `ai.features` şemsiyesinin ALTINDA ek bir
 * kapıdır; `requestAiCompletion` şemsiyeyi ve paylaşımlı `ai.monthly_quota`
 * kotasını zaten uygular (bkz. server/services/ai-usage-reporting-service.ts).
 */
export const AI_INSIGHTS_CAPABILITY = "ai.insights" as const;

export type { FinancialSignal } from "@/server/services/ai-insights-rules";

const DEFAULT_TITLES: Record<InsightType, string> = {
  BUDGET_OVERRUN: "Bütçe aşıldı",
  BUDGET_NEAR_OVERRUN: "Bütçe sınırına yaklaşıldı",
  CASH_FLOW_PRESSURE: "Nakit akışı baskısı",
  OVERDUE_RECEIVABLES: "Vadesi geçen alacaklar",
  EXPENSE_CONCENTRATION: "Yüksek gider yoğunlaşması",
  PROJECT_DETERIORATION: "Proje finansal durumu kötüleşiyor",
  COLLECTION_PAYMENT_IMBALANCE: "Tahsilat–ödeme dengesizliği",
};

const DEFAULT_ACTIONS: Record<InsightType, string> = {
  BUDGET_OVERRUN: "Proje bütçesini gözden geçirin ve ek maliyetlerin nedenini analiz edin.",
  BUDGET_NEAR_OVERRUN: "Kalan bütçeyi yakından izleyin, kritik olmayan harcamaları erteleyin.",
  CASH_FLOW_PRESSURE: "Tahsilatları hızlandırmayı veya planlanan ödemeleri yeniden planlamayı değerlendirin.",
  OVERDUE_RECEIVABLES: "Vadesi geçen alacaklar için tahsilat takibini önceliklendirin.",
  EXPENSE_CONCENTRATION: "Bu kategorideki harcamaları detaylı inceleyin, tedarikçi/fiyat alternatiflerini değerlendirin.",
  PROJECT_DETERIORATION: "Bu projenin bütçe ve tahsilat durumunu birlikte gözden geçirin, gerekirse yönetime raporlayın.",
  COLLECTION_PAYMENT_IMBALANCE:
    "Vadesi gelen tahsilatların takibini hızlandırın ve kritik olmayan ödemeleri yeniden planlayarak nakit dengesini koruyun.",
};

/**
 * `ai.insights` plan yetkisini fail-closed olarak doğrular.
 *
 * Bu, `requestAiCompletion` içindeki iki katmanlı kontrolün YERİNE geçmez —
 * ona EK bir ön kapıdır ve KASITLI olarak rapor sorgularından ÖNCE çalışır:
 * yetkisiz bir organizasyon için iki ağır rapor sorgusu (bütçe + nakit akışı)
 * hiç çalıştırılmaz, ayrıca "sinyal yok" ile "plana dahil değil" durumları
 * birbirine karışmaz (önceki hâlinde sinyali olmayan yetkisiz bir
 * organizasyon 200 + boş liste alıyordu, yani özellik çalışıyormuş gibi
 * görünüyordu).
 */
async function assertAiInsightsEntitlement(actor: SessionUser): Promise<void> {
  const capability = await checkCapability(db, actor.organizationId, AI_INSIGHTS_CAPABILITY);
  if (!capability.allowed) {
    throw new AiEntitlementError(
      "AI içgörüleri mevcut planınıza dahil değil. Devam etmek için planınızı yükseltmeniz gerekir.",
      "FORBIDDEN",
      "AI_PLAN_REQUIRED",
    );
  }
}

/**
 * YF-702-F1 — `COLLECTION_PAYMENT_IMBALANCE` kuralının dönemi.
 *
 * İçinde bulunulan takvim ayı seçilir; bu, dashboard KPI kartlarının
 * varsayılan dönemiyle AYNIdır (bkz. lib/validation/dashboard.ts) — kullanıcı
 * uyarıyı gördüğünde dashboard'da aynı tahsilat/ödeme rakamlarını bulur, yeni
 * bir dönem kavramı icat edilmez. Nakit akışı raporunun içgörü akışındaki
 * varsayılan penceresi (`NEXT_30_DAYS`) İLERİ dönük olduğundan bu sinyal için
 * kullanılamaz (bkz. SettlementPeriodTotals doküman notu).
 */
const SETTLEMENT_SIGNAL_PERIOD = "CURRENT_MONTH" as const;

/**
 * Gerçekleşen tahsilat/ödeme toplamlarını kanonik servisten, aktörün rol
 * kapsamına göre okur. Kapsam çözümlemesi `resolveActorProjectScope`'a
 * devredilir (bkz. server/services/dashboard-service.ts) — rol mantığı bu
 * modülde TEKRARLANMAZ, PROJECT_MANAGER için yalnızca atanmış projeler
 * kapsanır ve atanmış proje yoksa servis fail-closed olarak sıfır döner.
 */
async function getRealizedSettlementTotals(actor: SessionUser): Promise<SettlementPeriodTotals> {
  const range = getDateRange(SETTLEMENT_SIGNAL_PERIOD, new Date());
  const projectIds = await resolveActorProjectScope(actor);
  const totals = await getSettlementTotalsForRange(actor.organizationId, range, projectIds);
  return {
    collected: totals.collected.toString(),
    paid: totals.paid.toString(),
    net: totals.net.toString(),
    rangeStart: range.start,
    rangeEnd: range.end,
  };
}

/**
 * Kanonik rapor servislerinin çıktısını kural motoruna verir. Rol/tenant
 * kapsaması tamamen `getBudgetReport`/`getCashFlowReport`'a (ve tahsilat
 * toplamları için `resolveActorProjectScope`'a) devredilir — burada
 * tekrarlanmaz (bkz. modül başlığı).
 */
export async function extractFinancialSignals(
  actor: SessionUser,
  thresholds: InsightThresholds = DEFAULT_INSIGHT_THRESHOLDS,
): Promise<FinancialSignal[]> {
  const [budget, cashFlow, settlement] = await Promise.all([
    getBudgetReport(actor, budgetFilterSchema.parse({})),
    getCashFlowReport(actor, cashFlowFilterSchema.parse({})),
    getRealizedSettlementTotals(actor),
  ]);

  return runInsightRules({ budget, cashFlow, settlement, thresholds });
}

function fallbackInsight(signal: FinancialSignal, generatedAt: string): AiInsight {
  return {
    id: signal.id,
    type: signal.type,
    severity: signal.severity,
    title: DEFAULT_TITLES[signal.type],
    explanation: signal.facts,
    evidence: signal.evidence,
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
    evidence: signal.evidence,
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
  /** Test/ileri yapılandırma için eşik geçersiz kılma; üretimde varsayılan kullanılır. */
  thresholds?: InsightThresholds;
}

/**
 * YF-702 — Ana orkestrasyon: yetki kontrolü → deterministik sinyal çıkarımı →
 * (varsa) AI yorumlama. AI hiçbir zaman `evidence`/`severity` alanlarını
 * ÜRETEMEZ — bunlar her zaman kural motorunun deterministik çıktısından
 * kopyalanır (bkz. `mergeInsight`/`fallbackInsight`).
 */
export async function getAiInsights(actor: SessionUser, options: GetAiInsightsOptions): Promise<AiInsightsResult> {
  await assertAiInsightsEntitlement(actor);

  const thresholds = options.thresholds ?? DEFAULT_INSIGHT_THRESHOLDS;
  const allSignals = await extractFinancialSignals(actor, thresholds);
  const generatedAt = new Date().toISOString();

  if (allSignals.length === 0) {
    // Sinyal yoksa sağlayıcı HİÇ çağrılmaz ve kota tüketilmez — "veri
    // yetersizse uyarı uydurma" kuralının doğrudan sonucu.
    return aiInsightsResultSchema.parse({ insights: [], generatedAt, signalCount: 0, truncated: false });
  }

  const truncated = allSignals.length > thresholds.maxSignals;
  const signals = allSignals.slice(0, thresholds.maxSignals);

  const correlationId = createAiCorrelationId();
  const idempotencyKey = options.idempotencyKey ?? correlationId;
  const messages = aiInsightsPromptTemplate.render({
    organizationName: actor.organizationName,
    signals: signals.map((s) => ({
      id: s.id,
      type: s.type,
      severity: s.severity,
      affectedProjectName: s.affectedProjectName,
      facts: s.facts,
    })),
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
    featureCapability: AI_INSIGHTS_CAPABILITY,
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
