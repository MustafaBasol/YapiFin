"use server";

import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { registerOwnerSchema, loginSchema, forgotPasswordSchema, resetPasswordSchema, acceptInvitationSchema } from "@/lib/validation/auth";
import { registerOwnerAndOrganization } from "@/server/services/organization-service";
import { authenticateUser, requestPasswordReset, resetPassword, resendVerificationEmail } from "@/server/services/auth-service";
import { acceptInvitation } from "@/server/services/invitation-service";
import { createSession, destroySession, getSessionUser } from "@/lib/auth/session";
import { checkRateLimit } from "@/lib/auth/rate-limit";
import { toActionError, type ActionState } from "@/lib/action-state";

async function clientIp() {
  const h = await headers();
  return h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
}

export async function registerOwnerAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const parsed = registerOwnerSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Form geçersiz" };
  }

  try {
    const { userId } = await registerOwnerAndOrganization(parsed.data);
    await createSession(userId);
  } catch (err) {
    return toActionError(err);
  }
  redirect("/dashboard");
}

export async function loginAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const parsed = loginSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Form geçersiz" };
  }

  const ip = await clientIp();
  const limit = checkRateLimit(`login:${ip}:${parsed.data.email}`);
  if (!limit.allowed) {
    return { error: "Çok fazla deneme yapıldı. Lütfen birkaç dakika sonra tekrar deneyin." };
  }

  try {
    const user = await authenticateUser(parsed.data.email, parsed.data.password);
    await createSession(user.id);
  } catch (err) {
    return toActionError(err);
  }
  redirect("/dashboard");
}

export async function logoutAction(): Promise<void> {
  await destroySession();
  redirect("/login");
}

export async function forgotPasswordAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const parsed = forgotPasswordSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Form geçersiz" };
  }
  await requestPasswordReset(parsed.data.email);
  return { success: "Bu e-posta kayıtlıysa, parola sıfırlama bağlantısı gönderildi." };
}

export async function resetPasswordAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const parsed = resetPasswordSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Form geçersiz" };
  }
  try {
    await resetPassword(parsed.data.token, parsed.data.password);
  } catch (err) {
    return toActionError(err);
  }
  redirect("/login");
}

export async function resendVerificationAction(): Promise<ActionState> {
  const user = await getSessionUser();
  if (!user) redirect("/login");
  await resendVerificationEmail(user.id);
  return { success: "Doğrulama e-postası tekrar gönderildi." };
}

export async function acceptInvitationAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const parsed = acceptInvitationSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Form geçersiz" };
  }
  try {
    const { userId } = await acceptInvitation(parsed.data);
    await createSession(userId);
  } catch (err) {
    return toActionError(err);
  }
  redirect("/dashboard");
}
