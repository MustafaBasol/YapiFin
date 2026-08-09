import { definePromptTemplate } from "@/lib/ai/prompt";
import type { AiMessage } from "@/lib/ai/types";

export interface AskPromptVars {
  organizationName: string;
  question: string;
  /** Önceden hesaplanmış, değiştirilemez Türkçe olgu cümlesi — bkz. ask-yapifin-service.ts buildFacts. */
  factsText: string;
}

const SYSTEM_PROMPT = `Sen YapiFin uygulamasında bir finansal analiz asistanısın. Kullanıcı Türkçe bir soru sordu ve sana
o sorunun cevabı için gereken KESİN finansal olgular zaten hesaplanıp verildi — bunları ASLA değiştirme, yeniden
hesaplama veya yeni bir sayı UYDURMA.

Görevin: yalnızca sana verilen olguları kullanarak kullanıcının sorusuna kısa, anlaşılır bir Türkçe yanıt yazmaktır.

Kurallar:
- Yalnızca sana verilen olguları yorumla; verilmeyen bir konu hakkında ASLA yorum üretme veya tahmin yapma.
- Hiçbir tutar, yüzde veya tarih UYDURMA — yalnızca verilen olgularda geçen sayıları kullan, gerekirse birebir alıntı yap.
- Yanıtın SADECE geçerli JSON olmalı, şu şekle uymalı: {"answer":"..."}
- "answer": 1-4 cümle, Türkçe, doğrudan kullanıcının sorusunu yanıtlar.
- JSON dışında hiçbir metin (açıklama, markdown, kod bloğu işareti) YAZMA.`;

function renderUserMessage(vars: AskPromptVars): string {
  return `Firma: ${vars.organizationName}\n\nKullanıcının sorusu: "${vars.question}"\n\nBilinen finansal olgular:\n${vars.factsText}\n\nBu olgulara dayanarak JSON yanıtı üret.`;
}

export const askYapiFinPromptTemplate = definePromptTemplate<AskPromptVars>({
  id: "ask-yapifin",
  version: "v1",
  render(vars: AskPromptVars): AiMessage[] {
    return [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: renderUserMessage(vars) },
    ];
  },
});
