"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireRole } from "@/lib/auth/guard";
import { createProjectSchema, updateProjectSchema, projectMemberSchema, projectStatusEnum } from "@/lib/validation/project";
import {
  createProject,
  updateProject,
  setProjectStatus,
  assignProjectMember,
  removeProjectMember,
} from "@/server/services/project-service";
import { toActionError, type ActionState } from "@/lib/action-state";

export async function createProjectAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const actor = await requireRole(["OWNER", "ADMIN"]);
  const parsed = createProjectSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Form geçersiz" };
  }

  let projectId: string;
  try {
    const project = await createProject(actor, parsed.data);
    projectId = project.id;
  } catch (err) {
    return toActionError(err);
  }
  revalidatePath("/projects");
  redirect(`/projects/${projectId}`);
}

export async function updateProjectAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const actor = await requireRole(["OWNER", "ADMIN"]);
  const parsed = updateProjectSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Form geçersiz" };
  }
  try {
    await updateProject(actor, parsed.data);
  } catch (err) {
    return toActionError(err);
  }
  revalidatePath(`/projects/${parsed.data.id}`);
  revalidatePath("/projects");
  return { success: "Proje güncellendi." };
}

export async function setProjectStatusAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const actor = await requireRole(["OWNER", "ADMIN"]);
  const projectId = String(formData.get("projectId") ?? "");
  const status = projectStatusEnum.safeParse(formData.get("status"));
  if (!status.success) return { error: "Geçersiz durum" };

  try {
    await setProjectStatus(actor, projectId, status.data);
  } catch (err) {
    return toActionError(err);
  }
  revalidatePath(`/projects/${projectId}`);
  revalidatePath("/projects");
  return { success: "Proje durumu güncellendi." };
}

export async function assignProjectMemberAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const actor = await requireRole(["OWNER", "ADMIN"]);
  const parsed = projectMemberSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: "Form geçersiz" };

  try {
    await assignProjectMember(actor, parsed.data.projectId, parsed.data.userId);
  } catch (err) {
    return toActionError(err);
  }
  revalidatePath(`/projects/${parsed.data.projectId}`);
  return { success: "Kullanıcı projeye atandı." };
}

export async function removeProjectMemberAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const actor = await requireRole(["OWNER", "ADMIN"]);
  const parsed = projectMemberSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: "Form geçersiz" };

  try {
    await removeProjectMember(actor, parsed.data.projectId, parsed.data.userId);
  } catch (err) {
    return toActionError(err);
  }
  revalidatePath(`/projects/${parsed.data.projectId}`);
  return { success: "Kullanıcı projeden çıkarıldı." };
}
