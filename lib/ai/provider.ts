import type { AiCompletionRequest, AiCompletionResult } from "@/lib/ai/types";

/**
 * YF-701 — Sağlayıcıdan bağımsız (provider-neutral) AI tamamlama soyutlaması.
 *
 * `server/services/document-extraction/provider.ts` (YF-601) ile aynı tasarım
 * ilkesini izler: gerçek bir ücretli LLM sağlayıcısı (OpenAI/Anthropic/vb.)
 * için API anahtarı/kimlik bilgisi bu görev kapsamında EKLENMEZ. Bu arayüzü
 * uygulayan yeni bir sağlayıcı eklenmek istendiğinde tek yapılması gereken
 * `lib/ai/providers/` altına yeni bir modül yazıp `lib/ai/config.ts` içindeki
 * `AI_PROVIDER` seçenek kümesini genişletmektir — genel bir plugin/registry
 * çatısı gerekmez (bkz. görev talimatı "Do not create a generic unrestricted
 * database query layer" ile aynı ölçülü tasarım felsefesi).
 *
 * Bu arayüz kasıtlı olarak Prisma'dan, `SessionUser`'dan ve tenant kavramından
 * tamamen bağımsızdır — bir `AiProvider` implementasyonu asla veritabanına
 * erişmez, yalnızca `AiCompletionRequest` mesajlarını girdi olarak alır.
 */
export interface AiProvider {
  /** Gözlemlenebilirlik/log için sağlayıcı adı (ör. "disabled", "fake"). */
  readonly name: string;
  complete(request: AiCompletionRequest): Promise<AiCompletionResult>;
}
