"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireRole } from "@/lib/auth/guard";
import { createAccountSchema, updateAccountSchema, accountIdSchema } from "@/lib/validation/account";
import { createAccount, updateAccount, archiveAccount, reactivateAccount } from "@/server/services/account-service";
import { toActionError, type ActionState } from "@/lib/action-state";

const FINANCE_ROLES = ["OWNER", "ADMIN", "FINANCE"] as const;

export async function createAccountAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const actor = await requireRole([...FINANCE_ROLES]);
  const parsed = createAccountSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Form geçersiz" };

  let accountId: string;
  try {
    const account = await createAccount(actor, parsed.data);
    accountId = account.id;
  } catch (err) {
    return toActionError(err);
  }
  revalidatePath("/accounts");
  redirect(`/accounts/${accountId}`);
}

export async function updateAccountAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const actor = await requireRole([...FINANCE_ROLES]);
  const parsed = updateAccountSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Form geçersiz" };
  try {
    await updateAccount(actor, parsed.data);
  } catch (err) {
    return toActionError(err);
  }
  revalidatePath(`/accounts/${parsed.data.id}`);
  revalidatePath("/accounts");
  redirect(`/accounts/${parsed.data.id}`);
}

export async function archiveAccountAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const actor = await requireRole([...FINANCE_ROLES]);
  const parsed = accountIdSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: "Form geçersiz" };
  try {
    await archiveAccount(actor, parsed.data.id);
  } catch (err) {
    return toActionError(err);
  }
  revalidatePath(`/accounts/${parsed.data.id}`);
  revalidatePath("/accounts");
  return { success: "Hesap arşivlendi." };
}

export async function reactivateAccountAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const actor = await requireRole([...FINANCE_ROLES]);
  const parsed = accountIdSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: "Form geçersiz" };
  try {
    await reactivateAccount(actor, parsed.data.id);
  } catch (err) {
    return toActionError(err);
  }
  revalidatePath(`/accounts/${parsed.data.id}`);
  revalidatePath("/accounts");
  return { success: "Hesap yeniden etkinleştirildi." };
}
