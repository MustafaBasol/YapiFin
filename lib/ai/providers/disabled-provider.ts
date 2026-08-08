import type { AiProvider } from "@/lib/ai/provider";
import { AiError } from "@/lib/ai/errors";

/**
 * Varsayılan/üretim sağlayıcısı — `AI_PROVIDER` hiç ayarlanmamışsa (bkz.
 * lib/env.ts) kullanılır. `nullDocumentExtractionProvider` (YF-601) ile aynı
 * dürüstlük ilkesi: veri UYDURMAZ. OCR'dan farklı olarak "boş bir AI yanıtı"
 * anlamlı bir varsayılan değildir — bu yüzden burada fail-closed bir
 * `AiError` fırlatılır (kategori: "not_configured"), sessizce boş metin
 * DÖNMEZ.
 */
export function createDisabledAiProvider(): AiProvider {
  return {
    name: "disabled",
    async complete(request) {
      throw new AiError("AI sağlayıcısı yapılandırılmamış", "not_configured", request.correlationId);
    },
  };
}
