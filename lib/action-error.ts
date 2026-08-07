import { captureException } from "@/lib/monitoring";
import type { ActionState } from "@/lib/action-state";

/**
 * Servis katmanı ServiceError'larını, formda gösterilecek Türkçe metne
 * çevirir. Bilinen (`ServiceError`) olmayan dal, tüm server action'lardaki
 * BEKLENMEYEN istisnalar için tek, merkezi bir yakalama noktasıdır (bkz.
 * docs/PRODUCTION_READINESS.md §8 — bu satır zaten "iyi bir enjeksiyon
 * noktası" olarak işaretlenmişti); her action'ı ayrı ayrı sarmalamak yerine
 * burada tek bir `captureException` çağrısı tüm action'ları kapsar.
 *
 * `lib/action-state.ts`'ten BİLİNÇLİ olarak AYRI bir dosyadadır: o dosya
 * `initialActionState` üzerinden client component'lerce de import edilir
 * (ör. `components/auth/login-form.tsx`) — `@/lib/monitoring` (`@sentry/node`,
 * `worker_threads` kullanır) oraya sızarsa client bundle derlemesi kırılır.
 * Bu dosya yalnızca `"use server"` action modüllerinden import edilmelidir.
 */
export function toActionError(err: unknown): ActionState {
  if (err && typeof err === "object" && "message" in err && "code" in err) {
    return { error: (err as { message: string }).message };
  }
  captureException(err);
  console.error(err);
  return { error: "Beklenmeyen bir hata oluştu. Lütfen tekrar deneyin." };
}
