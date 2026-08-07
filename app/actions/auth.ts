"use server";

import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { registerOwnerSchema, loginSchema, forgotPasswordSchema, resetPasswordSchema, acceptInvitationSchema } from "@/lib/validation/auth";
import { registerOwnerAndOrganization } from "@/server/services/organization-service";
import { authenticateUser, requestPasswordReset, resetPassword, resendVerificationEmail } from "@/server/services/auth-service";
import { acceptInvitation } from "@/server/services/invitation-service";
import { createSession, destroySession, getSessionUser } from "@/lib/auth/session";
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

export async function registerOwnerAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const parsed = registerOwnerSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Form geçersiz" };
  }

  const ip = await clientIp();
  const decision = await enforceRateLimit("signup", [ip, parsed.data.email]);
  if (!decision.allowed) return rateLimitActionError();

  let verificationEmailSent = true;
  try {
    const result = await registerOwnerAndOrganization(parsed.data);
    verificationEmailSent = result.verificationEmailSent;
    await createSession(result.userId);
  } catch (err) {
    return toActionError(err);
  }
  if (!verificationEmailSent) {
    return {
      success:
        "Hesabınız oluşturuldu, ancak doğrulama e-postası şu anda gönderilemedi. Panele giriş yaptıktan sonra e-postanızı yeniden gönderebilirsiniz.",
    };
  }
  redirect("/dashboard");
}

export async function loginAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const parsed = loginSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Form geçersiz" };
  }

  const ip = await clientIp();
  const decision = await enforceRateLimit("login", [ip, parsed.data.email]);
  if (!decision.allowed) return rateLimitActionError();

  try {
    const user = await authenticateUser(parsed.data.email, parsed.data.password);
    await createSession(user.id);
  } catch (err) {
    // YF-512 — yalnızca gerçekten geçersiz kimlik bilgisi (authenticateUser'ın
    // fırlattığı ServiceError) bir `auth.failed_login` güvenlik olayıdır.
    // DB hatası, oturum oluşturma arızası veya başka beklenmeyen istisnalar
    // bir altyapı sorunudur, kimlik doğrulama saldırısı DEĞİLDİR — bunları
    // failed_login olarak sınıflandırmak yanlış sinyal üretir ve gerçek kaba
    // kuvvet denemelerini altyapı gürültüsüne gömer (bkz. görev talimatı,
    // FAILED LOGIN CLASSIFICATION bölümü). Bu durumlar yine de normal
    // toActionError(err) akışından (captureException + kullanıcıya genel
    // mesaj) geçer, yalnızca güvenlik olayı olarak işaretlenmez.
    if (err instanceof ServiceError) {
      // Ham e-posta/IP ASLA loglanmaz — yalnızca rate-limit anahtarlarıyla
      // aynı desende (bkz. lib/rate-limit/identifier.ts) geri döndürülemez
      // bir HMAC özeti; "login-failed" kapsamı, rate-limit'in "login"
      // kapsamından kasıtlı olarak ayrıdır (domain separation, çapraz
      // korelasyonu önler).
      const subjectHash = hashIdentifier("login-failed", `${ip}:${parsed.data.email}`);
      console.warn(JSON.stringify({ level: "warn", event: "auth.failed_login", route: "/login", subjectHash }));
      recordFailedLoginSecurityEvent({ route: "/login", subjectHash });
    }
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

  const ip = await clientIp();
  const decision = await enforceRateLimit("forgot-password", [ip, parsed.data.email]);
  if (!decision.allowed) return rateLimitActionError();

  await requestPasswordReset(parsed.data.email);
  return { success: "Bu e-posta kayıtlıysa, parola sıfırlama bağlantısı gönderildi." };
}

export async function resetPasswordAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const parsed = resetPasswordSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Form geçersiz" };
  }

  const ip = await clientIp();
  // Anahtar yalnızca IP'ye dayanır (token'a değil): amaç, tek bir tokenı
  // kaba kuvvetle tahmin etmeyi engellemek değil (32 byte rastgele token
  // zaten pratikte tahmin edilemez) — art arda çok sayıda farklı token
  // denemesiyle kaynak tüketimini (DoS) sınırlamaktır.
  const decision = await enforceRateLimit("reset-password", [ip]);
  if (!decision.allowed) return rateLimitActionError();

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

  const decision = await enforceRateLimit("resend-verification", [user.id]);
  if (!decision.allowed) return rateLimitActionError();

  try {
    await resendVerificationEmail(user.id);
  } catch (err) {
    return toActionError(err);
  }
  return { success: "Doğrulama e-postası tekrar gönderildi." };
}

export async function acceptInvitationAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const parsed = acceptInvitationSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Form geçersiz" };
  }

  const ip = await clientIp();
  const decision = await enforceRateLimit("accept-invitation", [ip, parsed.data.token]);
  if (!decision.allowed) return rateLimitActionError();

  try {
    const { userId } = await acceptInvitation(parsed.data);
    await createSession(userId);
  } catch (err) {
    return toActionError(err);
  }
  redirect("/dashboard");
}
