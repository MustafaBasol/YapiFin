import type { EvidenceValue, InsightEvidence } from "@/lib/ai/insights/schema";

/**
 * YF-702 — Yapılandırılmış kanıt (evidence) oluşturucuları.
 *
 * Kural gövdelerinin `{ label, value, kind }` nesnesini elle yazmasını
 * engeller; her kanıt alanının Türkçe bir etiket ve açık bir gösterim türü
 * taşımasını TİP düzeyinde zorunlu kılar.
 *
 * Değerler biçimlendirilmez — ham Decimal string olarak korunur (bkz.
 * lib/ai/insights/schema.ts `evidenceValueKindEnum` doküman notu).
 */

export function money(label: string, value: string): EvidenceValue {
  return { label, value, kind: "MONEY" };
}

export function percent(label: string, value: string): EvidenceValue {
  return { label, value, kind: "PERCENT" };
}

export function text(label: string, value: string): EvidenceValue {
  return { label, value, kind: "TEXT" };
}

/**
 * Kısmi bir kanıt tanımını tam `InsightEvidence` şekline tamamlar —
 * belirtilmeyen karşılaştırma alanları `null` olur (uydurulmaz),
 * `details` varsayılan olarak boş dizidir.
 */
export function buildEvidence(input: Partial<InsightEvidence>): InsightEvidence {
  return {
    currentValue: input.currentValue ?? null,
    comparisonValue: input.comparisonValue ?? null,
    difference: input.difference ?? null,
    percentageChange: input.percentageChange ?? null,
    period: input.period ?? null,
    details: input.details ?? [],
  };
}
