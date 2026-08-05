interface MailMessage {
  to: string;
  subject: string;
  html: string;
  text: string;
}

/**
 * SMTP yapılandırılmışsa nodemailer ile gönderir; yapılandırılmamışsa (MVP
 * geliştirme ortamı) e-postayı yapılandırılmış log olarak konsola yazar.
 * Böylece davet/doğrulama/parola sıfırlama linkleri SMTP olmadan da test
 * edilebilir.
 */
export async function sendMail(message: MailMessage): Promise<void> {
  const host = process.env.SMTP_HOST;
  if (!host) {
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
    host,
    port: Number(process.env.SMTP_PORT ?? 587),
    secure: Number(process.env.SMTP_PORT ?? 587) === 465,
    auth: process.env.SMTP_USER
      ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD }
      : undefined,
  });

  await transport.sendMail({
    from: process.env.SMTP_FROM ?? "YapiFin <noreply@yapifin.com>",
    to: message.to,
    subject: message.subject,
    html: message.html,
    text: message.text,
  });
}

function appUrl() {
  return process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
}

export function sendVerificationEmail(to: string, token: string) {
  const link = `${appUrl()}/verify-email/${token}`;
  return sendMail({
    to,
    subject: "YapiFin — E-posta adresinizi doğrulayın",
    text: `E-posta adresinizi doğrulamak için bağlantıya tıklayın: ${link}`,
    html: `<p>E-posta adresinizi doğrulamak için <a href="${link}">buraya tıklayın</a>.</p>`,
  });
}

export function sendPasswordResetEmail(to: string, token: string) {
  const link = `${appUrl()}/reset-password/${token}`;
  return sendMail({
    to,
    subject: "YapiFin — Parola sıfırlama",
    text: `Parolanızı sıfırlamak için bağlantıya tıklayın: ${link}`,
    html: `<p>Parolanızı sıfırlamak için <a href="${link}">buraya tıklayın</a>. Bu bağlantı 1 saat geçerlidir.</p>`,
  });
}

export function sendInvitationEmail(to: string, token: string, organizationName: string, inviterName: string) {
  const link = `${appUrl()}/invite/${token}`;
  return sendMail({
    to,
    subject: `YapiFin — ${organizationName} organizasyonuna davet edildiniz`,
    text: `${inviterName} sizi ${organizationName} organizasyonuna davet etti. Katılmak için: ${link}`,
    html: `<p><strong>${inviterName}</strong> sizi <strong>${organizationName}</strong> organizasyonuna davet etti.</p><p><a href="${link}">Daveti kabul et</a></p>`,
  });
}
