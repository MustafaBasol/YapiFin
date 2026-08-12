import { canManageOrganizationSettings } from "@/lib/permissions";
import { forbidden } from "@/server/services/errors";
import { getEnv } from "@/lib/env";
import { db } from "@/lib/db";
import { resolveStripeGateway } from "@/lib/billing/stripe-gateway";
import { ensureOrganizationStripeCustomer } from "@/server/services/billing/stripe-customer-service";
import { writeAuditLog } from "@/lib/audit";
import type { SessionUser } from "@/lib/auth/session";

/**
 * YF-811 — Stripe'ın KENDİ barındırdığı Faturalama Portalına (Billing
 * Portal) güvenli, sunucu tarafında başlatılan yönlendirme. YF-814, bu
 * servisi minimal bir "ödeme yöntemini güncelle" CTA'sı için önceden inşa
 * etmişti (bkz. git geçmişi) — YF-811 o TEK gateway çağrısının (bkz.
 * `lib/billing/stripe-gateway.ts` `CreateBillingPortalSessionParams` dosya
 * başı notu) üzerine ikinci bir portal mimarisi İCAT ETMEDEN genel
 * kendi-kendine-hizmet (self-service) giriş noktasını (`/settings/plan`
 * üzerindeki daima-görünür "Faturalamayı Yönet" kartı, bkz.
 * `components/app/billing-subscription-card.tsx`) ekler. Checkout akışının
 * aksine (bkz. checkout-service.ts) burada rezervasyon/idempotency-key
 * mekanizması GEREKMEZ — bu çağrı hiçbir finansal mutasyon/kota YARATMAZ,
 * yalnızca salt-okunur bir yönlendirme URL'i üretir; art arda çağrılması
 * Stripe tarafında zaten doğal olarak güvenlidir (her çağrı kendi, kısa
 * ömürlü bir portal oturumu oluşturur).
 *
 * Portal içindeki tüm işlemler (ödeme yöntemi güncelleme, iptal, plan
 * değişikliği) Stripe'ın KENDİ barındırdığı arayüzünde gerçekleşir — bu
 * fonksiyon hiçbir abonelik/entitlement durumu MUTASYONA UĞRATMAZ. Portal
 * dönüşü SONRASI gerçek durum HER ZAMAN mevcut YF-810 webhook/mutabakat
 * boru hattından (bkz. webhook-service.ts `syncSubscriptionFromStripe`)
 * yakınsar — bu servis o mimariyi TEKRARLAMAZ.
 */

function buildPortalReturnUrl(): string {
  const base = getEnv().NEXT_PUBLIC_APP_URL.replace(/\/+$/, "");
  return `${base}/settings/plan`;
}

export interface BillingPortalSession {
  readonly url: string;
}

export async function createOrganizationBillingPortalSession(actor: SessionUser): Promise<BillingPortalSession> {
  if (!canManageOrganizationSettings(actor.role)) {
    throw forbidden("Yalnızca firma sahibi faturalama portalını açabilir");
  }

  // İstemciden hiçbir Stripe müşteri kimliği/dönüş URL'i kabul edilmez —
  // `checkout-service.ts createPlanCheckoutSession` İLE AYNI güven sınırı.
  const customer = await ensureOrganizationStripeCustomer(actor);
  const gateway = resolveStripeGateway();
  const session = await gateway.createBillingPortalSession({
    customerId: customer.stripeCustomerId,
    returnUrl: buildPortalReturnUrl(),
  });

  // Her gerçek kullanıcı tıklaması burada bire bir yeni bir audit kaydı
  // ÜRETİR (webhook-service.ts'teki İDEMPOTENT no-op koruması BURADA
  // GEÇERSİZDİR — o yalnızca webhook TEKRARI/replay için tasarlanmıştır;
  // bu fonksiyon webhook'tan HİÇ tetiklenmez, doğrudan bir OWNER eylemidir).
  // Stripe'ın döndürdüğü kısa ömürlü, sırlı `session.url` ASLA loglanmaz.
  await db.$transaction((tx) =>
    writeAuditLog(tx, {
      organizationId: actor.organizationId,
      actorId: actor.id,
      action: "billing.portal.session_created",
      entityType: "Organization",
      entityId: actor.organizationId,
      after: { environment: customer.environment, stripeCustomerId: customer.stripeCustomerId },
    }),
  );

  return { url: session.url };
}
