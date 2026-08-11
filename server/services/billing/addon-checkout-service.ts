import type { StripeEnvironment } from "@prisma/client";
import { db } from "@/lib/db";
import { writeAuditLog } from "@/lib/audit";
import { canManageOrganizationSettings } from "@/lib/permissions";
import { forbidden } from "@/server/services/errors";
import { getEnv } from "@/lib/env";
import { getStripeConfig } from "@/lib/billing/stripe-config";
import { resolveAddonPrice, type AddonCatalogEntry } from "@/lib/billing/addon-catalog";
import { resolveStripeGateway } from "@/lib/billing/stripe-gateway";
import { ensureOrganizationStripeCustomer } from "@/server/services/billing/stripe-customer-service";
import type { SessionUser } from "@/lib/auth/session";

/**
 * YF-813 — kullanım/ek-kota (add-on/top-up) paketleri için kendi kendine
 * Stripe Checkout başlatma servisi (mode: "payment", tek seferlik).
 *
 * ## Mimari sözleşme (YF-809 ile AYNI, değiştirilemez)
 *
 * Bu servis Stripe'ta bir Checkout Session OLUŞTURUR — hiçbir koşulda
 * `UsageAddonGrant` YAZMAZ/kota KAZANDIRMAZ. Bağış doğruluğunun TEK kaynağı
 * YF-810 webhook boru hattına eklenen onay adımıdır (bkz.
 * server/services/billing/addon-grant-service.ts `confirmAddonCheckoutSession`)
 * — tarayıcının Checkout'tan başarılı dönmesi (`success_url`) BUNU
 * TETİKLEMEZ.
 *
 * ## Girdi güveni
 *
 * İstemciden yalnızca kanonik `addonKey` kabul edilir. Stripe Price ID,
 * tutar, para birimi, bağışlanacak miktar, kaynak (`resource`), Stripe
 * Customer ID veya `organizationId` istemciden ASLA alınmaz — fiyat/miktar
 * `resolveAddonPrice()` ile sunucu tarafında kanonik katalogdan (bkz.
 * lib/billing/addon-catalog.ts) çözülür, müşteri `ensureOrganizationStripeCustomer()`
 * ile oturumdan türetilir, dönüş URL'leri sabit uygulama yapılandırmasından
 * üretilir.
 *
 * ## Yetki
 *
 * Yalnızca **OWNER** (`canManageOrganizationSettings`) — YF-808/YF-809 ile
 * AYNI, ödeme başlatma yetki sınırı.
 *
 * ## Idempotency (YF-809'dan KASITLI olarak FARKLI)
 *
 * Plan aboneliği Checkout'u (YF-809) "organizasyonun aynı anda TEK açık
 * denemesi olabilir" modeline uyar (bkz. `OrganizationCheckoutAttempt`) —
 * bu, bir add-on satın alımı için YANLIŞ modeldir: bir organizasyon AYNI
 * anda birden fazla FARKLI paket (ör. AI + OCR) satın alabilmeli VE aynı
 * paketten TEKRAR TEKRAR (ör. birkaç AI kredi paketi) satın alabilmelidir —
 * bu yüzden yeni bir "tek açık deneme" rezervasyon tablosu İCAT EDİLMEZ.
 * Bunun yerine, Stripe idempotency anahtarı KISA bir zaman penceresine
 * (`ADDON_CHECKOUT_IDEMPOTENCY_WINDOW_MS`) göre bucket'lanır:
 * aynı organizasyon+paket için AYNI pencerede yapılan istekler (ör. çift
 * tıklama/ağ yeniden denemesi) Stripe'ta AYNI Checkout Session'a düşer
 * (mükerrer ödeme oluşmaz); pencere geçtikten SONRAKİ bir istek YENİ,
 * meşru bir satın alma olarak ele alınır (bkz. addon-grant-service.ts
 * `buildAddonGrantIdempotencyKey` — bu, GERÇEK bağış idempotency'sinin
 * kaynağıdır, Checkout Session'ın kendi Stripe ID'sinden türetilir; aşağıdaki
 * anahtar yalnızca Checkout Session OLUŞTURMA aşamasının mükerrer
 * tıklamaya karşı korunmasıdır).
 */

