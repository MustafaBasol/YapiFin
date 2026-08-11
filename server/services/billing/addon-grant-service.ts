import type { StripeEnvironment, UsageAddonGrant } from "@prisma/client";
import { db } from "@/lib/db";
import { writeAuditLog } from "@/lib/audit";
import { canManageOrganizationSettings } from "@/lib/permissions";
import { forbidden, notFound } from "@/server/services/errors";
import { lockOrganizationForEntitlement } from "@/lib/entitlements/entitlement-service";
import { grantUsageAddon } from "@/lib/entitlements/usage-addons";
import { getStripeConfig } from "@/lib/billing/stripe-config";
import { resolveAddonPrice } from "@/lib/billing/addon-catalog";
import { resolveStripeGateway } from "@/lib/billing/stripe-gateway";
import type { SessionUser } from "@/lib/auth/session";

/**
 * YF-813 — bir add-on (kullanım/ek-kota top-up) Checkout Session'ının
 * AUTHORİTATİF ödeme onayı ve tam olarak BİR `UsageAddonGrant` üretimi.
 *
 * ## Tek doğrulama/bağış noktası
 *
 * `confirmAddonCheckoutSession`, hem YF-810 webhook boru hattından (bkz.
 * server/services/billing/webhook-service.ts — `checkout.session.completed`/
 * `checkout.session.async_payment_succeeded`, mode=payment) HEM DE manuel
 * mutabakattan (`reconcileAddonPurchase`, bkz. app/actions/billing.ts
 * `reconcileAddonPurchaseAction`) çağrılır. İkinci bir doğrulama/bağış
 * mantığı İCAT EDİLMEZ — bağış her zaman mevcut YF-803 `grantUsageAddon`'a
 * (bkz. lib/entitlements/usage-addons.ts) delege edilir.
 *
 * ## Doğrulama sırası (hepsi fail-closed — herhangi biri başarısız olursa
 * HİÇBİR yazma yapılmaz)
 *
 * 1. **Refetch-on-write**: Checkout Session Stripe'tan YENİDEN ÇEKİLİR
 *    (`gateway.retrieveCheckoutSessionForAddon`) — hangi olay/tetikleyici
 *    ÖNEMLİ DEĞİLDİR (bkz. lib/billing/stripe-gateway.ts
 *    `AddonCheckoutSessionRef` dosya başı notu, `retrieveSubscription` ile
 *    AYNI strateji).
 * 2. **Mod**: `session.mode !== "payment"` ise yok sayılır (savunma amaçlı
 *    ikinci kontrol — çağıran zaten yalnızca abonelik-DIŞI Checkout
 *    olaylarında bu fonksiyonu çağırır, bkz. webhook-service.ts).
 * 3. **Tenant çapraz doğrulama**: `session.customerId`, çağıranın kanonik
 *    `OrganizationStripeCustomer` eşlemesinden çözdüğü BEKLENEN müşteri
 *    kimliğiyle eşleşmelidir (webhook-service.ts `syncSubscriptionFromStripe`
 *    ile AYNI desen) — uyuşmazlıkta fail-closed, hiçbir yazma yapılmaz.
 * 4. **Ödeme durumu**: yalnızca `payment_status === "paid"` bir bağışı
 *    TETİKLER — `unpaid`/`no_payment_required` (gecikmeli ödeme yöntemi
 *    henüz tamamlanmamış) veya süresi dolmuş/başarısız bir oturum ASLA
 *    bağış ÜRETMEZ.
 * 5. **Katalog + fiyat çapraz doğrulaması**: `session.metadata.yapifin_addon_key`
 *    yalnızca hangi katalog girdisinin DENENECEĞİNİ işaret eder (ikincil
 *    korelasyon — TEK doğruluk kaynağı DEĞİLDİR, bkz. görev talimatı
 *    "metadata may assist correlation but must not be the trust anchor").
 *    Gerçek bağış YALNIZCA Stripe'ın session'da FİİLEN faturaladığı Price
 *    ID'si, o `addonKey` için kataloğun (bkz. lib/billing/addon-catalog.ts)
 *    beklediği Price ID'siyle BİREBİR eşleşirse verilir — bu, istemcinin
 *    (veya tamperlenmiş bir metadata'nın) uydurma/düşük fiyatlı bir Price'a
 *    karşılık yüksek miktarlı bir kota bağışı ELDE ETMESİNİ yapısal olarak
 *    engeller.
 *
 * ## Idempotency
 *
 * Bağış idempotency anahtarı Checkout Session'ın KENDİ Stripe kimliğinden
 * türetilir (`buildAddonGrantIdempotencyKey`) — `checkout.session.completed`
 * VE `checkout.session.async_payment_succeeded` AYNI session için ikisi de
 * ateşlense, webhook YENİDEN TESLİM edilse veya bu fonksiyon eşzamanlı
 * çağrılsa dahi `grantUsageAddon`'un `(organizationId, idempotencyKey)`
 * benzersizliği (bkz. usage-addons.ts P2002 yarış çözümü) TAM OLARAK BİR
 * `UsageAddonGrant` garanti eder.
 */

