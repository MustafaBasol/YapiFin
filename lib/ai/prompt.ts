import type { AiMessage } from "@/lib/ai/types";

/**
 * YF-701 — Prompt/versiyon temsili. Gerçek uç kullanıcı AI özelliklerinin
 * (kapsam dışı, bkz. görev talimatı) kendi prompt şablonlarını bu tipe göre
 * tanımlaması beklenir. `version`, gözlemlenebilirlik (bkz. lib/ai/logging.ts)
 * ve gelecekte prompt A/B testi/rollback için taşınır — davranışı bu dosyada
 * DEĞİŞTİRMEZ, yalnızca meta veridir.
 */
export interface AiPromptTemplate<TVars> {
  id: string;
  version: string;
  render(vars: TVars): AiMessage[];
}

export function definePromptTemplate<TVars>(template: AiPromptTemplate<TVars>): AiPromptTemplate<TVars> {
  return template;
}
