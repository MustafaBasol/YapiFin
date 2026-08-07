"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireRole } from "@/lib/auth/guard";
import { createExpenseSchema, updateExpenseSchema, cancelTransactionSchema } from "@/lib/validation/transaction";
import { createExpense, updateExpense, cancelExpense } from "@/server/services/transaction-service";
import type { ActionState } from "@/lib/action-state";
import { toActionError } from "@/lib/action-error";

const FINANCE_ROLES = ["OWNER", "ADMIN", "FINANCE"] as const;

export async function createExpenseAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const actor = await requireRole(["OWNER", "ADMIN", "FINANCE", "PROJECT_MANAGER"]);
  const parsed = createExpenseSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Form geçersiz" };

  let id: string;
  try {
    const record = await createExpense(actor, parsed.data);
    id = record.id;
  } catch (err) {
    return toActionError(err);
  }
  revalidatePath("/expenses");
  redirect(`/expenses/${id}`);
}

export async function updateExpenseAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const actor = await requireRole([...FINANCE_ROLES]);
  const parsed = updateExpenseSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Form geçersiz" };
  try {
    await updateExpense(actor, parsed.data);
  } catch (err) {
    return toActionError(err);
  }
  revalidatePath(`/expenses/${parsed.data.id}`);
  revalidatePath("/expenses");
  redirect(`/expenses/${parsed.data.id}`);
}

export async function cancelExpenseAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const actor = await requireRole([...FINANCE_ROLES]);
  const parsed = cancelTransactionSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Form geçersiz" };
  try {
    await cancelExpense(actor, parsed.data);
  } catch (err) {
    return toActionError(err);
  }
  revalidatePath(`/expenses/${parsed.data.id}`);
  revalidatePath("/expenses");
  return { success: "Gider kaydı iptal edildi." };
}
