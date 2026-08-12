import { sendMail } from "@/lib/email/mailer";
import { getEnv } from "@/lib/env";
import { formatDateTime } from "@/lib/utils";
import type { BillingNotificationRecipient } from "@/lib/billing/notification-policy";

/**
 * YF-821 — YF-814 dunning/grace-period durum geçişleri için müşteri
 * e-postaları. `lib/email/mailer.ts` `sendVerificationEmail`/
 * `sendInvitationEmail` İLE AYNI desen (düz metin + basit HTML, TEK dil):
 * uygulama yalnızca Türkçe'dir (bkz. proje CLAUDE.md "Ürün yalnızca Türkçe
 * olacağı için yeni geliştirmede İngilizce metin veya dil anahtarı
 * eklenmemelidir" — ayrı bir çoklu-dil altyapısı burada İCAT EDİLMEZ), bu
 * yüzden görev talimatının genel "inspect current supported locales" maddesi
 * bu kod tabanında TEK sonuca (Türkçe-yalnızca) varır.
 *
 * Hiçbir Stripe iç detayı (abonelik/fatura/müşteri ID'si, ham durum dizesi)
 * e-posta içeriğine YAZILMAZ — `components/app/billing-dunning-banner.tsx`
 * İLE AYNI ilke. CTA her zaman YapiFin'in KENDİ kimlik doğrulamalı faturalama
 * sayfasına (`/settings/plan`) yönlendirir — bu sayfa her ziyarette TAZE bir
 * Stripe Customer Portal oturumu oluşturur (bkz.
 * `server/services/billing/billing-portal-service.ts`); kısa ömürlü bir
 * Portal URL'i asla doğrudan e-postaya GÖMÜLMEZ (görev talimatı "Do not place
 * Stripe secret/session internals directly into long-lived email
 * templates").
 */

function appUrl(): string {
  return getEnv().NEXT_PUBLIC_APP_URL.replace(/\/+$/, "");
}

function billingManagementUrl(): string {
  return `${appUrl()}/settings/plan`;
}

/** Organizasyon adı/kullanıcı adı gibi kullanıcı tarafından belirlenen serbest metinler HTML gövdesine yazılmadan önce kaçışlanır (XSS/işaretleme enjeksiyonu önlenir). */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export async function sendPaymentFailedGraceStartedEmail(
  recipient: BillingNotificationRecipient,
  params: { organizationName: string; gracePeriodEndsAt: Date },
): Promise<void> {
  const link = billingManagementUrl();
  const deadline = formatDateTime(params.gracePeriodEndsAt);
  const orgName = escapeHtml(params.organizationName);
  await sendMail({
    to: recipient.email,
    subject: `YapiFin — ${params.organizationName} için ödeme alınamadı`,
    text: `Merhaba ${recipient.firstName},\n\n${params.organizationName} organizasyonunuz için son ödeme denemesi başarısız oldu.\n\nYapiFin, ${deadline} tarihine kadar tam olarak kullanılabilir durumda kalacaktır. Bu tarihe kadar ödeme yönteminizi güncellemezseniz yeni ücretli işlemler (proje, davet, belge yükleme, ekstre içe aktarma) geçici olarak kısıtlanacaktır. Mevcut verileriniz ve raporlarınız her durumda etkilenmez.\n\nÖdeme yönteminizi güncellemek için: ${link}`,
    html: `<p>Merhaba ${escapeHtml(recipient.firstName)},</p><p><strong>${orgName}</strong> organizasyonunuz için son ödeme denemesi başarısız oldu.</p><p>YapiFin, <strong>${deadline}</strong> tarihine kadar tam olarak kullanılabilir durumda kalacaktır. Bu tarihe kadar ödeme yönteminizi güncellemezseniz yeni ücretli işlemler (proje, davet, belge yükleme, ekstre içe aktarma) geçici olarak kısıtlanacaktır. Mevcut verileriniz ve raporlarınız her durumda etkilenmez.</p><p><a href="${link}">Ödeme yöntemini güncelle</a></p>`,
  });
}

