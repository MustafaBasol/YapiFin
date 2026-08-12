"use server";

import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { requirePlatformAdmin } from "@/lib/auth/platform-guard";
import { resolveClientIp, getTrustedProxyCount } from "@/lib/rate-limit/client-ip";
import {
  applyPlatformPlanOverride,
  revokePlatformPlanOverride,
} from "@/server/services/platform/platform-plan-override-service";
import { platformPlanOverrideSchema, platformPlanOverrideRevokeSchema } from "@/lib/validation/platform-plan";
import type { ActionState } from "@/lib/action-state";
import { toActionError } from "@/lib/action-error";

/**
 * YF-819 — `app/actions/billing.ts`teki tenant-tarafı server action deseniyle
 * AYNI (`requireRole` yerine `requirePlatformAdmin`): yetki kontrolü hem
 * sayfa render'ında (`app/(platform)/platform/organizations/[id]/page.tsx`)
 * HEM DE burada, mutasyonun KENDİSİNDE bağımsız olarak yapılır — yetkilendirme
 * ASLA yalnızca istemci/sayfa katmanına GÜVENMEZ (görev talimatı "server-side
 * authorization", "fail closed").
 */
async function requestMeta(): Promise<{ ipAddress: string | null; userAgent: string | null }> {
  const h = await headers();
  return {
    ipAddress: resolveClientIp(h.get("x-forwarded-for"), getTrustedProxyCount()),
    userAgent: h.get("user-agent"),
  };
}

export async function applyPlatformPlanOverrideAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const admin = await requirePlatformAdmin();
  const parsed = platformPlanOverrideSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Form geçersiz" };
  }

  const meta = await requestMeta();
  try {
    const result = await applyPlatformPlanOverride({
      organizationId: parsed.data.organizationId,
      targetPlanCode: parsed.data.planCode,
      reason: parsed.data.reason,
      expiresAt: parsed.data.expiresAt ? new Date(parsed.data.expiresAt) : null,
      expectedCurrentPlanCode: parsed.data.expectedCurrentPlanCode,
      platformAdminId: admin.id,
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
    });
    revalidatePath(`/platform/organizations/${parsed.data.organizationId}`);
    return { success: `Plan ${result.planName} olarak geçersiz kılındı.` };
  } catch (err) {
    return toActionError(err);
  }
}

export async function revokePlatformPlanOverrideAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const admin = await requirePlatformAdmin();
  const parsed = platformPlanOverrideRevokeSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Form geçersiz" };
  }

  const meta = await requestMeta();
  try {
    await revokePlatformPlanOverride({
      organizationId: parsed.data.organizationId,
      expectedOverrideId: parsed.data.expectedOverrideId,
      reason: parsed.data.reason,
      platformAdminId: admin.id,
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
    });
    revalidatePath(`/platform/organizations/${parsed.data.organizationId}`);
    return { success: "Platform planı geçersiz kılması sonlandırıldı." };
  } catch (err) {
    return toActionError(err);
  }
}
