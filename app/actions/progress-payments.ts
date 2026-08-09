"use server";

import { revalidatePath } from "next/cache";
import { requireRole } from "@/lib/auth/guard";
import {
  createProgressPaymentSchema,
  updateProgressPaymentSchema,
  progressPaymentIdSchema,
  rejectProgressPaymentSchema,
  cancelProgressPaymentSchema,
  createExtraWorkItemSchema,
  extraWorkItemIdSchema,
} from "@/lib/validation/progress-payment";
import {
  createProgressPayment,
  updateProgressPayment,
  submitProgressPayment,
  approveProgressPayment,
  rejectProgressPayment,
  cancelProgressPayment,
  addExtraWorkItem,
  deleteExtraWorkItem,
} from "@/server/services/progress-payment-service";
import type { ActionState } from "@/lib/action-state";
import { toActionError } from "@/lib/action-error";

const PROGRESS_PAYMENT_MANAGER_ROLES = ["OWNER", "ADMIN", "FINANCE"] as const;

function revalidateProgressPaymentPaths(projectId: string, progressPaymentId?: string) {
  revalidatePath(`/projects/${projectId}/progress-payments`);
  revalidatePath(`/projects/${projectId}`);
  if (progressPaymentId) revalidatePath(`/projects/${projectId}/progress-payments/${progressPaymentId}`);
}

export async function createProgressPaymentAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const actor = await requireRole([...PROGRESS_PAYMENT_MANAGER_ROLES]);
  const parsed = createProgressPaymentSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Form geçersiz" };

  try {
    await createProgressPayment(actor, parsed.data);
  } catch (err) {
    return toActionError(err);
  }
  revalidateProgressPaymentPaths(parsed.data.projectId);
  return { success: "Hakediş taslağı oluşturuldu." };
}

export async function updateProgressPaymentAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const actor = await requireRole([...PROGRESS_PAYMENT_MANAGER_ROLES]);
  const parsed = updateProgressPaymentSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Form geçersiz" };

  let projectId: string;
  try {
    const updated = await updateProgressPayment(actor, parsed.data);
    projectId = updated.projectId;
  } catch (err) {
    return toActionError(err);
  }
  revalidateProgressPaymentPaths(projectId, parsed.data.id);
  return { success: "Hakediş güncellendi." };
}

export async function submitProgressPaymentAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const actor = await requireRole([...PROGRESS_PAYMENT_MANAGER_ROLES]);
  const parsed = progressPaymentIdSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: "Form geçersiz" };

  let projectId: string;
  try {
    const updated = await submitProgressPayment(actor, parsed.data);
    projectId = updated.projectId;
  } catch (err) {
    return toActionError(err);
  }
  revalidateProgressPaymentPaths(projectId, parsed.data.id);
  return { success: "Hakediş onaya gönderildi." };
}

export async function approveProgressPaymentAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const actor = await requireRole([...PROGRESS_PAYMENT_MANAGER_ROLES]);
  const parsed = progressPaymentIdSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: "Form geçersiz" };

  let projectId: string;
  try {
    const result = await approveProgressPayment(actor, parsed.data);
    projectId = result.progressPayment.projectId;
  } catch (err) {
    return toActionError(err);
  }
  revalidateProgressPaymentPaths(projectId, parsed.data.id);
  revalidatePath("/income");
  return { success: "Hakediş onaylandı ve gelir tahakkuku oluşturuldu." };
}

export async function rejectProgressPaymentAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const actor = await requireRole([...PROGRESS_PAYMENT_MANAGER_ROLES]);
  const parsed = rejectProgressPaymentSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Form geçersiz" };

  let projectId: string;
  try {
    const updated = await rejectProgressPayment(actor, parsed.data);
    projectId = updated.projectId;
  } catch (err) {
    return toActionError(err);
  }
  revalidateProgressPaymentPaths(projectId, parsed.data.id);
  return { success: "Hakediş reddedildi." };
}

export async function cancelProgressPaymentAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const actor = await requireRole([...PROGRESS_PAYMENT_MANAGER_ROLES]);
  const parsed = cancelProgressPaymentSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Form geçersiz" };

  let projectId: string;
  try {
    const updated = await cancelProgressPayment(actor, parsed.data);
    projectId = updated.projectId;
  } catch (err) {
    return toActionError(err);
  }
  revalidateProgressPaymentPaths(projectId, parsed.data.id);
  return { success: "Hakediş iptal edildi." };
}

/**
 * `projectId`, form üzerinde gizli alan olarak taşınır — yalnızca
 * `revalidatePath` için kullanılır, yetkilendirme/tenant kapsamı tamamen
 * servis katmanında `progressPaymentId` üzerinden yeniden doğrulanır.
 */
export async function addExtraWorkItemAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const actor = await requireRole([...PROGRESS_PAYMENT_MANAGER_ROLES]);
  const parsed = createExtraWorkItemSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Form geçersiz" };

  try {
    await addExtraWorkItem(actor, parsed.data);
  } catch (err) {
    return toActionError(err);
  }
  const projectId = String(formData.get("projectId") ?? "");
  if (projectId) revalidateProgressPaymentPaths(projectId, parsed.data.progressPaymentId);
  return { success: "Ek iş kalemi eklendi." };
}

export async function deleteExtraWorkItemAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const actor = await requireRole([...PROGRESS_PAYMENT_MANAGER_ROLES]);
  const parsed = extraWorkItemIdSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: "Form geçersiz" };

  try {
    await deleteExtraWorkItem(actor, parsed.data);
  } catch (err) {
    return toActionError(err);
  }
  const projectId = String(formData.get("projectId") ?? "");
  const progressPaymentId = String(formData.get("progressPaymentId") ?? "");
  if (projectId) revalidateProgressPaymentPaths(projectId, progressPaymentId || undefined);
  return { success: "Ek iş kalemi silindi." };
}
