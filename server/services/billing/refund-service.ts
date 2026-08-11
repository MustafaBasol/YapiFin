import type {
  Prisma,
  StripeEnvironment,
  StripeRefundStatus as PrismaRefundStatus,
  StripeRefundPolicyState,
} from "@prisma/client";
import { db } from "@/lib/db";
import { writeAuditLog } from "@/lib/audit";
import { canManageOrganizationSettings } from "@/lib/permissions";
import { forbidden, notFound } from "@/server/services/errors";
import { checkLimit, lockOrganizationForEntitlement } from "@/lib/entitlements/entitlement-service";
import { expireUsageAddonGrant } from "@/lib/entitlements/usage-addons";
import { isLimitId } from "@/lib/entitlements/capabilities";
import { getStripeConfig } from "@/lib/billing/stripe-config";
import { resolveStripeGateway, type StripeRefundRef } from "@/lib/billing/stripe-gateway";
import type { SessionUser } from "@/lib/auth/session";

/**
 * YF-815 — Stripe iade (refund) senkronizasyonu ve YF-803 `UsageAddonGrant`
 * politika uygulaması.
 *
 * ## Refetch-on-write (YF-810/YF-813 ile AYNI ilke)
 *
 * `applyRefundSnapshot`, hangi olay (`refund.created`/`refund.updated`/
 * `refund.failed` VEYA manuel mutabakat) tetiklediğinden BAĞIMSIZ olarak
 * HER ZAMAN çağıranın Stripe'tan YENİDEN ÇEKTİĞİ (`gateway.retrieveRefund`)
 * güncel `StripeRefundRef` anlık görüntüsüyle çalışır ve
 * `(environment, stripeRefundId)` üzerinde UPSERT eder — sıra-dışı/tekrarlı
 * teslimat AYNI sonuca yakınsar (Case D/E).
 *
 * ## Add-on iade politikası (görev talimatı "Case A/B/C")
 *
 * Yalnızca Stripe'ın TERMİNAL "succeeded" durumu bir politika eylemi
 * TETİKLER; `pending`/`requires_action`/`failed`/`canceled` yalnızca KAYIT
 * altına alınır, hiçbir bağış MUTASYONA UĞRAMAZ.
 *
 * İade, `paymentIntentId` üzerinden `UsageAddonGrant.metadata
 * .stripePaymentIntentId` korelasyonuyla (bkz. YF-813
 * addon-grant-service.ts) bir bağışa bağlanabiliyorsa:
 *
 * - **Charge TAM olarak iade edildiyse** (`gateway.retrieveCharge(...)
 *   .refunded === true`) — bağış HER ZAMAN `expireUsageAddonGrant` ile
 *   sonlandırılır (bu, yalnızca GELECEKTEKİ kota sayımını durdurur; geçmiş
 *   kullanım kaydı — `AiUsageLedger`/`DocumentExtraction` — ASLA
 *   silinmez/mutasyona uğratılmaz, bkz. o fonksiyonun kendi "hard delete
 *   yok" notu). Organizasyonun bu kaynak için GÜNCEL kullanımı, BU bağış
 *   OLMADAN da mevcut üst sınırı aşmıyorsa (`used <= max - grant.amount`)
 *   bağış hiç GEREKMEMİŞ demektir → `GRANT_EXPIRED` (Case A). Aksi halde
 *   bağış EN AZINDAN KISMEN gerekliymiş demektir → `EXPIRED_AFTER_CONSUMPTION`
 *   (Case C) — negatif kota OLUŞMAZ (`checkLimit`'in `isOverLimit` alanı
 *   zaten yalnızca bilgilendiricidir, hiçbir kaydı SİLMEZ/ENGELLEMEZ), ancak
 *   destek/ops takibi için `manualReviewNote` doldurulur.
 * - **Charge KISMİ iade edildiyse** — kasıtlı olarak `RETAINED`: HİÇBİR
 *   bağış mutasyonu YAPILMAZ (görev talimatı "do not guess a proportional
 *   quota clawback unless a clear deterministic product rule exists" —
 *   burada YOK, bu yüzden güvenli varsayılan: kayıt tut, dokunma).
 *
 * Bir aboneliğe (plan ödemesi) ait bir iade — `paymentIntentId` hiçbir
 * `UsageAddonGrant`'a bağlanamaz — yalnızca `NOT_APPLICABLE` olarak
 * KAYDEDİLİR; **`Organization.planId`/`OrganizationStripeSubscription` ASLA
 * dokunulmaz** (görev talimatı madde 4 — abonelik iadesi otomatik olarak
 * iptal/geri alma ANLAMINA GELMEZ; entitlement'in TEK doğruluk kaynağı
 * `customer.subscription.*`/`invoice.payment_*` olaylarının işlediği
 * `syncSubscriptionFromStripe`'tır, bkz. webhook-service.ts).
 *
 * ## Finansal sınır
 *
 * Bu dosya `FinancialTransaction` (veya herhangi bir proje geliri/gideri/
 * bütçe/nakit akışı kaydı) ASLA OLUŞTURMAZ/OKUMAZ/MUTASYONA UĞRATMAZ —
 * YapiFin SaaS faturalaması tenant'ın inşaat/proje muhasebesinden TAMAMEN
 * AYRIDIR (görev talimatı kritik sınır).
 */

