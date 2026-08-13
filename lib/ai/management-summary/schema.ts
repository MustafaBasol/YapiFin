import { z } from "zod";
import { evidenceValueKindEnum, insightEvidenceSchema, insightSeverityEnum, insightTypeEnum } from "@/lib/ai/insights/schema";

/**
 * YF-704 — AI Yönetim Özeti (haftalık) şeması.
 *
 * YF-702 ile AYNI iki-şema ayrımı uygulanır ve bu ayrım bu modülün TEK
 * güvenlik mekanizmasıdır:
 *
 * - `managementSummaryModelResponseSchema`: modelin üretmesi GEREKEN dar
 *   JSON şekli. Yalnızca serbest METİN alanları ve önceden verilmiş
 *   anahtarlara (`metricKey`/`signalId`) YAPILAN ATIFLAR içerir. Tek bir
 *   sayısal/parasal/tarihsel alan YOKTUR — dolayısıyla model, çıktısı
 *   şemadan geçse bile bir tutarı, yüzdeyi, dönemi veya önem derecesini
 *   DEĞİŞTİREMEZ; en fazla bir cümleyi kötü yazabilir.
 * - `managementSummarySchema`: uç kullanıcıya dönen NİHAİ şekil. Buradaki
 *   her sayı, etiket, dönem, proje kimliği ve önem derecesi deterministik
 *   olgu paketinden (`ManagementSummaryFacts`) KOPYALANIR — model
 *   çıktısından asla türetilmez (bkz. server/services/management-summary-service.ts).
 *
 * Ayrıca bu şekil, bugünkü uygulama içi kart için olduğu kadar İLERİDE
 * eklenecek e-posta/bildirim gönderimi için de yeterlidir: dönem sınırları
 * hem makine-okunur ISO (`periodStart`/`periodEnd`) hem de kullanıcıya
 * gösterilebilir Türkçe etiket (`periodLabel`) olarak taşınır ve `headline`
 * tek satırlık bir konu başlığı olacak kadar kısadır. (Gönderim mekanizması
 * YF-704 kapsamında DEĞİLDİR — yalnızca yeniden kullanılabilir çıktı
 * sözleşmesi hazırlanır.)
 */

export const managementSummaryScopeEnum = z.enum(["ORGANIZATION", "PROJECT"]);
export type ManagementSummaryScope = z.infer<typeof managementSummaryScopeEnum>;

/**
 * Özetin taşıdığı deterministik ölçülerin KARARLI anahtarları. Model bir
 * değişimi yorumlarken yalnızca bu anahtarlardan birine atıfta bulunabilir;
 * tanımadığımız bir anahtar sessizce DÜŞÜRÜLÜR (uydurulmuş bir ölçü nihai
 * çıktıya giremez).
 */
export const managementSummaryMetricKeyEnum = z.enum([
  "cashOpeningBalance",
  "cashProjectedClosingBalance",
  "collections",
  "payments",
  "netSettlement",
  "revenue",
  "expense",
  "profit",
  "margin",
  "budgetTotal",
  "budgetRealizedExpenses",
  "budgetRemaining",
  "budgetUsagePercentage",
  "overdueReceivable",
  "overduePayable",
]);
export type ManagementSummaryMetricKey = z.infer<typeof managementSummaryMetricKeyEnum>;

/** Değişim yönü — `change` alanının işaretinden deterministik olarak türetilir. */
export const metricDirectionEnum = z.enum(["UP", "DOWN", "FLAT"]);
export type MetricDirection = z.infer<typeof metricDirectionEnum>;

/**
 * Bu ölçü için hangi yönün İYİ olduğu. Sunum katmanı (kart rengi, e-posta
 * şablonu) rengi bu iki alandan türetir; "artış iyi mi kötü mü" kararı her
 * tüketicide yeniden verilmez. `NONE`, yönün tek başına iyi/kötü anlamı
 * taşımadığı ölçüler içindir (ör. ödeme tutarı: artması hem yatırım hem
 * baskı olabilir).
 */
export const favorableDirectionEnum = z.enum(["UP", "DOWN", "NONE"]);
export type FavorableDirection = z.infer<typeof favorableDirectionEnum>;

/**
 * Tek bir deterministik ölçü. Tüm parasal/oransal değerler BİÇİMLENDİRİLMEMİŞ
 * Decimal string'dir (bkz. lib/ai/insights/schema.ts `evidenceValueKindEnum`);
 * ₺/%/tr-TR ayraçları yalnızca sunum katmanının işidir.
 */
export const managementSummaryMetricSchema = z.object({
  key: managementSummaryMetricKeyEnum,
  /** Kullanıcıya gösterilebilir Türkçe etiket — arayüze ham anahtar adı sızmaz. */
  label: z.string().min(1),
  value: z.string().min(1),
  kind: evidenceValueKindEnum,
  /** Önceki dönemin değeri. Ölçü dönemsel DEĞİLSE (anlık bakiye/bütçe durumu) `null` — uydurulmaz. */
  previousValue: z.string().nullable(),
  /** `value − previousValue`. Karşılaştırma yoksa `null`. */
  change: z.string().nullable(),
  /** Değişimin gösterim türü; yüzde olan bir ölçünün farkı PERCENTAGE_POINT'tir (bkz. YF-702-F3). */
  changeKind: evidenceValueKindEnum.nullable(),
  direction: metricDirectionEnum.nullable(),
  favorableDirection: favorableDirectionEnum,
});
export type ManagementSummaryMetric = z.infer<typeof managementSummaryMetricSchema>;

