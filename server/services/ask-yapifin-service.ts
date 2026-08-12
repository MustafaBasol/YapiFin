import type { SessionUser } from "@/lib/auth/session";
import { listProjectsForUser } from "@/server/services/project-service";
import { canViewAllProjects } from "@/lib/permissions";
import { getBudgetReport } from "@/server/services/budget-report-service";
import { budgetFilterSchema } from "@/lib/validation/reports";
import { extractFinancialSignals } from "@/server/services/ai-insights-service";
import { requestAiCompletion } from "@/server/services/ai-usage-reporting-service";
import { buildAiContext } from "@/lib/ai/context";
import type { AiContextItem } from "@/lib/ai/context";
import type { AiProvider, StructuredOutputResult } from "@/lib/ai";
import { createAiCorrelationId, parseStructuredOutput } from "@/lib/ai";
import { askYapiFinPromptTemplate } from "@/lib/ai/ask/prompt";
import { classifyQuestion, type AskProjectCandidate } from "@/lib/ai/ask/classify";
import type { InsightSeverity } from "@/lib/ai/insights/schema";
import {
  askModelResponseSchema,
  askYapiFinResultSchema,
  type AskFact,
  type AskIntent,
  type AskModelResponse,
  type AskScope,
  type AskYapiFinResult,
} from "@/lib/ai/ask/schema";

/**
 * YF-703 — "YapiFin'e Sor" doğal dil finansal soru-cevap orkestrasyonu.
 *
 * Mimari (bkz. görev talimatı "deterministic query intent -> canonical
 * YapiFin financial services -> structured deterministic facts -> AI
 * explanation" — YF-702 ai-insights-service.ts ile aynı ilke):
 * 1. `classifyQuestion` (SAF, DB/AI erişimi yok) serbest metni desteklenen
 *    6 niyetten birine eşler; eşleşmezse AI HİÇ ÇAĞRILMAZ.
 * 2. `buildFacts` YALNIZCA mevcut kanonik servisleri (`getBudgetReport`,
 *    `buildAiContext` → project-finance/project-budget-variance/cash-flow/
 *    dashboard servisleri, `extractFinancialSignals`) çağırır. Burada TEK
 *    bir yeni Prisma sorgusu YOKTUR.
 * 3. Model'e YALNIZCA önceden hesaplanmış Türkçe olgu metni gönderilir; model
 *    yalnızca `answer` metnini üretir (bkz. lib/ai/ask/schema.ts). Nihai
 *    `facts` alanı her zaman adım 2'nin deterministik çıktısıdır — model
 *    çıktısından asla türetilmez.
 */

const ASK_MAX_OUTPUT_TOKENS = 500;

const BUDGET_STATUS_LABELS: Record<string, string> = {
  OVER_BUDGET: "Bütçe aşıldı",
  CRITICAL: "Kritik (bütçe sınırına yakın)",
  NORMAL: "Normal",
  NO_BUDGET: "Bütçe tanımlanmamış",
};

const SEVERITY_LABELS_TR: Record<InsightSeverity, string> = {
  CRITICAL: "Kritik",
  HIGH: "Yüksek",
  MEDIUM: "Orta",
  LOW: "Düşük",
};

function moneyFact(label: string, decimalValue: string): AskFact {
  return { label, value: `${decimalValue} TL` };
}

function percentFact(label: string, percentValue: string | null): AskFact {
  return { label, value: percentValue != null ? `%${percentValue}` : "—" };
}

/** `AiContextItem` içinden istenen `source`'a sahip öğeyi tip-güvenli biçimde çıkarır — istek zaten o kaynağı içerdiği için her zaman bulunur. */
function pickContext<T extends AiContextItem["source"]>(
  items: AiContextItem[],
  source: T,
): Extract<AiContextItem, { source: T }> {
  const item = items.find((i): i is Extract<AiContextItem, { source: T }> => i.source === source);
  if (!item) throw new Error(`Beklenen AI bağlam kaynağı eksik: ${source}`);
  return item;
}

interface AskFactsBundle {
  projectId: string | null;
  projectName: string | null;
  periodLabel: string;
  facts: AskFact[];
  factsText: string;
  /** Sorguyla eşleşen hiç veri yoksa true — bu durumda AI hiç çağrılmaz, deterministik metin doğrudan döner. */
  isEmpty: boolean;
}