type Tx = Prisma.TransactionClient;

/** Stripe API "2026-07-29.dahlia" `Refund.status` -> yerel enum (bkz. `StripeSubscriptionStatus` `toSubscriptionStatus` ile AYNI fail-closed desen). */
function toRefundStatus(raw: string | null): PrismaRefundStatus {
  switch (raw) {
    case "pending":
      return "PENDING";
    case "requires_action":
      return "REQUIRES_ACTION";
    case "succeeded":
      return "SUCCEEDED";
    case "failed":
      return "FAILED";
    case "canceled":
      return "CANCELED";
    default:
      return "UNKNOWN";
  }
}

/**
 * YF-813 `UsageAddonGrant.metadata.stripePaymentIntentId` korelasyonu
 * üzerinden ilgili bağışı bulur — YENİ bir FK/indeksli sütun İCAT EDİLMEZ
 * (bkz. `UsageAddonGrant` model başlık yorumu). `organizationId` ile
 * scope'lanır (tenant izolasyonu — bkz. görev talimatı madde 11).
 */
async function findUsageAddonGrantByPaymentIntent(client: Tx, organizationId: string, paymentIntentId: string) {
  return client.usageAddonGrant.findFirst({
    where: { organizationId, metadata: { path: ["stripePaymentIntentId"], equals: paymentIntentId } },
  });
}

interface ApplyRefundParams {
  readonly organizationId: string;
  readonly environment: StripeEnvironment;
  readonly refund: StripeRefundRef;
  readonly eventId: string;
  readonly eventCreatedAt: Date;
}

