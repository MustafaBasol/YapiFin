"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { writeAuditLog } from "@/lib/audit";
import { requireRole } from "@/lib/auth/guard";
import { updateOrganizationSchema } from "@/lib/validation/organization";
import { toActionError, type ActionState } from "@/lib/action-state";

export async function updateOrganizationAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const actor = await requireRole(["OWNER"]);
  const parsed = updateOrganizationSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Form geçersiz" };
  }

  try {
    const existing = await db.organization.findUniqueOrThrow({ where: { id: actor.organizationId } });
    await db.$transaction(async (tx) => {
      const updated = await tx.organization.update({
        where: { id: actor.organizationId },
        data: {
          tradeName: parsed.data.tradeName,
          taxOffice: parsed.data.taxOffice || null,
          taxNumber: parsed.data.taxNumber || null,
          phone: parsed.data.phone || null,
          email: parsed.data.email || null,
          city: parsed.data.city || null,
          district: parsed.data.district || null,
          address: parsed.data.address || null,
        },
      });
      await writeAuditLog(tx, {
        organizationId: actor.organizationId,
        actorId: actor.id,
        action: "organization.update",
        entityType: "Organization",
        entityId: actor.organizationId,
        before: { tradeName: existing.tradeName },
        after: { tradeName: updated.tradeName },
      });
    });
  } catch (err) {
    return toActionError(err);
  }

  revalidatePath("/settings");
  return { success: "Firma ayarları güncellendi." };
}
