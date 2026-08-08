import { randomUUID } from "crypto";

/** Tek bir AI isteğini uçtan uca (context oluşturma → sağlayıcı çağrısı → log) izlemek için opak kimlik. */
export function createAiCorrelationId(): string {
  return randomUUID();
}
