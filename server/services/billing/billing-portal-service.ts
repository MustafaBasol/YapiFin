import { canManageOrganizationSettings } from "@/lib/permissions";
import { forbidden } from "@/server/services/errors";
import { getEnv } from "@/lib/env";
import { resolveStripeGateway } from "@/lib/billing/stripe-gateway";
import { ensureOrganizationStripeCustomer } from "@/server/services/billing/stripe-customer-service";
import type { SessionUser } from "@/lib/auth/session";

/**
 * YF-814 — görev talimatı madde 7: YF-811 (tam Customer Portal) henüz
 * UYGULANMAMIŞ. Bu servis o kapsamı İNŞA ETMEZ — yalnızca "ödeme yöntemini
 * güncelle" CTA'sı için Stripe'ın KENDİ barındırdığı Faturalama Portalına
 * TEK seferlik, GÜVENLİ bir yönlendirme sağlar (bkz.
 * `lib/billing/stripe-gateway.ts` `CreateBillingPortalSessionParams` dosya
 * başı notu). Checkout akışının aksine (bkz. checkout-service.ts) burada
 * rezervasyon/idempotency-key mekanizması GEREKMEZ — bu çağrı hiçbir
 * finansal mutasyon/kota YARATMAZ, yalnızca salt-okunur bir yönlendirme
 * URL'i üretir; art arda çağrılması Stripe tarafında zaten doğal olarak
 * güvenlidir (her çağrı kendi, kısa ömürlü bir portal oturumu oluşturur).
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
  return { url: session.url };
}
