"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireRole } from "@/lib/auth/guard";
import { createTransferSchema, cancelTransferSchema } from "@/lib/validation/transfer";
import { createTransfer, cancelTransfer } from "@/server/services/transfer-service";
import type { ActionState } from "@/lib/action-state";
import { toActionError } from "@/lib/action-error";

const FINANCE_ROLES = ["OWNER", "ADMIN", "FINANCE"] as const;

export async function createTransferAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const actor = await requireRole([...FINANCE_ROLES]);
  const parsed = createTransferSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Form geçersiz" };

  let transferId: string;
  try {
    const transfer = await createTransfer(actor, parsed.data);
    transferId = transfer.id;
  } catch (err) {
    return toActionError(err);
  }
  revalidatePath("/accounts");
  redirect(`/accounts/transfers/${transferId}`);
}

export async function cancelTransferAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const actor = await requireRole([...FINANCE_ROLES]);
  const parsed = cancelTransferSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Form geçersiz" };
  try {
    await cancelTransfer(actor, parsed.data);
  } catch (err) {
    return toActionError(err);
  }
  revalidatePath(`/accounts/transfers/${parsed.data.id}`);
  revalidatePath("/accounts");
  return { success: "Transfer iptal edildi." };
}
