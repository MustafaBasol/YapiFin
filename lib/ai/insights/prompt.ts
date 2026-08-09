import { definePromptTemplate } from "@/lib/ai/prompt";
import type { AiMessage } from "@/lib/ai/types";
import type { InsightType, InsightSeverity } from "@/lib/ai/insights/schema";

export interface AiInsightPromptSignal {
  id: string;
  type: InsightType;
  severity: InsightSeverity;
  affectedProjectName: string | null;
  /** Önceden hesaplanmış, değiştirilemez Türkçe olgu cümlesi — bkz. ai-insights-service.ts extractFinancialSignals. */
  facts: string;
}

export interface AiInsightPromptVars {
  organizationName: string;
  signals: AiInsightPromptSignal[];
}

const SYSTEM_PROMPT = `Sen YapiFin uygulamasında bir finansal analiz asistanısın. Sana verilen sinyaller
zaten hesaplanmış, KESİN finansal olgulardır — bunları ASLA değiştirme, yeniden hesaplama veya
yeni bir sayı UYDURMA. Görevin yalnızca: her sinyali kısaca Türkçe olarak açıklamak, iş sahibinin
anlayacağı şekilde özetlemek ve somut bir aksiyon önerisi sunmaktır.

Kurallar:
- Yalnızca sana verilen sinyalleri yorumla; verilmeyen bir konu hakkında ASLA yorum üretme.
- Hiçbir tutar, yüzde veya tarih UYDURMA — yalnızca sinyalin "facts" alanında sağlanan bilgiyi
  kullan, gerekirse ondan alıntı yap.
- Yanıtın SADECE geçerli JSON olmalı, şu şekle uymalı:
  {"insights":[{"signalId":"...","title":"...","explanation":"...","suggestedAction":"..."}]}
- "title": en fazla 100 karakter, kısa ve net.
- "explanation": 1-3 cümle, Türkçe, sinyalin neden önemli olduğunu açıklar.
- "suggestedAction": kısa, somut, uygulanabilir bir öneri (Türkçe).
- Her sinyal için tam olarak bir yanıt üret; sinyalId'leri değiştirme.
- JSON dışında hiçbir metin (açıklama, markdown, kod bloğu işareti) YAZMA.`;

function renderUserMessage(vars: AiInsightPromptVars): string {
  const lines = vars.signals.map((s) => {
    const project = s.affectedProjectName ? ` (proje: ${s.affectedProjectName})` : "";
    return `- id="${s.id}" tür=${s.type} önem=${s.severity}${project}: ${s.facts}`;
  });
  return `Firma: ${vars.organizationName}\n\nAşağıdaki finansal sinyaller için JSON yanıtı üret:\n${lines.join("\n")}`;
}

export const aiInsightsPromptTemplate = definePromptTemplate<AiInsightPromptVars>({
  id: "ai-insights",
  version: "v1",
  render(vars: AiInsightPromptVars): AiMessage[] {
    return [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: renderUserMessage(vars) },
    ];
  },
});