export async function sendGraceExpiringReminderEmail(
  recipient: BillingNotificationRecipient,
  params: { organizationName: string; gracePeriodEndsAt: Date },
): Promise<void> {
  const link = billingManagementUrl();
  const deadline = formatDateTime(params.gracePeriodEndsAt);
  const orgName = escapeHtml(params.organizationName);
  await sendMail({
    to: recipient.email,
    subject: `YapiFin — Son ödeme çözüm süreniz yaklaşıyor`,
    text: `Merhaba ${recipient.firstName},\n\n${params.organizationName} organizasyonunuz için ödeme çözüm (grace period) süreniz ${deadline} tarihinde sona erecek. Bu tarihe kadar ödeme yönteminizi güncellemezseniz yeni ücretli işlemler geçici olarak kısıtlanacaktır.\n\nÖdeme yönteminizi güncellemek için: ${link}`,
    html: `<p>Merhaba ${escapeHtml(recipient.firstName)},</p><p><strong>${orgName}</strong> organizasyonunuz için ödeme çözüm (grace period) süreniz <strong>${deadline}</strong> tarihinde sona erecek.</p><p>Bu tarihe kadar ödeme yönteminizi güncellemezseniz yeni ücretli işlemler geçici olarak kısıtlanacaktır.</p><p><a href="${link}">Ödeme yöntemini güncelle</a></p>`,
  });
}

export async function sendGraceExpiredRestrictedEmail(
  recipient: BillingNotificationRecipient,
  params: { organizationName: string },
): Promise<void> {
  const link = billingManagementUrl();
  const orgName = escapeHtml(params.organizationName);
  await sendMail({
    to: recipient.email,
    subject: `YapiFin — Faturalama hesabınız kısıtlandı`,
    text: `Merhaba ${recipient.firstName},\n\n${params.organizationName} organizasyonunuz için ödeme çözüm süreniz doldu. Yeni ücretli işlemler (proje, davet, belge yükleme, ekstre içe aktarma) şimdi kısıtlandı. Mevcut verileriniz ve raporlarınız korunuyor ve etkilenmedi.\n\nErişimi geri kazanmak için ödeme yönteminizi güncelleyin: ${link}`,
    html: `<p>Merhaba ${escapeHtml(recipient.firstName)},</p><p><strong>${orgName}</strong> organizasyonunuz için ödeme çözüm süreniz doldu. Yeni ücretli işlemler (proje, davet, belge yükleme, ekstre içe aktarma) şimdi kısıtlandı.</p><p>Mevcut verileriniz ve raporlarınız korunuyor ve etkilenmedi.</p><p><a href="${link}">Ödeme yöntemini güncelle</a></p>`,
  });
}

export async function sendPaymentRecoveredEmail(
  recipient: BillingNotificationRecipient,
  params: { organizationName: string; stillRestrictedByDispute: boolean },
): Promise<void> {
  const link = billingManagementUrl();
  const orgName = escapeHtml(params.organizationName);
  // Görev talimatı: "Do not imply dispute restrictions have cleared if a
  // YF-815 dispute still restricts the account" — bkz.
  // `lib/billing/billing-restriction-policy.ts` dosya başı notu (dunning ve
  // dispute BAĞIMSIZ sinyallerdir, biri diğerini ZAYIFLATMAZ). Bu yüzden
  // kurtarma metni, çözülmemiş bir uyuşmazlık VARSA erişimin tamamen
  // normale döndüğünü ASLA iddia etmez.
  const text = params.stillRestrictedByDispute
    ? `Merhaba ${recipient.firstName},\n\n${params.organizationName} organizasyonunuz için ödeme sorunu çözüldü.\n\nAncak hesabınızda çözülmemiş, ayrı bir ödeme itirazı (chargeback) bulunduğundan yeni ücretli özellik kullanımı hâlâ kısıtlı durumdadır. Durumu görüntülemek için: ${link}`
    : `Merhaba ${recipient.firstName},\n\n${params.organizationName} organizasyonunuz için ödeme sorunu çözüldü ve normal erişiminiz geri yüklendi.\n\nFaturalama bilgilerinizi görüntülemek için: ${link}`;
  const html = params.stillRestrictedByDispute
    ? `<p>Merhaba ${escapeHtml(recipient.firstName)},</p><p><strong>${orgName}</strong> organizasyonunuz için ödeme sorunu çözüldü.</p><p>Ancak hesabınızda çözülmemiş, ayrı bir ödeme itirazı (chargeback) bulunduğundan yeni ücretli özellik kullanımı hâlâ kısıtlı durumdadır.</p><p><a href="${link}">Faturalama durumunu görüntüle</a></p>`
    : `<p>Merhaba ${escapeHtml(recipient.firstName)},</p><p><strong>${orgName}</strong> organizasyonunuz için ödeme sorunu çözüldü ve normal erişiminiz geri yüklendi.</p><p><a href="${link}">Faturalama bilgilerini görüntüle</a></p>`;
  await sendMail({
    to: recipient.email,
    subject: params.stillRestrictedByDispute
      ? "YapiFin — Ödeme sorunu çözüldü (hesap kısmen kısıtlı kalıyor)"
      : "YapiFin — Ödeme sorunu çözüldü",
    text,
    html,
  });
}