const GRANT_SOURCE = "stripe_topup";
const GRANT_AUDIT_ACTION = "billing.addon.granted";

/** Deterministik — Checkout Session ID'sinden türetilir (bkz. dosya başı "Idempotency" notu). */
export function buildAddonGrantIdempotencyKey(environment: StripeEnvironment, checkoutSessionId: string): string {
  return `yapifin:${environment.toLowerCase()}:addon_grant:${checkoutSessionId}`;
}

export type ConfirmAddonOutcome =
  | { readonly outcome: "GRANTED"; readonly grant: UsageAddonGrant }
  | { readonly outcome: "ALREADY_GRANTED"; readonly grant: UsageAddonGrant }
  | { readonly outcome: "IGNORED"; readonly reason: string };

interface ConfirmParams {
  readonly checkoutSessionId: string;
  /** Kanonik `OrganizationStripeCustomer` eşlemesinden ÖNCEDEN çözülmüş — bu fonksiyon organizationId'yi ASLA metadata'dan çözmez. */
  readonly organizationId: string;
  readonly environment: StripeEnvironment;
  /** Yukarıdaki `organizationId`'nin kanonik eşlemesindeki Stripe Customer ID'si — tenant çapraz doğrulaması için (bkz. dosya başı madde 3). */
  readonly expectedStripeCustomerId: string;
}

export async function confirmAddonCheckoutSession(params: ConfirmParams): Promise<ConfirmAddonOutcome> {
  const gateway = resolveStripeGateway();
  const session = await gateway.retrieveCheckoutSessionForAddon(params.checkoutSessionId);
  if (!session) return { outcome: "IGNORED", reason: "SESSION_NOT_FOUND" };
  if (session.mode !== "payment") return { outcome: "IGNORED", reason: "NOT_ADDON_SESSION" };

  if (session.customerId !== params.expectedStripeCustomerId) {
    console.error(
      JSON.stringify({
        level: "error",
        event: "billing.addon_webhook.tenant_mismatch",
        organizationId: params.organizationId,
        stripeCheckoutSessionId: params.checkoutSessionId,
      }),
    );
    return { outcome: "IGNORED", reason: "CUSTOMER_MISMATCH" };
  }

  if (session.paymentStatus !== "paid") {
    return { outcome: "IGNORED", reason: "NOT_PAID" };
  }

  const addonKey = session.addonKeyMetadata;
  if (!addonKey) return { outcome: "IGNORED", reason: "ADDON_KEY_MISSING" };

  let resolved: ReturnType<typeof resolveAddonPrice>;
  try {
    resolved = resolveAddonPrice(addonKey);
  } catch {
    return { outcome: "IGNORED", reason: "UNKNOWN_OR_UNCONFIGURED_ADDON_KEY" };
  }

  if (session.priceId !== resolved.priceId) {
    console.error(
      JSON.stringify({
        level: "error",
        event: "billing.addon_webhook.price_mismatch",
        organizationId: params.organizationId,
        stripeCheckoutSessionId: params.checkoutSessionId,
      }),
    );
    return { outcome: "IGNORED", reason: "PRICE_MISMATCH" };
  }

  const idempotencyKey = buildAddonGrantIdempotencyKey(params.environment, session.id);

  return db.$transaction(async (tx) => {
    await lockOrganizationForEntitlement(tx, params.organizationId);

    const existing = await tx.usageAddonGrant.findUnique({
      where: { organizationId_idempotencyKey: { organizationId: params.organizationId, idempotencyKey } },
    });

    const grant = await grantUsageAddon(tx, {
      organizationId: params.organizationId,
      resource: resolved.entry.resource,
      amount: resolved.entry.amount,
      idempotencyKey,
      source: GRANT_SOURCE,
      // Yalnızca güvenli, PII/sır İÇERMEYEN korelasyon alanları (bkz.
      // lib/entitlements/usage-addons.ts GrantUsageAddonInput.metadata notu).
      metadata: {
        stripeCheckoutSessionId: session.id,
        stripePaymentIntentId: session.paymentIntentId,
        addonKey: resolved.entry.addonKey,
      },
      createdById: null,
    });

    if (existing) return { outcome: "ALREADY_GRANTED" as const, grant };

    await writeAuditLog(tx, {
      organizationId: params.organizationId,
      actorId: null,
      action: GRANT_AUDIT_ACTION,
      entityType: "UsageAddonGrant",
      entityId: grant.id,
      after: {
        addonKey: resolved.entry.addonKey,
        resource: resolved.entry.resource,
        amount: resolved.entry.amount,
        stripeCheckoutSessionId: session.id,
      },
    });
    return { outcome: "GRANTED" as const, grant };
  });
}

