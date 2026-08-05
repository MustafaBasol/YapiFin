"use server";

import { revalidatePath } from "next/cache";
import { requireRole } from "@/lib/auth/guard";
import { createInvitationSchema } from "@/lib/validation/invitation";
import { changeUserRoleSchema, userIdSchema } from "@/lib/validation/user";
import { createInvitation, resendInvitation } from "@/server/services/invitation-service";
import { changeUserRole, deactivateUser, reactivateUser } from "@/server/services/user-service";
import { toActionError, type ActionState } from "@/lib/action-state";

export async function inviteUserAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const actor = await requireRole(["OWNER", "ADMIN"]);

  const parsed = createInvitationSchema.safeParse({
    email: formData.get("email"),
    role: formData.get("role"),
    projectIds: formData.getAll("projectIds"),
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Form geçersiz" };
  }

  try {
    await createInvitation(actor, parsed.data);
  } catch (err) {
    return toActionError(err);
  }
  revalidatePath("/users");
  return { success: `${parsed.data.email} adresine davet gönderildi.` };
}

export async function resendInvitationAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const actor = await requireRole(["OWNER", "ADMIN"]);
  const invitationId = String(formData.get("invitationId") ?? "");
  try {
    await resendInvitation(actor, invitationId);
  } catch (err) {
    return toActionError(err);
  }
  revalidatePath("/users");
  return { success: "Davet yeniden gönderildi." };
}

export async function changeUserRoleAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const actor = await requireRole(["OWNER", "ADMIN"]);
  const parsed = changeUserRoleSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Form geçersiz" };
  }
  try {
    await changeUserRole(actor, parsed.data.userId, parsed.data.role);
  } catch (err) {
    return toActionError(err);
  }
  revalidatePath("/users");
  return { success: "Rol güncellendi." };
}

export async function deactivateUserAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const actor = await requireRole(["OWNER", "ADMIN"]);
  const parsed = userIdSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Form geçersiz" };
  }
  try {
    await deactivateUser(actor, parsed.data.userId);
  } catch (err) {
    return toActionError(err);
  }
  revalidatePath("/users");
  return { success: "Kullanıcı pasifleştirildi." };
}

export async function reactivateUserAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const actor = await requireRole(["OWNER", "ADMIN"]);
  const parsed = userIdSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Form geçersiz" };
  }
  try {
    await reactivateUser(actor, parsed.data.userId);
  } catch (err) {
    return toActionError(err);
  }
  revalidatePath("/users");
  return { success: "Kullanıcı yeniden etkinleştirildi." };
}
