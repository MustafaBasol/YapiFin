import { z } from "zod";

/**
 * YF-702 — AI finansal içgörü/erken uyarı şeması.
 *
 * İki AYRI şema kasıtlı olarak birbirinden ayrılır:
 * - `aiInsightModelResponseSchema`: modelin üretmesi GEREKEN, dar kapsamlı
 *   JSON şekli. Yalnızca metin alanları (title/explanation/suggestedAction)
 *   içerir — hiçbir sayısal/finansal alan YOKTUR. Model bir `signalId`'ye
 *   atıfta bulunur; o sinyalin `severity`/`evidence` değerleri modelden asla
 *   İSTENMEZ ve modelin ürettiği hiçbir sayı nihai sonuca YAZILMAZ (bkz.
 *   server/services/ai-insights-service.ts — evidence/severity tamamen
 *   deterministik sinyalden kopyalanır, model çıktısından değil).
 * - `aiInsightSchema`: uç kullanıcıya döndürülen NİHAİ, doğrulanmış içgörü
 *   şekli — hem deterministik kanıt (evidence/severity/affectedProject) hem
 *   de AI'nin ürettiği yorum metnini taşır, ayrı taşınır (bkz. UI: bu ikisi
 *   ayrı gösterilir, "AI yorumu" ile "gerçek finansal veri" asla karıştırılmaz).
 */

export const insightTypeEnum = z.enum([
  "BUDGET_OVERRUN",
  "BUDGET_NEAR_OVERRUN",
  "CASH_FLOW_PRESSURE",
  "OVERDUE_RECEIVABLES",
  "EXPENSE_CONCENTRATION",
  "PROJECT_DETERIORATION",
  "COLLECTION_PAYMENT_IMBALANCE",
]);
export type InsightType = z.infer<typeof insightTypeEnum>;

export const insightSeverityEnum = z.enum(["LOW", "MEDIUM", "HIGH", "CRITICAL"]);
export type InsightSeverity = z.infer<typeof insightSeverityEnum>;

/** Modelin üretmesi GEREKEN JSON şekli — yalnızca metin, hiçbir sayısal/finansal alan yok. */
export const aiInsightModelResponseSchema = z.object({
  insights: z
    .array(
      z.object({
        signalId: z.string().min(1).max(120),
        title: z.string().min(1).max(140),
        explanation: z.string().min(1).max(600),
        suggestedAction: z.string().min(1).max(300),
      }),
    )
    .max(20),
});
export type AiInsightModelResponse = z.infer<typeof aiInsightModelResponseSchema>;

/**
 * YF-702 — Kanıt (evidence) değerinin gösterim türü. Ham değer HER ZAMAN
 * biçimlendirilmemiş bir string olarak taşınır (Decimal string veya metin);
 * biçimlendirme (₺ / % / tr-TR ayraçları) yalnızca sunum katmanının işidir
 * (bkz. components/app/ai-insights-panel.tsx). Böylece sunucu tarafındaki
 * kanıt, `getBudgetReport`/`getCashFlowReport`'un ürettiği değerle BİREBİR
 * karşılaştırılabilir kalır — testler biçimlendirilmiş metin üzerinden
 * eşleştirme yapmak zorunda değildir.
 */
export const evidenceValueKindEnum = z.enum(["MONEY", "PERCENT", "TEXT"]);
export type EvidenceValueKind = z.infer<typeof evidenceValueKindEnum>;

/**
 * Tek bir kanıt alanı. `label` HER ZAMAN kullanıcıya gösterilebilir Türkçe
 * bir etikettir — arayüz artık ham camelCase anahtar adı ("estimatedBudget")
 * göstermez (bkz. CLAUDE.md madde 8: tüm arayüz metinleri Türkçe olmalıdır).
 */
export const evidenceValueSchema = z.object({
  label: z.string().min(1),
  value: z.string().min(1),
  kind: evidenceValueKindEnum,
});
export type EvidenceValue = z.infer<typeof evidenceValueSchema>;

/**
 * Yapılandırılmış, tipli kanıt. Önceki `Record<string, string>` şekli her
 * sinyalde farklı, belgelenmemiş anahtarlar taşıyordu — ne arayüz ne de bir
 * test hangi alanların var olacağını bilebiliyordu.
 *
 * Ortak karşılaştırma alanları (`currentValue`/`comparisonValue`/
 * `difference`/`percentageChange`) "bu değer NEYE göre kötü?" sorusunu her
 * sinyal için AYNI şekilde cevaplar; sinyale özgü ek alanlar `details`
 * içinde taşınır. Uygulanamayan alanlar `null`'dır — uydurulmaz.
 */
export const insightEvidenceSchema = z.object({
  /** Bugünkü/gerçekleşen değer (ör. gerçekleşen gider). */
  currentValue: evidenceValueSchema.nullable(),
  /** Karşılaştırma tabanı (ör. planlanan bütçe, açılış bakiyesi, toplam açık alacak). */
  comparisonValue: evidenceValueSchema.nullable(),
  /** `currentValue` ile `comparisonValue` arasındaki mutlak fark. */
  difference: evidenceValueSchema.nullable(),
  /** İşaretli yüzde değişim/sapma — biçimlendirilmemiş ondalık string (ör. `"-42.5"`). */
  percentageChange: z.string().nullable(),
  /** Kanıtın hangi veri dönemine ait olduğu (ör. `"01.08.2026 - 31.08.2026"`). Kaynak rapor bir dönem tanımlamıyorsa `null`. */
  period: z.string().nullable(),
  /** Sinyale özgü ek kanıt alanları — her biri Türkçe etiketlidir. */
  details: z.array(evidenceValueSchema),
});
export type InsightEvidence = z.infer<typeof insightEvidenceSchema>;

/** Uç kullanıcıya dönen nihai, doğrulanmış içgörü — evidence/severity her zaman deterministiktir, AI çıktısından asla türetilmez. */
export const aiInsightSchema = z.object({
  id: z.string().min(1),
  type: insightTypeEnum,
  severity: insightSeverityEnum,
  title: z.string().min(1),
  explanation: z.string().min(1),
  evidence: insightEvidenceSchema,
  suggestedAction: z.string().min(1),
  affectedProjectId: z.string().nullable(),
  affectedProjectName: z.string().nullable(),
  generatedAt: z.string(),
  /** AI yorumu mu (model başarıyla üretti) yoksa deterministik yedek metin mi — UI bunu her zaman ayrı işaretlemelidir. */
  isAiGenerated: z.boolean(),
});
export type AiInsight = z.infer<typeof aiInsightSchema>;

export const aiInsightsResultSchema = z.object({
  insights: z.array(aiInsightSchema),
  generatedAt: z.string(),
  signalCount: z.number().int().nonnegative(),
  truncated: z.boolean(),
});
export type AiInsightsResult = z.infer<typeof aiInsightsResultSchema>;
