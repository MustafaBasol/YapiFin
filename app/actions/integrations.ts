"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireRole } from "@/lib/auth/guard";
import {
  createIntegrationConnectionSchema,
  updateIntegrationConnectionSchema,
  integrationConnectionIdSchema,
  setIntegrationCredentialSchema,
} from "@/lib/validation/integration";
import {
  createConnection,
  updateConnectionMetadata,
  setConnectionCredential,
  disableConnection,
  enableConnection,
  deleteConnection,
} from "@/server/services/integrations/integration-service";
import type { ActionState } from "@/lib/action-state";
import { toActionError } from "@/lib/action-error";

const INTEGRATION_MANAGER_ROLES = ["OWNER", "ADMIN"] as const;

export async function createIntegrationConnectionAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const actor = await requireRole([...INTEGRATION_MANAGER_ROLES]);
  const parsed = createIntegrationConnectionSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Form geçersiz" };

  let connectionId: string;
  try {
    const connection = await createConnection(actor, parsed.data);
    connectionId = connection.id;
  } catch (err) {
    return toActionError(err);
  }
  revalidatePath("/settings/integrations");
  redirect(`/settings/integrations/${connectionId}`);
}

export async function updateIntegrationConnectionAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const actor = await requireRole([...INTEGRATION_MANAGER_ROLES]);
  const parsed = updateIntegrationConnectionSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Form geçersiz" };

  try {
    await updateConnectionMetadata(actor, parsed.data);
  } catch (err) {
    return toActionError(err);
  }
  revalidatePath(`/settings/integrations/${parsed.data.id}`);
  revalidatePath("/settings/integrations");
  return { success: "Bağlantı güncellendi." };
}

export async function setIntegrationCredentialAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const actor = await requireRole([...INTEGRATION_MANAGER_ROLES]);
  const parsed = setIntegrationCredentialSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Form geçersiz" };

  try {
    await setConnectionCredential(actor, parsed.data);
  } catch (err) {
    return toActionError(err);
  }
  revalidatePath(`/settings/integrations/${parsed.data.connectionId}`);
  return { success: "Kimlik bilgisi kaydedildi." };
}

export async function disableIntegrationConnectionAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const actor = await requireRole([...INTEGRATION_MANAGER_ROLES]);
  const parsed = integrationConnectionIdSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: "Form geçersiz" };

  try {
    await disableConnection(actor, parsed.data.id);
  } catch (err) {
    return toActionError(err);
  }
  revalidatePath(`/settings/integrations/${parsed.data.id}`);
  revalidatePath("/settings/integrations");
  return { success: "Bağlantı devre dışı bırakıldı." };
}

export async function enableIntegrationConnectionAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const actor = await requireRole([...INTEGRATION_MANAGER_ROLES]);
  const parsed = integrationConnectionIdSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: "Form geçersiz" };

  try {
    await enableConnection(actor, parsed.data.id);
  } catch (err) {
    return toActionError(err);
  }
  revalidatePath(`/settings/integrations/${parsed.data.id}`);
  revalidatePath("/settings/integrations");
  return { success: "Bağlantı etkinleştirildi." };
}

export async function deleteIntegrationConnectionAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const actor = await requireRole([...INTEGRATION_MANAGER_ROLES]);
  const parsed = integrationConnectionIdSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: "Form geçersiz" };

  try {
    await deleteConnection(actor, parsed.data.id);
  } catch (err) {
    return toActionError(err);
  }
  revalidatePath("/settings/integrations");
  redirect("/settings/integrations");
}
