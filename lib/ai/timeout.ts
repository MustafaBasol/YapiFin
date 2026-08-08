import { AiError } from "@/lib/ai/errors";

/**
 * Bir sağlayıcı çağrısını sabit bir süreyle sınırlar. Sağlayıcı zaman aşımına
 * uğrarsa (veya hiç yanıt vermezse) çağıran taraf sonsuza kadar beklemez —
 * kategorize edilmiş bir `AiError` fırlatılır (bkz. lib/ai/service.ts, bu
 * güvenli bir şekilde loglanır ve yukarı katmana yayılır).
 */
export async function withAiTimeout<T>(promise: Promise<T>, timeoutMs: number, correlationId: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new AiError(`AI isteği ${timeoutMs}ms içinde tamamlanmadı`, "timeout", correlationId));
    }, timeoutMs);
  });

  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer!);
  }
}