async function applyRefundSnapshot(params: ApplyRefundParams): Promise<void> {
  const gateway = resolveStripeGateway();
  const status = toRefundStatus(params.refund.status);
  const chargeId = params.refund.chargeId ?? "";

  await db.$transaction(async (tx) => {
    await lockOrganizationForEntitlement(tx, params.organizationId);

    const existing = await tx.stripeRefund.findUnique({
      where: { environment_stripeRefundId: { environment: params.environment, stripeRefundId: params.refund.id } },
    });

    let policyState: StripeRefundPolicyState = existing?.policyState ?? "NOT_APPLICABLE";
    let relatedUsageAddonGrantId: string | null = existing?.relatedUsageAddonGrantId ?? null;
    let manualReviewNote: string | null = existing?.manualReviewNote ?? null;

    // Yalnızca TERMİNAL "succeeded" durumu bir politika eylemi tetikler —
    // bkz. dosya başı notu. `existing` zaten bir politika eylemi
    // uyguladıysa (GRANT_EXPIRED/EXPIRED_AFTER_CONSUMPTION/RETAINED)
    // tekrar DEĞERLENDİRİLMEZ — `expireUsageAddonGrant` zaten kendi
        // idempotenttir, ama "kaç kez expire edildi" gözlemlenebilirliği
        // için burada da tek seferlik değerlendirme tercih edilir (Case D).
    if (status === "SUCCEEDED" && policyState === "NOT_APPLICABLE" && params.refund.paymentIntentId) {
      const grant = await findUsageAddonGrantByPaymentIntent(tx, params.organizationId, params.refund.paymentIntentId);

      if (grant && isLimitId(grant.resource)) {
        relatedUsageAddonGrantId = grant.id;
        const charge = await gateway.retrieveCharge(chargeId);
        const isFullChargeRefund = charge?.refunded ?? false;

        if (isFullChargeRefund) {
          const limitResult = await checkLimit(tx, params.organizationId, grant.resource);
          const maxWithoutThisGrant = limitResult.max === null ? null : Math.max(limitResult.max - grant.amount, 0);
          const wasEffectivelyUnused = maxWithoutThisGrant === null || limitResult.used <= maxWithoutThisGrant;

          await expireUsageAddonGrant(tx, params.organizationId, grant.id, new Date());

          if (wasEffectivelyUnused) {
            policyState = "GRANT_EXPIRED";
          } else {
            policyState = "EXPIRED_AFTER_CONSUMPTION";
            manualReviewNote = `Tam iade — organizasyonun "${grant.resource}" kaynağı için güncel kullanımı bu bağış olmadan üst sınırı aşabilir; geçmiş kullanım korunur, destek takibi önerilir.`;
          }
        } else {
          policyState = "RETAINED";
        }
      }
    }

    const isNewRow = !existing;
    const changed = isNewRow || existing.status !== status || existing.policyState !== policyState;

    const data = {
      organizationId: params.organizationId,
      environment: params.environment,
      stripeRefundId: params.refund.id,
      stripeChargeId: chargeId,
      stripePaymentIntentId: params.refund.paymentIntentId,
      status,
      policyState,
      amount: params.refund.amount,
      currency: params.refund.currency,
      reason: params.refund.reason,
      relatedUsageAddonGrantId,
      manualReviewNote,
      lastProcessedEventId: params.eventId,
      lastProcessedEventCreatedAt: params.eventCreatedAt,
    };

    await tx.stripeRefund.upsert({
      where: { environment_stripeRefundId: { environment: params.environment, stripeRefundId: params.refund.id } },
      create: data,
      update: data,
    });

    if (changed) {
      await writeAuditLog(tx, {
        organizationId: params.organizationId,
        actorId: null,
        action: isNewRow ? "billing.refund.observed" : "billing.refund.status_changed",
        entityType: "StripeRefund",
        entityId: params.refund.id,
        before: existing ? { status: existing.status, policyState: existing.policyState } : undefined,
        after: { status, policyState, amount: params.refund.amount, currency: params.refund.currency, relatedUsageAddonGrantId },
      });
    }
  });
}

export interface ProcessRefundResult {
  readonly outcome: "PROCESSED" | "IGNORED";
  readonly reason?: string;
}

interface ProcessRefundParams {
  readonly refundId: string;
  readonly organizationId: string;
  readonly environment: StripeEnvironment;
  /** Çağıranın kanonik `OrganizationStripeCustomer` eşlemesinden ÖNCEDEN çözdüğü BEKLENEN müşteri kimliği — tenant çapraz doğrulaması için. */
  readonly expectedStripeCustomerId: string;
  readonly eventId: string;
  readonly eventCreatedAt: Date;
}

/** YF-810 webhook boru hattından (`processStripeWebhookEvent`, REFUND kind) çağrılır. */
export async function processRefundWebhookEvent(params: ProcessRefundParams): Promise<ProcessRefundResult> {
  const gateway = resolveStripeGateway();
  const refund = await gateway.retrieveRefund(params.refundId);
  if (!refund) return { outcome: "IGNORED", reason: "REFUND_NOT_FOUND" };

  if (refund.customerId !== params.expectedStripeCustomerId) {
    console.error(
      JSON.stringify({
        level: "error",
        event: "billing.refund_webhook.tenant_mismatch",
        organizationId: params.organizationId,
        stripeRefundId: params.refundId,
      }),
    );
    return { outcome: "IGNORED", reason: "CUSTOMER_MISMATCH" };
  }

  await applyRefundSnapshot({
    organizationId: params.organizationId,
    environment: params.environment,
    refund,
    eventId: params.eventId,
    eventCreatedAt: params.eventCreatedAt,
  });
  return { outcome: "PROCESSED" };
}

