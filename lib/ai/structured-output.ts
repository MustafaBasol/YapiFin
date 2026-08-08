import type { z } from "zod";

/**
 * YF-701 — LLM metin çıktısı asla güvenilir/serbest JSON olarak kabul
 * edilmez. Bu fonksiyon çağıranın açıkça sağladığı bir Zod şemasına göre
 * ayrıştırır ve doğrular; ayrıştırma veya doğrulama başarısız olursa (bozuk
 * JSON, eksik/yanlış tipte alan, model "uydurma" bir alan eklemişse strict
 * şemalarla) ASLA fırlatmaz — güvenli, ayrık bir başarısızlık sonucu döner.
 * Çağıran taraf bu sonucu kullanıcıya sunmadan önce kendi iş kuralı
 * doğrulamasından (mevcut `lib/validation/*` şemaları) yine geçirmelidir.
 */
export type StructuredOutputResult<T> = { success: true; data: T } | { success: false; error: string };

export function parseStructuredOutput<T>(schema: z.ZodType<T>, raw: string): StructuredOutputResult<T> {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { success: false, error: "Model çıktısı geçerli JSON değil" };
  }

  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    return { success: false, error: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") };
  }
  return { success: true, data: parsed.data };
}
