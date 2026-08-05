"use server";

import { revalidatePath } from "next/cache";
import { requireRole } from "@/lib/auth/guard";
import { createSettlementSchema, cancelSettlementSchema } from "@/lib/validation/settlement";
import { createSettlement, cancelSettlement } from "@/server/services/settlement-service";
import { toActionError, type ActionState } from "@/lib/action-state";

const FINANCE_ROLES = ["OWNER", "ADMIN", "FINANCE"] as const;

function revalidateForTransaction(transactionType: "INCOME" | "EXPENSE", transactionId: string) {
  const base = transactionType === "INCOME" ? "/income" : "/expenses";
  revalidatePath(`${base}/${transactionId}`);
  revalidatePath(base);
  revalidatePath("/accounts");
}

export async function createSettlementAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const actor = await requireRole([...FINANCE_ROLES]);
  const parsed = createSettlementSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Form geçersiz" };

  const transactionType = String(formData.get("transactionType") ?? "");
  try {
    await createSettlement(actor, parsed.data);
  } catch (err) {
    return toActionError(err);
  }
  if (transactionType === "INCOME" || transactionType === "EXPENSE") {
    revalidateForTransaction(transactionType, parsed.data.transactionId);
  }
  return { success: transactionType === "EXPENSE" ? "Ödeme kaydedildi." : "Tahsilat kaydedildi." };
}

export async function cancelSettlementAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const actor = await requireRole([...FINANCE_ROLES]);
  const parsed = cancelSettlementSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Form geçersiz" };

  const transactionType = String(formData.get("transactionType") ?? "");
  const transactionId = String(formData.get("transactionId") ?? "");
  try {
    await cancelSettlement(actor, parsed.data);
  } catch (err) {
    return toActionError(err);
  }
  if (transactionType === "INCOME" || transactionType === "EXPENSE") {
    revalidateForTransaction(transactionType, transactionId);
  }
  return { success: "Hareket iptal edildi." };
}