const ADDON_CHECKOUT_AUDIT_ACTION = "billing.addon_checkout.create";

/** Bkz. dosya başı "Idempotency" notu. */
export const ADDON_CHECKOUT_IDEMPOTENCY_WINDOW_MS = 60_000;

/**
 * Deterministik, ama yalnızca `ADDON_CHECKOUT_IDEMPOTENCY_WINDOW_MS`'lik bir
 * pencere İÇİNDE sabit — `buildCheckoutIdempotencyKey` (YF-809, zaman
 * bileşeni TAŞIMAZ) ile KASITLI olarak FARKLI (bkz. dosya başı not).
 */
export function buildAddonCheckoutIdempotencyKey(
  organizationId: string,
  environment: StripeEnvironment,
  addonKey: string,
  now: number = Date.now(),
): string {
  const bucket = Math.floor(now / ADDON_CHECKOUT_IDEMPOTENCY_WINDOW_MS);
  return `yapifin:${environment.toLowerCase()}:addon_checkout:${organizationId}:${addonKey}:${bucket}`;
}

/** Sunucu tarafında, sabit uygulama yapılandırmasından üretilir — istemciden hiçbir dönüş URL'i kabul edilmez (bkz. checkout-service.ts AYNI desen). */
function buildSuccessUrl(): string {
  const base = getEnv().NEXT_PUBLIC_APP_URL.replace(/\/+$/, "");
  return `${base}/settings/plan/addons/checkout/success?session_id={CHECKOUT_SESSION_ID}`;
}

function buildCancelUrl(): string {
  const base = getEnv().NEXT_PUBLIC_APP_URL.replace(/\/+$/, "");
  return `${base}/settings/plan/addons/checkout/cancel`;
}

export interface PurchaseAddonInput {
  readonly addonKey: string;
}

export interface AddonCheckoutSession {
  readonly checkoutUrl: string;
  readonly addonKey: string;
}

/**
 * Çağıranın organizasyonu için, seçilen ek-kota paketinde bir Stripe
 * Checkout Session (tek seferlik `payment` modu) oluşturur ve barındırmalı
 * ödeme sayfasının URL'ini döner.
 *
 * **Bu fonksiyon ÇAĞRILMASI hiçbir kota KAZANDIRMAZ** — bkz. dosya başı not.
 */
export async function createAddonCheckoutSession(
  actor: SessionUser,
  input: PurchaseAddonInput,
): Promise<AddonCheckoutSession> {
  if (!canManageOrganizationSettings(actor.role)) {
    throw forbidden("Yalnızca firma sahibi ek paket satın alabilir");
  }

  // Fail-closed: bilinmeyen addonKey veya yapılandırılmamış/tutarsız Stripe
  // kurulumunda burada BillingConfigError fırlatılır (server action katmanı
  // bunu genel, güvenli bir hataya çevirir — bkz. lib/action-error.ts).
  const { entry, priceId }: { entry: AddonCatalogEntry; priceId: string } = resolveAddonPrice(input.addonKey);

  // OWNER-only + fail-closed yapılandırma kontrolü burada TEKRAR uygulanır —
  // istemciden gelen hiçbir organizationId/Stripe kimliği kabul edilmez.
  const customer = await ensureOrganizationStripeCustomer(actor);

  const { environment } = getStripeConfig();
  const organizationId = actor.organizationId;
  const idempotencyKey = buildAddonCheckoutIdempotencyKey(organizationId, environment, entry.addonKey);

  const gateway = resolveStripeGateway();
  const session = await gateway.createAddonCheckoutSession({
    organizationId,
    customerId: customer.stripeCustomerId,
    priceId,
    addonKey: entry.addonKey,
    successUrl: buildSuccessUrl(),
    cancelUrl: buildCancelUrl(),
    idempotencyKey,
  });

  await db.$transaction((tx) =>
    writeAuditLog(tx, {
      organizationId,
      actorId: actor.id,
      action: ADDON_CHECKOUT_AUDIT_ACTION,
      entityType: "OrganizationStripeCustomer",
      entityId: organizationId,
      after: { addonKey: entry.addonKey, environment, stripeCheckoutSessionId: session.id },
    }),
  );

  return { checkoutUrl: session.url, addonKey: entry.addonKey };
}
