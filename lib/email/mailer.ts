import { getEnv } from "@/lib/env";

interface MailMessage {
  to: string;
  subject: string;
  html: string;
  text: string;
}

/**
 * SMTP tam yapılandırılmışsa nodemailer ile gönderir. Üretimde SMTP
 * yapılandırması `getEnv()` tarafından zorunlu kılındığı için buraya asla
 * `smtp: null` ile ulaşılmamalıdır — yine de savunma amaçlı fail-closed
 * kontrol edilir (bkz. docs/PRODUCTION_READINESS.md R-2). Yalnızca
 * development/test'te, SMTP tanımlı değilse e-posta konsola yazılır (dev
 * outbox); bu davranış üretimde asla tetiklenmez.
 */
export async function sendMail(message: MailMessage): Promise<void> {
  const env = getEnv();

  if (!env.smtp) {
    if (env.NODE_ENV === "production") {
      throw new Error(
        "SMTP yapılandırılmamış: üretimde e-posta gönderimi devre dışı (dev outbox üretimde kullanılamaz)",
      );
    }
    console.log(
      JSON.stringify({
        level: "info",
        event: "email.dev_outbox",
        to: message.to,
        subject: message.subject,
        text: message.text,
      }),
    );
    return;
  }

  const nodemailer = await import("nodemailer");
  const transport = nodemailer.createTransport({
    host: env.smtp.host,
    port: env.smtp.port,
    secure: env.smtp.port === 465,
    auth: env.smtp.auth ? { user: env.smtp.auth.user, pass: env.smtp.auth.password } : undefined,
  });

  await transport.sendMail({
    from: env.smtp.from,
    to: message.to,
    subject: message.subject,
    html: message.html,
    text: message.text,
  });
}

function appUrl() {
  return getEnv().NEXT_PUBLIC_APP_URL;
}

// async olarak tanımlanır: appUrl()/getEnv() burada senkron fırlatabilir
// (örn. üretimde SMTP yapılandırılmamışsa) — async fonksiyon gövdesi bu
// istisnayı otomatik olarak reddedilmiş bir Promise'e çevirir, böylece
// bu fonksiyonların Promise<void> sözleşmesi çağıranlar için her zaman
// geçerli kalır (senkron fırlatma sürpriz olmaz).
export async function sendVerificationEmail(to: string, token: string): Promise<void> {
  const link = `${appUrl()}/verify-email/${token}`;
  await sendMail({
    to,
    subject: "YapiFin — E-posta adresinizi doğrulayın",
    text: `E-posta adresinizi doğrulamak için bağlantıya tıklayın: ${link}`,
    html: `<p>E-posta adresinizi doğrulamak için <a href="${link}">buraya tıklayın</a>.</p>`,
  });
}

export async function sendPasswordResetEmail(to: string, token: string): Promise<void> {
  const link = `${appUrl()}/reset-password/${token}`;
  await sendMail({
    to,
    subject: "YapiFin — Parola sıfırlama",
    text: `Parolanızı sıfırlamak için bağlantıya tıklayın: ${link}`,
    html: `<p>Parolanızı sıfırlamak için <a href="${link}">buraya tıklayın</a>. Bu bağlantı 1 saat geçerlidir.</p>`,
  });
}

export async function sendInvitationEmail(
  to: string,
  token: string,
  organizationName: string,
  inviterName: string,
): Promise<void> {
  const link = `${appUrl()}/invite/${token}`;
  await sendMail({
    to,
    subject: `YapiFin — ${organizationName} organizasyonuna davet edildiniz`,
    text: `${inviterName} sizi ${organizationName} organizasyonuna davet etti. Katılmak için: ${link}`,
    html: `<p><strong>${inviterName}</strong> sizi <strong>${organizationName}</strong> organizasyonuna davet etti.</p><p><a href="${link}">Daveti kabul et</a></p>`,
  });
}
