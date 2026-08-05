"use server";

import { revalidatePath } from "next/cache";
import { requireRole } from "@/lib/auth/guard";
import { createCategorySchema, renameCategorySchema, categoryIdSchema } from "@/lib/validation/category";
import {
  createCategory,
  renameCategory,
  archiveCategory,
  reactivateCategory,
} from "@/server/services/category-service";
import { toActionError, type ActionState } from "@/lib/action-state";

export async function createCategoryAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const actor = await requireRole(["OWNER", "ADMIN"]);
  const parsed = createCategorySchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Form geçersiz" };
  }
  try {
    await createCategory(actor, parsed.data);
  } catch (err) {
    return toActionError(err);
  }
  revalidatePath("/categories");
  return { success: "Kategori eklendi." };
}

export async function renameCategoryAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const actor = await requireRole(["OWNER", "ADMIN"]);
  const parsed = renameCategorySchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Form geçersiz" };
  }
  try {
    await renameCategory(actor, parsed.data);
  } catch (err) {
    return toActionError(err);
  }
  revalidatePath("/categories");
  return { success: "Kategori güncellendi." };
}

export async function archiveCategoryAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const actor = await requireRole(["OWNER", "ADMIN"]);
  const parsed = categoryIdSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: "Form geçersiz" };
  try {
    await archiveCategory(actor, parsed.data.id);
  } catch (err) {
    return toActionError(err);
  }
  revalidatePath("/categories");
  return { success: "Kategori pasifleştirildi." };
}

export async function reactivateCategoryAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const actor = await requireRole(["OWNER", "ADMIN"]);
  const parsed = categoryIdSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: "Form geçersiz" };
  try {
    await reactivateCategory(actor, parsed.data.id);
  } catch (err) {
    return toActionError(err);
  }
  revalidatePath("/categories");
  return { success: "Kategori yeniden etkinleştirildi." };
}
