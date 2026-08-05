"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireRole } from "@/lib/auth/guard";
import { createSupplierSchema, updateSupplierSchema, supplierIdSchema } from "@/lib/validation/supplier";
import {
  createSupplier,
  updateSupplier,
  archiveSupplier,
  reactivateSupplier,
} from "@/server/services/supplier-service";
import { toActionError, type ActionState } from "@/lib/action-state";

export async function createSupplierAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const actor = await requireRole(["OWNER", "ADMIN"]);
  const parsed = createSupplierSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Form geçersiz" };
  }

  let supplierId: string;
  try {
    const supplier = await createSupplier(actor, parsed.data);
    supplierId = supplier.id;
  } catch (err) {
    return toActionError(err);
  }
  revalidatePath("/suppliers");
  redirect(`/suppliers/${supplierId}`);
}

export async function updateSupplierAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const actor = await requireRole(["OWNER", "ADMIN"]);
  const parsed = updateSupplierSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Form geçersiz" };
  }
  try {
    await updateSupplier(actor, parsed.data);
  } catch (err) {
    return toActionError(err);
  }
  revalidatePath(`/suppliers/${parsed.data.id}`);
  revalidatePath("/suppliers");
  redirect(`/suppliers/${parsed.data.id}`);
}

export async function archiveSupplierAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const actor = await requireRole(["OWNER", "ADMIN"]);
  const parsed = supplierIdSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: "Form geçersiz" };
  try {
    await archiveSupplier(actor, parsed.data.id);
  } catch (err) {
    return toActionError(err);
  }
  revalidatePath(`/suppliers/${parsed.data.id}`);
  revalidatePath("/suppliers");
  return { success: "Tedarikçi arşivlendi." };
}

export async function reactivateSupplierAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const actor = await requireRole(["OWNER", "ADMIN"]);
  const parsed = supplierIdSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: "Form geçersiz" };
  try {
    await reactivateSupplier(actor, parsed.data.id);
  } catch (err) {
    return toActionError(err);
  }
  revalidatePath(`/suppliers/${parsed.data.id}`);
  revalidatePath("/suppliers");
  return { success: "Tedarikçi yeniden etkinleştirildi." };
}
