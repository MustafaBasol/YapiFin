export interface ActionState {
  error?: string;
  success?: string;
}

export const initialActionState: ActionState = {};

/** Servis katmanı ServiceError'larını, formda gösterilecek Türkçe metne çevirir. */
export function toActionError(err: unknown): ActionState {
  if (err && typeof err === "object" && "message" in err && "code" in err) {
    return { error: (err as { message: string }).message };
  }
  console.error(err);
  return { error: "Beklenmeyen bir hata oluştu. Lütfen tekrar deneyin." };
}
