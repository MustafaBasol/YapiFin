import { z } from "zod";
import { insightSeverityEnum } from "@/lib/ai/insights/schema";

/**
 * YF-705 — AI Nakit Akışı Senaryosu şemaları.
 *
 * İKİ ŞEMA vardır ve ayrım güvenliğin TAŞIYICI unsurudur (YF-702/YF-704 ile
 * aynı desen):
 *
 * 1. `cashFlowScenarioModelResponseSchema` — modelin üretmesi GEREKEN şekil.
 *    İçinde TEK BİR sayısal, parasal, tarihsel, oransal veya önem derecesi
 *    alanı YOKTUR. Model yalnızca (a) serbest metin ve (b) sunucunun ÖNCEDEN
 *    verdiği anahtarlara (`scenarioKey`, `driverId`) atıf üretebilir.
 *    Dolayısıyla çıktısı şemadan geçse bile bir tutarı, bir yüzdeyi, bir
 *    kırılma tarihini veya bir önem derecesini DEĞİŞTİREMEZ.
 *
 * 2. `cashFlowScenarioSchema` — uç kullanıcıya dönen NİHAİ şekil. Buradaki
 *    her sayı/tarih, deterministik motorun (`cash-flow-scenario-math.ts`)
 *    ürettiği olgu paketinden sunucu tarafında KOPYALANIR; modelden asla
 *    alınmaz.
 *
 * Modelin ürettiği anahtar bilinmiyorsa (uydurulmuşsa) sessizce DÜŞÜRÜLÜR —
 * bkz. server/services/cash-flow-scenario-service.ts `mergeScenarioNarrative`.
 */

export const cashScenarioEnum = z.enum(["BASE", "RISK", "OPTIMISTIC"]);
export const cashScenarioHorizonEnum = z.union([z.literal(30), z.literal(60), z.literal(90)]);

/** MODEL ÇIKTISI — sıfır sayısal alan. */
export const cashFlowScenarioModelResponseSchema = z.object({
  headline: z.string().min(1).max(160),
  overview: z.string().min(1).max(900),
  scenarioObservations: z
    .array(
      z.object({
        scenarioKey: cashScenarioEnum,
        comment: z.string().min(1).max(300),
      }),
    )
    .max(6),
  riskDriverReferences: z
    .array(
      z.object({
        driverId: z.string().min(1).max(160),
        comment: z.string().min(1).max(300),
      }),
    )
    .max(6),
  recommendedActions: z.array(z.string().min(1).max(300)).max(5),
});
export type CashFlowScenarioModelResponse = z.infer<typeof cashFlowScenarioModelResponseSchema>;

export const cashScenarioMinimumPointSchema = z.object({
  dayIndex: z.number().int(),
  date: z.string(),
  amount: z.string(),
  isOpeningPoint: z.boolean(),
});

export const cashScenarioAssumptionSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
});

export const cashScenarioCellSchema = z.object({
  scenario: cashScenarioEnum,
  horizonDays: cashScenarioHorizonEnum,
  windowStart: z.string(),
  windowEnd: z.string(),
  /** Yarı açık pencerenin SON DAHİL gününü gösteren Türkçe etiket. */
  windowLabel: z.string().min(1),
  openingCash: z.string().nullable(),
  expectedCollections: z.string(),
  expectedPayments: z.string(),
  netChange: z.string(),
  endingCash: z.string().nullable(),
  minimumCashPoint: cashScenarioMinimumPointSchema.nullable(),
  breakDayIndex: z.number().int().nullable(),
  breakDate: z.string().nullable(),
  willBreak: z.boolean(),
  alreadyNegativeAtOpening: z.boolean(),
  overdueReceivableIncluded: z.string(),
  overduePayableIncluded: z.string(),
  assumptions: z.array(cashScenarioAssumptionSchema),
  /** Modelin bu senaryo hakkındaki yorumu; AI yoksa `null`. */
  aiComment: z.string().nullable(),
});
export type CashScenarioCellDto = z.infer<typeof cashScenarioCellSchema>;

export const cashScenarioEvidenceValueSchema = z.object({
  label: z.string().min(1),
  value: z.string(),
  kind: z.enum(["MONEY", "PERCENT", "PERCENTAGE_POINT", "TEXT"]),
});

export const cashScenarioDriverSchema = z.object({
  id: z.string().min(1),
  type: z.string().min(1),
  severity: insightSeverityEnum,
  scenario: cashScenarioEnum,
  horizonDays: cashScenarioHorizonEnum,
  title: z.string().min(1),
  evidence: z.array(cashScenarioEvidenceValueSchema),
  /** Modelin bu sürücü hakkındaki yorumu; AI yoksa `null`. */
  aiComment: z.string().nullable(),
});
export type CashScenarioDriverDto = z.infer<typeof cashScenarioDriverSchema>;

export const cashScenarioCoverageGapSchema = z.object({
  section: z.string().min(1),
  reason: z.string().min(1),
});

export const cashFlowScenarioSchema = z.object({
  /** Aktörün veri kapsamı. */
  actorScope: z.enum(["ORGANIZATION", "PROJECT_MANAGER"]),
  projectId: z.string().nullable(),
  projectName: z.string().nullable(),
  /**
   * Nakit çapalı alanlar (açılış/kapanış/minimum/kırılma) üretilebildi mi.
   * `false` ise bunlar TİP düzeyinde değil, DEĞER düzeyinde `null`'dır ve
   * `cashUnavailableReason` nedeni taşır.
   */
  cashVisibility: z.boolean(),
  cashUnavailableReason: z
    .enum(["PROJECT_MANAGER_NO_CASH_VISIBILITY", "PROJECT_FILTER_SCOPED"])
    .nullable(),
  generatedAt: z.string(),
  cells: z.array(cashScenarioCellSchema),
  drivers: z.array(cashScenarioDriverSchema),
  headline: z.string().min(1),
  overview: z.string().min(1),
  recommendedActions: z.array(z.string().min(1)).max(3),
  dataCoverage: z.array(cashScenarioCoverageGapSchema),
  /** Vade tarihli açık kayıt yoksa `true` — bu durumda sağlayıcı HİÇ çağrılmaz. */
  isEmptyForecast: z.boolean(),
  driverCount: z.number().int().nonnegative(),
  /** Metin AI'dan mı geldi yoksa deterministik yedekten mi — UI her zaman ayrı işaretler. */
  isAiGenerated: z.boolean(),
});
export type CashFlowScenarioResult = z.infer<typeof cashFlowScenarioSchema>;
