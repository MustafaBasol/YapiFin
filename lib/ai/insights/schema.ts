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

/** Uç kullanıcıya dönen nihai, doğrulanmış içgörü — evidence/severity her zaman deterministiktir, AI çıktısından asla türetilmez. */
export const aiInsightSchema = z.object({
  id: z.string().min(1),
  type: insightTypeEnum,
  severity: insightSeverityEnum,
  title: z.string().min(1),
  explanation: z.string().min(1),
  evidence: z.record(z.string(), z.string()),
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