/** Öne çıkarılan bir değişim: deterministik ölçünün kendisi + AI'nin tek cümlelik yorumu. */
export const managementSummaryChangeSchema = z.object({
  metric: managementSummaryMetricSchema,
  /** AI yorumu; model yanıt vermediyse deterministik yedek cümle. */
  comment: z.string().min(1),
});
export type ManagementSummaryChange = z.infer<typeof managementSummaryChangeSchema>;

/**
 * Öne çıkarılan bir risk. Alanların TAMAMI kanonik kural motorunun
 * (`runInsightRules`) ürettiği deterministik sinyalden kopyalanır; yalnızca
 * `comment` AI kaynaklıdır.
 */
export const managementSummaryRiskSchema = z.object({
  signalId: z.string().min(1),
  type: insightTypeEnum,
  severity: insightSeverityEnum,
  affectedProjectId: z.string().nullable(),
  affectedProjectName: z.string().nullable(),
  evidence: insightEvidenceSchema,
  comment: z.string().min(1),
});
export type ManagementSummaryRisk = z.infer<typeof managementSummaryRiskSchema>;

/**
 * Bu özette KAPSANAMAYAN bölümler ve nedenleri. "Veri yok" ile "bu rolde
 * gösterilmiyor" birbirine karışmasın diye açıkça taşınır; boş bir bölüm
 * sessizce sıfır gibi gösterilmez.
 */
export const managementSummaryCoverageGapSchema = z.object({
  section: z.string().min(1),
  reason: z.string().min(1),
});
export type ManagementSummaryCoverageGap = z.infer<typeof managementSummaryCoverageGapSchema>;

/**
 * Modelin üretmesi GEREKEN JSON şekli — yalnızca metin ve önceden verilmiş
 * anahtarlara atıf. Hiçbir sayısal/parasal/tarihsel/önem alanı YOKTUR.
 */
export const managementSummaryModelResponseSchema = z.object({
  headline: z.string().min(1).max(160),
  overview: z.string().min(1).max(900),
  topChanges: z
    .array(
      z.object({
        metricKey: managementSummaryMetricKeyEnum,
        comment: z.string().min(1).max(300),
      }),
    )
    .max(10),
  topRisks: z
    .array(
      z.object({
        signalId: z.string().min(1).max(120),
        comment: z.string().min(1).max(300),
      }),
    )
    .max(10),
  recommendedActions: z.array(z.string().min(1).max(300)).max(5),
});
export type ManagementSummaryModelResponse = z.infer<typeof managementSummaryModelResponseSchema>;

/** Uç kullanıcıya dönen NİHAİ, doğrulanmış yönetim özeti. */
export const managementSummarySchema = z.object({
  scope: managementSummaryScopeEnum,
  /** Aktörün veri kapsamı — organizasyon geneli mi, yalnızca atanmış projeler mi. */
  actorScope: z.enum(["ORGANIZATION", "PROJECT_MANAGER"]),
  projectId: z.string().nullable(),
  projectName: z.string().nullable(),
  /** Dönem sınırları: ISO (makine) + Türkçe etiket (sunum). Aralık YARI AÇIKtır; etiket son GÜNÜ içerir. */
  periodStart: z.string(),
  periodEnd: z.string(),
  periodLabel: z.string().min(1),
  previousPeriodStart: z.string(),
  previousPeriodEnd: z.string(),
  previousPeriodLabel: z.string().min(1),
  headline: z.string().min(1),
  overview: z.string().min(1),
  /** Dönemin TÜM deterministik ölçüleri — `topChanges` bunların bir alt kümesini öne çıkarır. */
  metrics: z.array(managementSummaryMetricSchema),
  topChanges: z.array(managementSummaryChangeSchema).max(3),
  topRisks: z.array(managementSummaryRiskSchema).max(3),
  recommendedActions: z.array(z.string().min(1)).max(3),
  dataCoverage: z.array(managementSummaryCoverageGapSchema),
  /** Kural motorunun ürettiği TOPLAM sinyal sayısı (`topRisks` en fazla 3 tanesini taşır). */
  signalCount: z.number().int().nonnegative(),
  /** Dönemde hiç finansal hareket yoksa `true` — bu durumda sağlayıcı HİÇ çağrılmaz. */
  isEmptyPeriod: z.boolean(),
  generatedAt: z.string(),
  /** Metinler AI'dan mı geldi yoksa deterministik yedekten mi — UI bunu her zaman ayrı işaretlemelidir. */
  isAiGenerated: z.boolean(),
});
export type ManagementSummary = z.infer<typeof managementSummarySchema>;
