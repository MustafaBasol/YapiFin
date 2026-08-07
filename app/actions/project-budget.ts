"use server";

import { revalidatePath } from "next/cache";
import { requireRole } from "@/lib/auth/guard";
import {
  createProjectBudgetItemSchema,
  updateProjectBudgetItemSchema,
  projectBudgetItemIdSchema,
} from "@/lib/validation/project-budget";
import {
  createProjectBudgetItem,
  updateProjectBudgetItem,
  deleteProjectBudgetItem,
} from "@/server/services/project-budget-service";
import type { ActionState } from "@/lib/action-state";
import { toActionError } from "@/lib/action-error";

const BUDGET_MANAGER_ROLES = ["OWNER", "ADMIN", "FINANCE"] as const;

function revalidateProjectBudgetPaths(projectId: string) {
  revalidatePath(`/projects/${projectId}/budget`);
  revalidatePath(`/projects/${projectId}`);
}

export async function createProjectBudgetItemAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const actor = await requireRole([...BUDGET_MANAGER_ROLES]);
  const parsed = createProjectBudgetItemSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Form geçersiz" };

  try {
    await createProjectBudgetItem(actor, parsed.data);
  } catch (err) {
    return toActionError(err);
  }
  revalidateProjectBudgetPaths(parsed.data.projectId);
  return { success: "Bütçe kalemi eklendi." };
}

export async function updateProjectBudgetItemAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const actor = await requireRole([...BUDGET_MANAGER_ROLES]);
  const parsed = updateProjectBudgetItemSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Form geçersiz" };

  let projectId: string;
  try {
    const updated = await updateProjectBudgetItem(actor, parsed.data);
    projectId = updated.projectId;
  } catch (err) {
    return toActionError(err);
  }
  revalidateProjectBudgetPaths(projectId);
  return { success: "Bütçe kalemi güncellendi." };
}

export async function deleteProjectBudgetItemAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const actor = await requireRole([...BUDGET_MANAGER_ROLES]);
  const parsed = projectBudgetItemIdSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: "Form geçersiz" };

  let projectId: string;
  try {
    const result = await deleteProjectBudgetItem(actor, parsed.data.id);
    projectId = result.projectId;
  } catch (err) {
    return toActionError(err);
  }
  revalidateProjectBudgetPaths(projectId);
  return { success: "Bütçe kalemi silindi." };
}
