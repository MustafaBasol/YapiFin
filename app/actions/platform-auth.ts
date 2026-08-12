"use server";

import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { platformLoginSchema } from "@/lib/validation/platform-auth";
import { authenticatePlatformAdmin } from "@/server/services/platform/platform-auth-service";
import { createPlatformAdminSession, destroyPlatformAdminSession } from "@/lib/auth/platform-session";
import { enforceRateLimit, rateLimitActionError } from "@/lib/rate-limit/policy";
import { resolveClientIp, getTrustedProxyCount } from "@/lib/rate-limit/client-ip";
import { hashIdentifier } from "@/lib/rate-limit/identifier";
import { recordFailedLoginSecurityEvent } from "@/lib/monitoring/security-events";
import { ServiceError } from "@/server/services/errors";
import type { ActionState } from "@/lib/action-state";
import { toActionError } from "@/lib/action-error";

async function clientIp(): Promise<string> {
  const h = await headers();
  return resolveClientIp(h.get("x-forwarded-for"), getTrustedProxyCount()) ?? "unknown";
}

/** `app/actions/auth.ts` `loginAction` ile AYNI desen — bkz. o dosyanın rate-limit/güvenlik-olayı yorumları. */
export async function platformLoginAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const parsed = platformLoginSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Form geçersiz" };
  }

  const ip = await clientIp();
  const decision = await enforceRateLimit("platform-login", [ip, parsed.data.email]);
  if (!decision.allowed) return rateLimitActionError();

  try {
    const admin = await authenticatePlatformAdmin(parsed.data.email, parsed.data.password);
    await createPlatformAdminSession(admin.id);
  } catch (err) {
    if (err instanceof ServiceError) {
      const subjectHash = hashIdentifier("login-failed", `${ip}:${parsed.data.email}`);
      console.warn(JSON.stringify({ level: "warn", event: "auth.platform_admin.failed_login", route: "/platform/login", subjectHash }));
      recordFailedLoginSecurityEvent({ route: "/platform/login", subjectHash });
    }
    return toActionError(err);
  }
  redirect("/platform");
}

export async function platformLogoutAction(): Promise<void> {
  await destroyPlatformAdminSession();
  redirect("/platform/login");
}
