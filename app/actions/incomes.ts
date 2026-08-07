"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireRole } from "@/lib/auth/guard";
import { createIncomeSchema, updateIncomeSchema, cancelTransactionSchema } from "@/lib/validation/transaction";
import { createIncome, updateIncome, cancelIncome } from "@/server/services/transaction-service";
import type { ActionState } from "@/lib/action-state";
import { toActionError } from "@/lib/action-error";

const FINANCE_ROLES = ["OWNER", "ADMIN", "FINANCE"] as const;

export async function createIncomeAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const actor = await requireRole([...FINANCE_ROLES]);
  const parsed = createIncomeSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Form geçersiz" };

  let id: string;
  try {
    const record = await createIncome(actor, parsed.data);
    id = record.id;
  } catch (err) {
    return toActionError(err);
  }
  revalidatePath("/income");
  redirect(`/income/${id}`);
}

export async function updateIncomeAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const actor = await requireRole([...FINANCE_ROLES]);
  const parsed = updateIncomeSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Form geçersiz" };
  try {
    await updateIncome(actor, parsed.data);
  } catch (err) {
    return toActionError(err);
  }
  revalidatePath(`/income/${parsed.data.id}`);
  revalidatePath("/income");
  redirect(`/income/${parsed.data.id}`);
}

export async function cancelIncomeAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const actor = await requireRole([...FINANCE_ROLES]);
  const parsed = cancelTransactionSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Form geçersiz" };
  try {
    await cancelIncome(actor, parsed.data);
  } catch (err) {
    return toActionError(err);
  }
  revalidatePath(`/income/${parsed.data.id}`);
  revalidatePath("/income");
  return { success: "Gelir kaydı iptal edildi." };
}
