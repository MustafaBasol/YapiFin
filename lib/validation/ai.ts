import { z } from "zod";

/**
 * YF-701 — AI bağlam kaynağı allow-list'i. Bu liste `lib/ai/context/context-builder.ts`
 * tarafından desteklenen TEK kaynak kümesidir — genel/serbest bir sorgu
 * arayüzü DEĞİLDİR (bkz. görev talimatı "Do not create a generic unrestricted
 * database query layer"). Yeni bir kaynak eklemek istendiğinde hem bu enum
 * hem de context-builder.ts'deki switch birlikte güncellenmelidir.
 */
export const aiContextSourceEnum = z.enum([
  "PROJECT_SUMMARY",
  "BUDGET_VARIANCE",
  "CASH_FLOW",
  "RECEIVABLES_PAYABLES",
  "COMPANY_FINANCIAL_SUMMARY",
]);
export type AiContextSource = z.infer<typeof aiContextSourceEnum>;

/** Proje kapsamlı kaynaklar — bu kaynaklardan biri istenirse `projectId` zorunludur. */
export const PROJECT_SCOPED_AI_CONTEXT_SOURCES: ReadonlySet<AiContextSource> = new Set(["PROJECT_SUMMARY", "BUDGET_VARIANCE"]);

const emptyToUndefined = (v: unknown) => (v === "" || v == null ? undefined : v);

export const aiContextRequestSchema = z
  .object({
    sources: z.array(aiContextSourceEnum).min(1, "En az bir bağlam kaynağı seçilmelidir").max(aiContextSourceEnum.options.length),
    projectId: z.preprocess(emptyToUndefined, z.string().min(1).optional()),
  })
  .superRefine((data, ctx) => {
    const needsProject = data.sources.some((s) => PROJECT_SCOPED_AI_CONTEXT_SOURCES.has(s));
    if (needsProject && !data.projectId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["projectId"],
        message: "Seçilen bağlam kaynakları için projectId zorunludur",
      });
    }
  });
export type AiContextRequest = z.infer<typeof aiContextRequestSchema>;

/**
 * YF-703 — "YapiFin'e Sor" istek gövdesi. `question` serbest metindir ancak
 * yalnızca deterministik sınıflandırma (bkz. lib/ai/ask/classify.ts) için
 * kullanılır — hiçbir zaman doğrudan bir Prisma sorgusuna veya AI'ye
 * "araç/fonksiyon çağrısı" yetkisi olarak geçirilmez. Üst sınır (400), aşırı
 * uzun/kötüye kullanım amaçlı girdilerin gereksiz yere işlenmesini engeller.
 */
export const askYapiFinRequestSchema = z.object({
  question: z.string().trim().min(3, "Soru en az 3 karakter olmalıdır").max(400, "Soru en fazla 400 karakter olabilir"),
  idempotencyKey: z.string().min(1).max(200).optional(),
});
export type AskYapiFinRequest = z.infer<typeof askYapiFinRequestSchema>;