async function buildOrgSummaryFacts(actor: SessionUser): Promise<AskFactsBundle> {
  const context = await buildAiContext(actor, { sources: ["COMPANY_FINANCIAL_SUMMARY"], projectId: undefined });
  const item = pickContext(context.items, "COMPANY_FINANCIAL_SUMMARY");

  const facts: AskFact[] = [
    moneyFact("Tahsil Edilen Gelir", item.collectedIncome),
    moneyFact("Ödenen Gider", item.paidExpense),
    moneyFact("Net Nakit Akışı", item.netCashFlow),
    moneyFact("Açık Alacak", item.openReceivable),
    moneyFact("Vadesi Geçen Alacak", item.overdueReceivable),
    moneyFact("Açık Borç", item.openPayable),
    moneyFact("Vadesi Geçen Borç", item.overduePayable),
  ];
  if (item.cashAndBankBalance != null) facts.push(moneyFact("Kasa/Banka Bakiyesi", item.cashAndBankBalance));
  facts.push({ label: "Aktif Proje Sayısı", value: String(item.activeProjectCount) });

  const factsText =
    `Bu ay tahsil edilen gelir ${item.collectedIncome} TL, ödenen gider ${item.paidExpense} TL, net nakit akışı ${item.netCashFlow} TL. ` +
    `Açık alacak ${item.openReceivable} TL (bunun ${item.overdueReceivable} TL'si vadesi geçmiş), açık borç ${item.openPayable} TL ` +
    `(bunun ${item.overduePayable} TL'si vadesi geçmiş).`;

  return { projectId: null, projectName: null, periodLabel: "Bu ay", facts, factsText, isEmpty: false };
}

async function buildProjectStatusFacts(actor: SessionUser, projectId: string): Promise<AskFactsBundle> {
  const context = await buildAiContext(actor, { sources: ["PROJECT_SUMMARY", "BUDGET_VARIANCE"], projectId });
  const summary = pickContext(context.items, "PROJECT_SUMMARY");
  const variance = pickContext(context.items, "BUDGET_VARIANCE");

  const facts: AskFact[] = [
    moneyFact("Sözleşme Bedeli", summary.contractAmount),
    moneyFact("Tahmini Bütçe", summary.estimatedBudget),
    moneyFact("Gerçekleşen Gider", summary.totalRecordedExpense),
    percentFact("Bütçe Kullanım Oranı", summary.budgetUsed),
    moneyFact("Kalan Bütçe", summary.remainingBudget),
    moneyFact("Tahsil Edilen", summary.totalCollected),
    moneyFact("Kalan Alacak", summary.remainingReceivable),
    moneyFact("Ödenen", summary.totalPaid),
    moneyFact("Kalan Borç", summary.remainingPayable),
    moneyFact("Nakit Pozisyonu", summary.cashPosition),
    { label: "Bütçe Durumu", value: BUDGET_STATUS_LABELS[variance.status] ?? variance.status },
  ];

  const factsText =
    `"${summary.projectName}" projesinin tahmini bütçesi ${summary.estimatedBudget} TL, gerçekleşen gideri ${summary.totalRecordedExpense} TL ` +
    `(bütçenin %${summary.budgetUsed}'i). Tahsil edilen ${summary.totalCollected} TL (kalan alacak ${summary.remainingReceivable} TL), ` +
    `ödenen ${summary.totalPaid} TL (kalan borç ${summary.remainingPayable} TL). Nakit pozisyonu ${summary.cashPosition} TL.` +
    (summary.isBudgetOverrun ? " Bu proje bütçesini aşmış durumda." : "");

  return { projectId: summary.projectId, projectName: summary.projectName, periodLabel: "Tüm zamanlar", facts, factsText, isEmpty: false };
}

async function buildCashFlowStatusFacts(actor: SessionUser): Promise<AskFactsBundle> {
  const context = await buildAiContext(actor, { sources: ["CASH_FLOW", "RECEIVABLES_PAYABLES"], projectId: undefined });
  const cashFlow = pickContext(context.items, "CASH_FLOW");
  const receivablesPayables = pickContext(context.items, "RECEIVABLES_PAYABLES");

  const signals = await extractFinancialSignals(actor);
  const pressureSignal = signals.find((s) => s.type === "CASH_FLOW_PRESSURE");

  const facts: AskFact[] = [
    moneyFact("Gerçekleşen Tahsilat", cashFlow.realizedCollections),
    moneyFact("Gerçekleşen Ödeme", cashFlow.realizedPayments),
    moneyFact("Gerçekleşen Net Nakit Akışı", cashFlow.realizedNet),
    moneyFact("Planlanan Tahsilat", cashFlow.scheduledCollections),
    moneyFact("Planlanan Ödeme", cashFlow.scheduledPayments),
    moneyFact("Beklenen Net Nakit", cashFlow.scheduledNet),
    moneyFact("Vadesi Geçen Alacak", receivablesPayables.receivableBuckets.overdue),
    moneyFact("Vadesi Geçen Borç", receivablesPayables.payableBuckets.overdue),
    {
      label: "Nakit Akışı Riski",
      value: pressureSignal ? `${SEVERITY_LABELS_TR[pressureSignal.severity]} risk tespit edildi` : "Şu anda tespit edilen bir risk yok",
    },
  ];

  const riskSentence = pressureSignal ? pressureSignal.facts : "Şu anda nakit akışında dikkat gerektiren bir risk tespit edilmedi.";
  const factsText =
    `Gelecek dönemde planlanan tahsilat ${cashFlow.scheduledCollections} TL, planlanan ödeme ${cashFlow.scheduledPayments} TL, ` +
    `beklenen net nakit ${cashFlow.scheduledNet} TL. Vadesi geçen alacak ${receivablesPayables.receivableBuckets.overdue} TL, ` +
    `vadesi geçen borç ${receivablesPayables.payableBuckets.overdue} TL. ${riskSentence}`;

  return { projectId: null, projectName: null, periodLabel: "Gelecek 30 gün", facts, factsText, isEmpty: false };
}