export interface ReconcileRefundResult {
  readonly found: boolean;
  readonly status: PrismaRefundStatus | null;
  readonly policyState: StripeRefundPolicyState | null;
}

/**
 * YF-815 — dahili/manuel mutabakat girişi (`reconcileOrganizationStripeSubscription`/
 * `reconcileAddonPurchase` ile AYNI desen). Webhook teslimatı kaçırıldıysa
 * veya bir support/ops akışı bilinen bir Stripe iade kimliğini (ör. Stripe
 * panelinden görülen `re_...`) doğrudan gördüyse kullanılır. `applyRefundSnapshot`'ı
 * kullandığı için DOĞASI GEREĞİ idempotenttir.
 */
export async function reconcileRefund(actor: SessionUser, stripeRefundId: string): Promise<ReconcileRefundResult> {
  if (!canManageOrganizationSettings(actor.role)) {
    throw forbidden("Yalnızca firma sahibi faturalama işlemlerini yeniden senkronize edebilir");
  }
  if (!stripeRefundId) throw notFound("İade bulunamadı");

  const { environment } = getStripeConfig();
  const organizationId = actor.organizationId;

  const mapping = await db.organizationStripeCustomer.findUnique({
    where: { organizationId_environment: { organizationId, environment } },
    select: { stripeCustomerId: true },
  });
  if (!mapping) throw notFound("Bu organizasyon için henüz bir Stripe müşteri kaydı yok");

  const gateway = resolveStripeGateway();
  const refund = await gateway.retrieveRefund(stripeRefundId);
  if (!refund) return { found: false, status: null, policyState: null };

  if (refund.customerId !== mapping.stripeCustomerId) {
    // Tenant sızıntısı önlenir — başka bir organizasyona ait bir iadenin
    // VARLIĞI bile sızdırılmaz (bkz. görev talimatı madde 11 "disclose no
    // object existence").
    return { found: false, status: null, policyState: null };
  }

  await applyRefundSnapshot({
    organizationId,
    environment,
    refund,
    eventId: `reconcile:${organizationId}:${stripeRefundId}`,
    eventCreatedAt: new Date(),
  });

  const updated = await db.stripeRefund.findUnique({
    where: { environment_stripeRefundId: { environment, stripeRefundId } },
  });
  return { found: true, status: updated?.status ?? null, policyState: updated?.policyState ?? null };
}

/**
 * YF-815 — bir organizasyonun YEREL olarak bilinen ama HENÜZ terminal
 * olmayan (`PENDING`/`REQUIRES_ACTION`) iade kayıtlarını Stripe'ın GÜNCEL
 * gerçeğiyle yeniden hizalar. Yeni bir cron/sweep İCAT EDİLMEZ — yalnızca
 * ZATEN yerel olarak bilinen (en az bir webhook/mutabakat ile daha önce
 * görülmüş) satırları kapsar; tamamen kaçırılmış BİR İLK olay için
 * `reconcileRefund(actor, stripeRefundId)` (bilinen bir referansla, ör.
 * destek ekranından) kullanılmalıdır (bkz. görev talimatı "do not introduce
 * a background cron unless clearly justified").
 */
export async function reconcilePendingOrganizationRefunds(organizationId: string, environment: StripeEnvironment): Promise<number> {
  const pending = await db.stripeRefund.findMany({
    where: { organizationId, environment, status: { in: ["PENDING", "REQUIRES_ACTION"] } },
    select: { stripeRefundId: true },
  });

  const gateway = resolveStripeGateway();
  let reconciledCount = 0;
  for (const row of pending) {
    const refund = await gateway.retrieveRefund(row.stripeRefundId);
    if (!refund) continue;
    await applyRefundSnapshot({
      organizationId,
      environment,
      refund,
      eventId: `reconcile-sweep:${organizationId}:${row.stripeRefundId}`,
      eventCreatedAt: new Date(),
    });
    reconciledCount += 1;
  }
  return reconciledCount;
}
