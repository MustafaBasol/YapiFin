import { z } from "zod";

/**
 * YF-703 — "YapiFin'e Sor" doğal dil finansal soru-cevap şeması.
 *
 * `ai-insights` (YF-702) ile aynı ayrım ilkesi izlenir (bkz.
 * lib/ai/insights/schema.ts): modelin üretmesi GEREKEN JSON şekli
 * (`askModelResponseSchema`) yalnızca tek bir metin alanı içerir — hiçbir
 * sayısal/finansal alan YOKTUR. Uç kullanıcıya dönen nihai sonuçtaki `facts`
 * her zaman `server/services/ask-yapifin-service.ts`'in deterministik
 * kanonik servis çağrılarından üretilir, modelden asla KABUL EDİLMEZ.
 */

export const askIntentEnum = z.enum([
  "ORG_SUMMARY",
  "PROJECT_STATUS",
  "CASH_FLOW_STATUS",
  "OVERDUE_RECEIVABLES",
  "EXPENSE_CONCENTRATION",
  "TOP_BUDGET_OVERRUN",
]);
export type AskIntent = z.infer<typeof askIntentEnum>;

export const askScopeEnum = z.enum(["ORGANIZATION", "PROJECT_MANAGER"]);
export type AskScope = z.infer<typeof askScopeEnum>;

/** Modelin üretmesi GEREKEN JSON şekli — yalnızca metin, hiçbir sayısal/finansal alan yok. */
export const askModelResponseSchema = z.object({
  answer: z.string().min(1).max(700),
});
export type AskModelResponse = z.infer<typeof askModelResponseSchema>;

/** Tamamen deterministik, kanonik servis çıktısından türetilmiş tek bir kanıt satırı. */
export const askFactSchema = z.object({
  label: z.string().min(1),
  value: z.string().min(1),
});
export type AskFact = z.infer<typeof askFactSchema>;

export const askYapiFinAnsweredResultSchema = z.object({
  status: z.literal("answered"),
  question: z.string(),
  intent: askIntentEnum,
  scope: askScopeEnum,
  projectId: z.string().nullable(),
  projectName: z.string().nullable(),
  periodLabel: z.string(),
  /** Kanonik servislerden birebir kopyalanan, AI'nin asla değiştiremeyeceği kanıt satırları. */
  facts: z.array(askFactSchema),
  answer: z.object({
    text: z.string(),
    /** AI yorumu mu (model başarıyla üretti) yoksa deterministik yedek/özet metin mi. */
    isAiGenerated: z.boolean(),
  }),
  generatedAt: z.string(),
});
export type AskYapiFinAnsweredResult = z.infer<typeof askYapiFinAnsweredResultSchema>;

export const askYapiFinUnsupportedResultSchema = z.object({
  status: z.literal("unsupported"),
  question: z.string(),
  reason: z.string(),
  generatedAt: z.string(),
});
export type AskYapiFinUnsupportedResult = z.infer<typeof askYapiFinUnsupportedResultSchema>;

export const askYapiFinResultSchema = z.discriminatedUnion("status", [
  askYapiFinAnsweredResultSchema,
  askYapiFinUnsupportedResultSchema,
]);
export type AskYapiFinResult = z.infer<typeof askYapiFinResultSchema>;
