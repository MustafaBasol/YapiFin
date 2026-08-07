"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireRole } from "@/lib/auth/guard";
import { createCustomerSchema, updateCustomerSchema, customerIdSchema } from "@/lib/validation/customer";
import {
  createCustomer,
  updateCustomer,
  archiveCustomer,
  reactivateCustomer,
} from "@/server/services/customer-service";
import type { ActionState } from "@/lib/action-state";
import { toActionError } from "@/lib/action-error";

export async function createCustomerAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const actor = await requireRole(["OWNER", "ADMIN"]);
  const parsed = createCustomerSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Form geçersiz" };
  }

  let customerId: string;
  try {
    const customer = await createCustomer(actor, parsed.data);
    customerId = customer.id;
  } catch (err) {
    return toActionError(err);
  }
  revalidatePath("/customers");
  redirect(`/customers/${customerId}`);
}

export async function updateCustomerAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const actor = await requireRole(["OWNER", "ADMIN"]);
  const parsed = updateCustomerSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Form geçersiz" };
  }
  try {
    await updateCustomer(actor, parsed.data);
  } catch (err) {
    return toActionError(err);
  }
  revalidatePath(`/customers/${parsed.data.id}`);
  revalidatePath("/customers");
  redirect(`/customers/${parsed.data.id}`);
}

export async function archiveCustomerAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const actor = await requireRole(["OWNER", "ADMIN"]);
  const parsed = customerIdSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: "Form geçersiz" };
  try {
    await archiveCustomer(actor, parsed.data.id);
  } catch (err) {
    return toActionError(err);
  }
  revalidatePath(`/customers/${parsed.data.id}`);
  revalidatePath("/customers");
  return { success: "Müşteri arşivlendi." };
}

export async function reactivateCustomerAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const actor = await requireRole(["OWNER", "ADMIN"]);
  const parsed = customerIdSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: "Form geçersiz" };
  try {
    await reactivateCustomer(actor, parsed.data.id);
  } catch (err) {
    return toActionError(err);
  }
  revalidatePath(`/customers/${parsed.data.id}`);
  revalidatePath("/customers");
  return { success: "Müşteri yeniden etkinleştirildi." };
}