async function buildOverdueReceivablesFacts(actor: SessionUser): Promise<AskFactsBundle> {
  const signals = await extractFinancialSignals(actor);
  const overdueSignals = signals.filter((s) => s.type === "OVERDUE_RECEIVABLES");
  const orgSignal = overdueSignals.find((s) => s.affectedProjectId === null);
  const projectSignals = overdueSignals.filter((s) => s.affectedProjectId !== null);

  if (!orgSignal) {
    return {
      projectId: null,
      projectName: null,
      periodLabel: "Güncel durum",
      facts: [{ label: "Vadesi Geçen Alacak", value: "0 TL" }],
      factsText: "Şu anda vadesi geçmiş bir alacak bulunmuyor.",
      isEmpty: true,
    };
  }

  // YF-702 — kanıt artık tipli: OVERDUE_RECEIVABLES sinyalinin `currentValue`
  // alanı her zaman vadesi geçmiş tutardır (bkz.
  // server/services/ai-insights-rules.ts overdueReceivables* kuralları).
  const facts: AskFact[] = [moneyFact("Toplam Vadesi Geçen Alacak", orgSignal.evidence.currentValue?.value ?? "0")];
  for (const s of projectSignals) {
    facts.push(moneyFact(`${s.affectedProjectName} — Vadesi Geçen Alacak`, s.evidence.currentValue?.value ?? "0"));
  }

  const factsText = [orgSignal.facts, ...projectSignals.map((s) => s.facts)].join(" ");
  return { projectId: null, projectName: null, periodLabel: "Güncel durum", facts, factsText, isEmpty: false };
}

async function buildExpenseConcentrationFacts(actor: SessionUser): Promise<AskFactsBundle> {
  const budget = await getBudgetReport(actor, budgetFilterSchema.parse({}));
  if (budget.categoryAnalysis.length === 0) {
    return {
      projectId: null,
      projectName: null,
      periodLabel: "Tüm zamanlar",
      facts: [],
      factsText: "Henüz gider kategorisi verisi bulunmuyor.",
      isEmpty: true,
    };
  }

  const top = budget.categoryAnalysis.slice(0, 3);
  const facts: AskFact[] = top.map((c) => moneyFact(`${c.name} (%${c.shareOfTotal ?? "0"})`, c.recordedExpense));
  const leader = top[0];
  const factsText =
    `En yüksek gider kategorisi "${leader.name}", toplam giderlerin %${leader.shareOfTotal ?? "0"}'ini oluşturuyor (${leader.recordedExpense} TL).` +
    (top.length > 1
      ? ` Diğer öne çıkan kategoriler: ${top
          .slice(1)
          .map((c) => `"${c.name}" (%${c.shareOfTotal ?? "0"}, ${c.recordedExpense} TL)`)
          .join(", ")}.`
      : "");

  return { projectId: null, projectName: null, periodLabel: "Tüm zamanlar", facts, factsText, isEmpty: false };
}

async function buildTopBudgetOverrunFacts(actor: SessionUser): Promise<AskFactsBundle> {
  const budget = await getBudgetReport(actor, budgetFilterSchema.parse({}));
  if (budget.overBudgetProjects.length === 0) {
    return {
      projectId: null,
      projectName: null,
      periodLabel: "Tüm zamanlar",
      facts: [],
      factsText: "Şu anda bütçesi aşılmış bir proje bulunmuyor.",
      isEmpty: true,
    };
  }

  const top = budget.overBudgetProjects[0];
  const facts: AskFact[] = [
    moneyFact("Planlanan Bütçe", top.estimatedBudget),
    moneyFact("Gerçekleşen Gider", top.realizedExpenses),
    moneyFact("Aşım Tutarı", top.overrunAmount),
    percentFact("Aşım Oranı", top.overrunPercentage),
  ];
  const factsText = `En fazla bütçe aşımı "${top.name}" projesinde: planlanan bütçe ${top.estimatedBudget} TL, gerçekleşen gider ${top.realizedExpenses} TL, aşım ${top.overrunAmount} TL (%${top.overrunPercentage}).`;

  return { projectId: top.projectId, projectName: top.name, periodLabel: "Tüm zamanlar", facts, factsText, isEmpty: false };
}