export interface ReconcileAddonResult {
  readonly outcome: ConfirmAddonOutcome["outcome"];
}

/**
 * YF-813 — kullanıcı tetiklemeli mutabakat (bkz. `ReconcileBillingButton`
 * YF-810 deseninin add-on karşılığı). `checkoutSessionId` her zaman
 * çağıranın KENDİ, az önce tamamladığı Checkout akışının `session_id`
 * dönüş parametresinden gelir (bkz. app/(app)/settings/plan/addons/checkout/
 * success/page.tsx) — organizasyon kimliği yine oturumdan (`actor`) türetilir,
 * pasted/tahmin edilmiş bir sessionId BAŞKA bir organizasyona ait olsa dahi
 * `confirmAddonCheckoutSession`'ın tenant çapraz doğrulaması (madde 3) onu
 * fail-closed reddeder — hiçbir kaynağın VARLIĞI/durumu sızdırılmaz.
 */
export async function reconcileAddonPurchase(actor: SessionUser, checkoutSessionId: string): Promise<ReconcileAddonResult> {
  if (!canManageOrganizationSettings(actor.role)) {
    throw forbidden("Yalnızca firma sahibi ek paket satın alma durumunu yeniden senkronize edebilir");
  }
  if (!checkoutSessionId) throw notFound("Ödeme oturumu bulunamadı");

  const { environment } = getStripeConfig();
  const organizationId = actor.organizationId;

  const mapping = await db.organizationStripeCustomer.findUnique({
    where: { organizationId_environment: { organizationId, environment } },
    select: { stripeCustomerId: true },
  });
  if (!mapping) throw notFound("Bu organizasyon için henüz bir Stripe müşteri kaydı yok");

  const result = await confirmAddonCheckoutSession({
    checkoutSessionId,
    organizationId,
    environment,
    expectedStripeCustomerId: mapping.stripeCustomerId,
  });
  return { outcome: result.outcome };
}

export interface AddonPurchaseStatus {
  readonly confirmed: boolean;
  readonly resource?: string;
  readonly amount?: number;
}

/**
 * YF-813 — success sayfası için SALT OKUNUR durum sorgusu. Stripe'a HİÇ
 * gitmez (yalnızca DB okur) — bir bağışın zaten var olup olmadığını
 * deterministik biçimde (checkout session ID'den türetilen idempotency
 * anahtarıyla) kontrol eder. **Bu fonksiyon ASLA bir bağış OLUŞTURMAZ** —
 * yalnızca `confirmAddonCheckoutSession`'ın (webhook veya
 * `reconcileAddonPurchase` üzerinden) daha önce başarıyla tamamlanıp
 * tamamlanmadığını gösterir (bkz. görev talimatı "success redirect must not
 * claim quota is available unless webhook processing has confirmed").
 * Sonuç her zaman `actor.organizationId` ile scope edilir — başka bir
 * organizasyona ait bir sessionId, o organizasyonun bağışını SIZDIRMAZ
 * (bulunamaz, `confirmed: false` döner).
 */
export async function getAddonPurchaseStatus(actor: SessionUser, checkoutSessionId: string): Promise<AddonPurchaseStatus> {
  const { environment } = getStripeConfig();
  const idempotencyKey = buildAddonGrantIdempotencyKey(environment, checkoutSessionId);
  const grant = await db.usageAddonGrant.findUnique({
    where: { organizationId_idempotencyKey: { organizationId: actor.organizationId, idempotencyKey } },
    select: { resource: true, amount: true },
  });
  if (!grant) return { confirmed: false };
  return { confirmed: true, resource: grant.resource, amount: grant.amount };
}