async function buildFacts(actor: SessionUser, intent: AskIntent, projectId: string | null): Promise<AskFactsBundle> {
  switch (intent) {
    case "ORG_SUMMARY":
      return buildOrgSummaryFacts(actor);
    case "PROJECT_STATUS": {
      if (!projectId) throw new Error("PROJECT_STATUS niyeti için projectId zorunludur");
      return buildProjectStatusFacts(actor, projectId);
    }
    case "CASH_FLOW_STATUS":
      return buildCashFlowStatusFacts(actor);
    case "OVERDUE_RECEIVABLES":
      return buildOverdueReceivablesFacts(actor);
    case "EXPENSE_CONCENTRATION":
      return buildExpenseConcentrationFacts(actor);
    case "TOP_BUDGET_OVERRUN":
      return buildTopBudgetOverrunFacts(actor);
    default: {
      const exhaustiveCheck: never = intent;
      throw new Error(`Bilinmeyen Ask YapiFin niyeti: ${String(exhaustiveCheck)}`);
    }
  }
}

export interface AskYapiFinOptions {
  provider: AiProvider;
  /** Belirtilmezse her çağrı için taze bir kimlik üretilir — güvenli yeniden deneme için çağıran aynı anahtarı tekrar geçebilir. */
  idempotencyKey?: string;
  model?: string;
}

/**
 * YF-703 — Ana orkestrasyon. AI hiçbir zaman `facts`/`scope`/`projectId`
 * alanlarını ÜRETEMEZ — bunlar her zaman `buildFacts`'in deterministik
 * çıktısından kopyalanır. Desteklenmeyen bir soru veya veri olmayan bir
 * sorgu için AI hiç ÇAĞRILMAZ (bkz. modül başlığı).
 */
export async function askYapiFin(actor: SessionUser, rawQuestion: string, options: AskYapiFinOptions): Promise<AskYapiFinResult> {
  const question = rawQuestion.trim();
  const generatedAt = new Date().toISOString();
  const scope: AskScope = canViewAllProjects(actor.role) ? "ORGANIZATION" : "PROJECT_MANAGER";

  const projects = await listProjectsForUser(actor);
  const candidates: AskProjectCandidate[] = projects.map((p) => ({ id: p.id, name: p.name, code: p.code }));
  const classification = classifyQuestion(question, candidates);

  if (!classification.supported) {
    return askYapiFinResultSchema.parse({ status: "unsupported", question, reason: classification.reason, generatedAt });
  }

  const bundle = await buildFacts(actor, classification.intent, classification.projectId);

  if (bundle.isEmpty) {
    return askYapiFinResultSchema.parse({
      status: "answered",
      question,
      intent: classification.intent,
      scope,
      projectId: bundle.projectId,
      projectName: bundle.projectName,
      periodLabel: bundle.periodLabel,
      facts: bundle.facts,
      answer: { text: bundle.factsText, isAiGenerated: false },
      generatedAt,
    });
  }

  const correlationId = createAiCorrelationId();
  const idempotencyKey = options.idempotencyKey ?? correlationId;
  const messages = askYapiFinPromptTemplate.render({ organizationName: actor.organizationName, question, factsText: bundle.factsText });

  const outcome = await requestAiCompletion(actor, {
    provider: options.provider,
    idempotencyKey,
    messages,
    promptVersion: askYapiFinPromptTemplate.version,
    model: options.model,
    maxOutputTokens: ASK_MAX_OUTPUT_TOKENS,
    temperature: 0.2,
    correlationId,
  });

  let answerText = bundle.factsText;
  let isAiGenerated = false;

  if (outcome.status === "completed") {
    const parsed: StructuredOutputResult<AskModelResponse> = parseStructuredOutput(askModelResponseSchema, outcome.result.text);
    if (parsed.success) {
      answerText = parsed.data.answer;
      isAiGenerated = true;
    }
  }
  // outcome.status === "already_processed" -> YF-711 ledger'ı ham AI çıktısını
  // saklamaz; deterministik olgu metniyle (isAiGenerated=false) zarifçe devam edilir.

  return askYapiFinResultSchema.parse({
    status: "answered",
    question,
    intent: classification.intent,
    scope,
    projectId: bundle.projectId,
    projectName: bundle.projectName,
    periodLabel: bundle.periodLabel,
    facts: bundle.facts,
    answer: { text: answerText, isAiGenerated },
    generatedAt,
  });
}
