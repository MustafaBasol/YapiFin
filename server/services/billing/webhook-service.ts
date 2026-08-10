import type { Prisma, StripeEnvironment, StripeSubscriptionStatus as PrismaSubscriptionStatus } from "@prisma/client";
import { db } from "@/lib/db";
import { writeAuditLog } from "@/lib/audit";
import { canManageOrganizationSettings } from "@/lib/permissions";
import { forbidden, notFound, ServiceError } from "@/server/services/errors";
import { lockOrganizationForEntitlement } from "@/lib/entitlements/entitlement-service";
import { getStripeConfig, resolvePlanForStripePrice } from "@/lib/billing/stripe-config";
import {
  resolveStripeGateway,
  type StripeSubscriptionRef,
  type StripeWebhookEventRef,
} from "@/lib/billing/stripe-gateway";
import type { SessionUser } from "@/lib/auth/session";

/**
 * YF-810 — Stripe abonelik yaşam döngüsü senkronizasyonu.
 *
 * ## Mimari sözleşme (YF-808/YF-809 ile AYNI, değiştirilemez)
 *
 * Stripe yalnızca **ödeme/faturalama sağlayıcısıdır**. Uygulama erişimi ve
 * yetenekleri HER ZAMAN ve YALNIZCA YapiFin'in kendi `Plan` modeli +
 * `lib/entitlements/entitlement-service.ts` (YF-802) tarafından belirlenir.
 * Bu dosya `Organization.planId`'yi mutasyona uğratan TEK yerdir (webhook
 * senkronizasyonu) — hiçbir ikinci/paralel entitlement hesaplama mantığı
 * İCAT EDİLMEZ; yalnızca "hangi plan grantlanmalı" kararı verilir, gerçek
 * yetenek/kota kararı yine `entitlement-service.ts`'e AİTTİR.
 *
 * ## Sıra-dışı (out-of-order) webhook koruması
 *
 * Stripe olayları GEÇ veya SIRA DIŞI teslim edilebilir. Bu dosya buna karşı
 * **"her zaman Stripe'tan yeniden çek" (refetch-on-write)** stratejisini
 * kullanır: hangi olay tetiklediği ÖNEMLİ DEĞİLDİR — `syncSubscriptionFromStripe`
 * HER ZAMAN `gateway.retrieveSubscription()` ile Stripe'ın O ANKİ gerçeğini
 * çeker ve yerel satırı bununla yazar. İki olay (biri eski, biri yeni) hangi
 * sırada işlenirse işlensin, ikisi de AYNI (Stripe'ın güncel) duruma
 * yakınsar — bu yüzden geç işlenen eski bir olay yeni durumu asla EZEMEZ.
 * `OrganizationStripeSubscription.lastProcessedEventId`/`lastProcessedEventCreatedAt`
 * yalnızca gözlemlenebilirlik içindir (monoton ileri taşınır), yazma
 * kararını ETKİLEMEZ.
 *
 * Organizasyon satırı (`lockOrganizationForEntitlement` — mevcut kod
 * tabanındaki `SELECT ... FOR UPDATE` deseniyle AYNI, bkz.
 * checkout-service.ts/ai-usage-reporting-service.ts) her senkronizasyonda
 * kilitlenir; bu da AYNI organizasyon için eşzamanlı iki webhook
 * teslimatını serileştirir.
 *
 * ## Revoke güvenlik koruması
 *
 * Bir abonelik erişimi GERİ ALDIĞINDA (`CANCELED`/`UNPAID`/… bkz.
 * `ENTITLEMENT_REVOKING_STATUSES`), `Organization.planId` yalnızca HÂLÂ bu
 * aboneliğin en son grantladığı plana (`lastGrantedPlanId`) eşitse
 * `null`lanır. Böylece bu abonelik dışında (ör. bir yönetici tarafından elle)
 * değiştirilmiş bir plan asla ezilmez.
 *
 * ## Tenant izolasyonu
 *
 * Bir Stripe müşteri/abonelik kimliğinin hangi organizasyona ait olduğu
 * ASLA webhook metadata'sından doğrudan güvenilmez — TEK kanonik kaynak
 * `OrganizationStripeCustomer` eşlemesidir (YF-808). Ayrıca Stripe'tan
 * YENİDEN ÇEKİLEN abonelik nesnesinin `customerId`'si, eşlemeden çözülen
 * beklenen müşteri kimliğiyle çapraz doğrulanır; uyuşmazlıkta fail-closed
 * reddedilir ve HİÇBİR yazma yapılmaz (bkz. `syncSubscriptionFromStripe`
 * "tenant çapraz doğrulama" adımı).
 */

type Tx = Prisma.TransactionClient;

/** Bu durumlarda organizasyon abonelik tarafından grantlanan plana sahip olmalıdır. */
const ENTITLEMENT_GRANTING_STATUSES: readonly PrismaSubscriptionStatus[] = ["ACTIVE", "TRIALING"];
/** Bu durumlarda grant geri alınır (yalnızca `lastGrantedPlanId` GÜVENLİ ise, bkz. dosya başı not). `PAST_DUE`/`INCOMPLETE` bilinçli olarak burada DEĞİLDİR — nötr (mevcut durum korunur, bkz. modül başı "revoke güvenlik" notu). */
const ENTITLEMENT_REVOKING_STATUSES: readonly PrismaSubscriptionStatus[] = [
  "CANCELED",
  "UNPAID",
  "INCOMPLETE_EXPIRED",
  "PAUSED",
  "UNKNOWN",
];

function toSubscriptionStatus(raw: string): PrismaSubscriptionStatus {
  switch (raw) {
    case "active":
      return "ACTIVE";
    case "trialing":
      return "TRIALING";
    case "past_due":
      return "PAST_DUE";
    case "canceled":
      return "CANCELED";
    case "unpaid":
      return "UNPAID";
    case "incomplete":
      return "INCOMPLETE";
    case "incomplete_expired":
      return "INCOMPLETE_EXPIRED";
    case "paused":
      return "PAUSED";
    default:
      // Stripe'ın gelecekte ekleyebileceği, bu kod tabanının henüz TANIMADIĞI
      // bir durum dizesi — fail-closed: entitlement kazandırmaz (bkz.
      // ENTITLEMENT_REVOKING_STATUSES), ama yazma İŞLEMİ çökmez.
      return "UNKNOWN";
  }
}

function toDateOrNull(unixSeconds: number | null): Date | null {
  return unixSeconds === null ? null : new Date(unixSeconds * 1000);
}

/**
 * Bir Stripe müşteri kimliğini kanonik `OrganizationStripeCustomer`
 * eşlemesi üzerinden organizasyona çözer. Eşleme YOKSA `null` döner (hata
 * FIRLATMAZ) — çağıran bunu fail-closed "bu olayla ilgili bir eylemimiz yok"
 * olarak ele alır (bkz. `processStripeWebhookEvent`).
 */
async function resolveOrganizationForCustomer(
  stripeCustomerId: string,
  environment: StripeEnvironment,
): Promise<string | null> {
  const row = await db.organizationStripeCustomer.findUnique({
    where: { environment_stripeCustomerId: { environment, stripeCustomerId } },
    select: { organizationId: true },
  });
  return row?.organizationId ?? null;
}

interface ClaimEventInput {
  readonly stripeEventId: string;
  readonly environment: StripeEnvironment;
  readonly eventType: string;
  readonly organizationId: string | null;
  readonly stripeCustomerId: string | null;
  readonly stripeSubscriptionId: string | null;
  readonly stripeCreatedAt: Date;
}

type ClaimResult = { readonly claimed: true } | { readonly claimed: false; readonly reason: "DUPLICATE" };

/**
 * Bir Stripe olayını veritabanı düzeyinde "iddia eder" (claim). `stripeEventId`
 * üzerindeki `@unique` kısıt, AYNI olayın iki teslimatının ASLA eşzamanlı
 * işlenmemesini garanti eder (bkz. model başlık yorumu). Önceki bir deneme
 * `PROCESSED`/`IGNORED` ile SONLANDIYSA bu teslimat `DUPLICATE` olarak
 * reddedilir (yeniden işlenmez); `FAILED` veya (çökme nedeniyle takılı
 * kalmış) `RECEIVED` ise GÜVENLE yeniden denenir.
 */
async function claimEvent(input: ClaimEventInput): Promise<ClaimResult> {
  try {
    await db.stripeWebhookEvent.create({
      data: {
        stripeEventId: input.stripeEventId,
        environment: input.environment,
        eventType: input.eventType,
        organizationId: input.organizationId,
        stripeCustomerId: input.stripeCustomerId,
        stripeSubscriptionId: input.stripeSubscriptionId,
        stripeCreatedAt: input.stripeCreatedAt,
        status: "RECEIVED",
        attempts: 1,
      },
    });
    return { claimed: true };
  } catch (err) {
    if ((err as { code?: string })?.code !== "P2002") throw err;

    const existing = await db.stripeWebhookEvent.findUnique({ where: { stripeEventId: input.stripeEventId } });
    if (!existing || existing.status === "PROCESSED" || existing.status === "IGNORED") {
      return { claimed: false, reason: "DUPLICATE" };
    }
    // FAILED veya RECEIVED (önceki deneme çökmüş/tamamlanmamış) — güvenle
    // yeniden dene. Korelasyon alanları da güncellenir (ör. ilk denemede
    // tenant çözülemediyse, bu deneme kanonik eşlemeyi tekrar sorgulamış
    // olabilir).
    await db.stripeWebhookEvent.update({
      where: { stripeEventId: input.stripeEventId },
      data: {
        attempts: { increment: 1 },
        status: "RECEIVED",
        organizationId: input.organizationId,
        stripeCustomerId: input.stripeCustomerId,
        stripeSubscriptionId: input.stripeSubscriptionId,
        errorSummary: null,
      },
    });
    return { claimed: true };
  }
}

/** Sabit, sır İÇERMEYEN kısa bir özete kırpar — ham istisna mesajı ASLA yazılmaz (bkz. lib/billing/errors.ts redactBillingSecrets ile AYNI disiplin). */
function safeErrorSummary(err: unknown): string {
  if (err instanceof ServiceError) return `${err.code}: ${err.message}`.slice(0, 300);
  if (err instanceof Error) return err.name.slice(0, 300);
  return "UNKNOWN_ERROR";
}

async function markEventOutcome(
  stripeEventId: string,
  status: "PROCESSED" | "FAILED" | "IGNORED",
  errorSummary: string | null = null,
): Promise<void> {
  await db.stripeWebhookEvent.update({
    where: { stripeEventId },
    data: { status, errorSummary, processedAt: status === "FAILED" ? null : new Date() },
  });
}

interface SyncParams {
  readonly organizationId: string;
  readonly environment: StripeEnvironment;
  readonly expectedStripeCustomerId: string;
  readonly stripeSubscriptionId: string;
  readonly eventId: string;
  readonly eventCreatedAt: Date;
}

/**
 * Bir organizasyonun aboneliğini Stripe'ın GÜNCEL (yeniden çekilen)
 * gerçeğiyle senkronize eder ve gerekiyorsa `Organization.planId`'yi
 * grantlar/geri alır. Bu fonksiyon modül başı "sıra-dışı olay koruması" ve
 * "revoke güvenlik koruması" sözleşmelerinin TEK uygulama noktasıdır.
 */
async function syncSubscriptionFromStripe(params: SyncParams): Promise<void> {
  const gateway = resolveStripeGateway();
  const subscription = await gateway.retrieveSubscription(params.stripeSubscriptionId);

  await db.$transaction(async (tx) => {
    await lockOrganizationForEntitlement(tx, params.organizationId);

    const existingRow = await tx.organizationStripeSubscription.findUnique({
      where: { organizationId: params.organizationId },
    });

    if (!subscription) {
      // Stripe'ta artık bulunamıyor (nadir — ör. test verisi temizliği).
      // Yalnızca bu satırın HÂLÂ aynı aboneliğe işaret ettiği durumda
      // savunma amaçlı olarak CANCELED'a taşınır; veri SİLİNMEZ.
      if (existingRow && existingRow.stripeSubscriptionId === params.stripeSubscriptionId) {
        await applyRevoke(tx, params.organizationId, existingRow, "Stripe'ta abonelik artık bulunamıyor (resource_missing).");
      }
      return;
    }

    // Tenant çapraz doğrulama — bkz. modül başı "tenant izolasyonu" notu.
    if (subscription.customerId !== params.expectedStripeCustomerId) {
      console.error(
        JSON.stringify({
          level: "error",
          event: "billing.webhook.tenant_mismatch",
          organizationId: params.organizationId,
          stripeSubscriptionId: params.stripeSubscriptionId,
        }),
      );
      return; // Fail-closed: hiçbir yazma yapılmaz.
    }

    await upsertSubscriptionRow(tx, params, subscription, existingRow?.lastProcessedEventCreatedAt ?? null);

    const status = toSubscriptionStatus(subscription.status);
    if (ENTITLEMENT_GRANTING_STATUSES.includes(status)) {
      await applyGrant(tx, params.organizationId, subscription);
    } else if (ENTITLEMENT_REVOKING_STATUSES.includes(status)) {
      const row = await tx.organizationStripeSubscription.findUniqueOrThrow({
        where: { organizationId: params.organizationId },
      });
      await applyRevoke(tx, params.organizationId, row, null);
    }
    // PAST_DUE / INCOMPLETE: bilinçli olarak nötr — mevcut `Organization.planId` DOKUNULMAZ.
  });
}

async function upsertSubscriptionRow(
  tx: Tx,
  params: SyncParams,
  subscription: StripeSubscriptionRef,
  existingLastEventCreatedAt: Date | null,
): Promise<void> {
  const resolvedPlan = subscription.priceId ? resolvePlanForStripePrice(subscription.priceId) : null;
  const reconciliationNote = subscription.priceId && !resolvedPlan
    ? `Price ID kanonik kataloğa çözülemedi (ops yapılandırma sürüklenmesi olabilir) — plan grantlanmadı.`
    : null;

  // lastProcessedEventCreatedAt YALNIZCA gözlemlenebilirlik amaçlıdır —
  // monoton ileri taşınır, yazma kararını ETKİLEMEZ (bkz. dosya başı not).
  const lastProcessedEventCreatedAt =
    existingLastEventCreatedAt && existingLastEventCreatedAt > params.eventCreatedAt
      ? existingLastEventCreatedAt
      : params.eventCreatedAt;

  const data = {
    environment: params.environment,
    stripeCustomerId: subscription.customerId,
    stripeSubscriptionId: subscription.id,
    stripePriceId: subscription.priceId ?? "",
    planCode: resolvedPlan?.planCode ?? null,
    billingInterval: resolvedPlan?.billingInterval ?? null,
    status: toSubscriptionStatus(subscription.status),
    cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
    currentPeriodStart: toDateOrNull(subscription.currentPeriodStart),
    currentPeriodEnd: toDateOrNull(subscription.currentPeriodEnd),
    trialStart: toDateOrNull(subscription.trialStart),
    trialEnd: toDateOrNull(subscription.trialEnd),
    canceledAt: toDateOrNull(subscription.canceledAt),
    endedAt: toDateOrNull(subscription.endedAt),
    reconciliationNote,
    lastProcessedEventId: params.eventId,
    lastProcessedEventCreatedAt,
  };

  await tx.organizationStripeSubscription.upsert({
    where: { organizationId: params.organizationId },
    create: { organizationId: params.organizationId, ...data },
    update: data,
  });
}

/** Aboneliğin grantladığı planı `Organization.planId`'ye yazar (yalnızca değişiklik varsa) ve audit log üretir. */
async function applyGrant(tx: Tx, organizationId: string, subscription: StripeSubscriptionRef): Promise<void> {
  const resolvedPlan = subscription.priceId ? resolvePlanForStripePrice(subscription.priceId) : null;
  if (!resolvedPlan) return; // Fail-closed: kataloğa çözülemeyen bir fiyat asla grant ÜRETMEZ.

  const plan = await tx.plan.findUnique({ where: { code: resolvedPlan.planCode }, select: { id: true, isActive: true } });
  if (!plan || !plan.isActive) return; // Fail-closed: bilinmeyen/pasif plana ASLA grant verilmez.

  const org = await tx.organization.findUniqueOrThrow({ where: { id: organizationId }, select: { planId: true } });
  if (org.planId === plan.id) {
    // Zaten grantlanmış — yalnızca defter tutma alanı (`lastGrantedPlanId`) güncellenir.
    await tx.organizationStripeSubscription.update({ where: { organizationId }, data: { lastGrantedPlanId: plan.id } });
    return;
  }

  await tx.organization.update({ where: { id: organizationId }, data: { planId: plan.id } });
  await tx.organizationStripeSubscription.update({ where: { organizationId }, data: { lastGrantedPlanId: plan.id } });
  await writeAuditLog(tx, {
    organizationId,
    actorId: null,
    action: "billing.subscription.entitlement_granted",
    entityType: "Organization",
    entityId: organizationId,
    before: { planId: org.planId },
    after: { planId: plan.id, planCode: resolvedPlan.planCode, stripeSubscriptionId: subscription.id },
  });
}

/**
 * Bir aboneliğin erişimini geri alır — YALNIZCA `Organization.planId` HÂLÂ bu
 * aboneliğin en son grantladığı plana eşitse (bkz. modül başı "revoke
 * güvenlik koruması" notu). Hiçbir kullanıcı/proje/finansal veri SİLİNMEZ —
 * yalnızca `Organization.planId` `null`lanır (entitlement servisi bunu
 * fail-closed "plansız" olarak ele alır, bkz. entitlement-service.ts NO_PLAN).
 */
async function applyRevoke(
  tx: Tx,
  organizationId: string,
  row: { lastGrantedPlanId: string | null },
  reconciliationNote: string | null,
): Promise<void> {
  if (reconciliationNote) {
    await tx.organizationStripeSubscription.update({ where: { organizationId }, data: { reconciliationNote } });
  }
  if (!row.lastGrantedPlanId) return; // Bu abonelik hiç grant vermemiş — geri alınacak bir şey yok.

  const org = await tx.organization.findUniqueOrThrow({ where: { id: organizationId }, select: { planId: true } });
  if (org.planId !== row.lastGrantedPlanId) {
    // Plan bu abonelik DIŞINDA değiştirilmiş (ör. yönetici müdahalesi) —
    // fail-closed: dokunulmaz, yalnızca gözlemlenebilirlik notu bırakılır.
    await tx.organizationStripeSubscription.update({
      where: { organizationId },
      data: { reconciliationNote: "Revoke atlandı: plan bu abonelik dışında değiştirilmiş." },
    });
    return;
  }

  await tx.organization.update({ where: { id: organizationId }, data: { planId: null } });
  await tx.organizationStripeSubscription.update({ where: { organizationId }, data: { lastGrantedPlanId: null } });
  await writeAuditLog(tx, {
    organizationId,
    actorId: null,
    action: "billing.subscription.entitlement_revoked",
    entityType: "Organization",
    entityId: organizationId,
    before: { planId: org.planId },
    after: { planId: null },
  });
}

async function recordInvoicePayment(params: {
  organizationId: string;
  status: "SUCCEEDED" | "FAILED";
  invoiceId: string;
  amountDue: number;
  currency: string;
}): Promise<void> {
  await db.$transaction(async (tx) => {
    const existing = await tx.organizationStripeSubscription.findUnique({ where: { organizationId: params.organizationId } });
    if (!existing) return; // Abonelik satırı henüz yoksa (nadir sıra dışı teslimat) — subscription.* olayı bunu ayrıca oluşturacaktır.
    await tx.organizationStripeSubscription.update({
      where: { organizationId: params.organizationId },
      data: { lastPaymentStatus: params.status, lastPaymentAt: new Date(), lastInvoiceId: params.invoiceId },
    });
    // YF-810 görev talimatı madde 8 — SaaS platform faturalama verisi;
    // proje gelir/gider muhasebe defterine (FinancialTransaction) ASLA
    // AKTARILMAZ. Yalnızca denetim izi (audit log) amaçlı, sır İÇERMEYEN
    // özet alanlar taşınır.
    await writeAuditLog(tx, {
      organizationId: params.organizationId,
      actorId: null,
      action: params.status === "SUCCEEDED" ? "billing.invoice.payment_succeeded" : "billing.invoice.payment_failed",
      entityType: "OrganizationStripeSubscription",
      entityId: params.organizationId,
      after: { invoiceId: params.invoiceId, amountDue: params.amountDue, currency: params.currency },
    });
  });
}

export interface ProcessWebhookResult {
  readonly outcome: "PROCESSED" | "IGNORED" | "DUPLICATE";
}

/**
 * YF-810 — imza doğrulanmış bir Stripe webhook olayını idempotent biçimde
 * işler. Çağıran (`app/api/billing/stripe/webhook/route.ts`) HER ZAMAN önce
 * `gateway.constructWebhookEvent()` ile imzayı doğrulamış OLMALIDIR — bu
 * fonksiyon imza doğrulaması YAPMAZ.
 */
export async function processStripeWebhookEvent(rawEvent: StripeWebhookEventRef): Promise<ProcessWebhookResult> {
  const { environment } = getStripeConfig();
  const stripeCreatedAt = new Date(rawEvent.createdAt * 1000);

  const stripeCustomerId = rawEvent.kind === "UNHANDLED" ? null : rawEvent.customerId;
  const stripeSubscriptionId = rawEvent.kind === "UNHANDLED" ? null : rawEvent.subscriptionId;

  const organizationId = stripeCustomerId ? await resolveOrganizationForCustomer(stripeCustomerId, environment) : null;

  const claim = await claimEvent({
    stripeEventId: rawEvent.id,
    environment,
    eventType: rawEvent.type,
    organizationId,
    stripeCustomerId,
    stripeSubscriptionId,
    stripeCreatedAt,
  });
  if (!claim.claimed) return { outcome: "DUPLICATE" };

  try {
    if (rawEvent.kind === "UNHANDLED" || !organizationId) {
      // Bilinmeyen müşteri/abonelik VEYA ele alınmayan olay türü — fail-closed:
      // hiçbir organizasyona yazma YAPILMAZ, olay bilinçli olarak atlanır
      // (bkz. görev talimatı test senaryosu "unknown Stripe customer/subscription").
      await markEventOutcome(rawEvent.id, "IGNORED");
      return { outcome: "IGNORED" };
    }

    if (rawEvent.kind === "SUBSCRIPTION" || rawEvent.kind === "CHECKOUT_SESSION") {
      const subscriptionId = rawEvent.subscriptionId;
      if (!subscriptionId) {
        await markEventOutcome(rawEvent.id, "IGNORED");
        return { outcome: "IGNORED" };
      }
      await syncSubscriptionFromStripe({
        organizationId,
        environment,
        expectedStripeCustomerId: stripeCustomerId!,
        stripeSubscriptionId: subscriptionId,
        eventId: rawEvent.id,
        eventCreatedAt: stripeCreatedAt,
      });
      await markEventOutcome(rawEvent.id, "PROCESSED");
      return { outcome: "PROCESSED" };
    }

    if (rawEvent.kind === "INVOICE") {
      if (!rawEvent.subscriptionId) {
        // Aboneliğe bağlı olmayan fatura (ör. tek seferlik) — ele alınmıyor.
        await markEventOutcome(rawEvent.id, "IGNORED");
        return { outcome: "IGNORED" };
      }
      await syncSubscriptionFromStripe({
        organizationId,
        environment,
        expectedStripeCustomerId: stripeCustomerId!,
        stripeSubscriptionId: rawEvent.subscriptionId,
        eventId: rawEvent.id,
        eventCreatedAt: stripeCreatedAt,
      });
      await recordInvoicePayment({
        organizationId,
        status: rawEvent.type === "invoice.payment_succeeded" ? "SUCCEEDED" : "FAILED",
        invoiceId: rawEvent.invoiceId,
        amountDue: rawEvent.amountDue,
        currency: rawEvent.currency,
      });
      await markEventOutcome(rawEvent.id, "PROCESSED");
      return { outcome: "PROCESSED" };
    }

    // Yukarıdaki üç dal `StripeWebhookEventRef`in dört `kind` üyesinin
    // TAMAMINI (UNHANDLED, SUBSCRIPTION|CHECKOUT_SESSION, INVOICE) kapsar ve
    // her biri erken döner — TypeScript bunu buradaki `rawEvent: never`
    // daralmasıyla ZATEN doğrular (derleme zamanı bitişiklik/exhaustiveness
    // kanıtı). Bu satıra ulaşılması yeni bir `kind` üyesi eklenip yukarıdaki
    // dallardan birinin GÜNCELLENMEMESİ anlamına gelir.
    const exhaustiveCheck: never = rawEvent;
    throw new Error(`processStripeWebhookEvent: ele alınmayan olay türü: ${JSON.stringify(exhaustiveCheck)}`);
  } catch (err) {
    await markEventOutcome(rawEvent.id, "FAILED", safeErrorSummary(err));
    throw err; // Route 500 döner — Stripe güvenle yeniden dener (bkz. claimEvent).
  }
}

export interface ReconcileResult {
  readonly found: boolean;
  readonly stripeSubscriptionId: string | null;
  readonly status: string | null;
  readonly planCode: string | null;
}

/**
 * YF-810 madde 9 — dahili/manuel mutabakat (reconciliation) girişi. Webhook
 * teslimatı kaçırıldıysa, işleme başarısız olduysa veya YapiFin geçici
 * olarak erişilemez olduysa yerel durumu Stripe'ın GÜNCEL gerçeğiyle
 * yeniden hizalar. Tam olarak `syncSubscriptionFromStripe`'ı kullandığı
 * için DOĞASI GEREĞİ idempotenttir — art arda çağrılması AYNI sonucu üretir.
 * Yalnızca OWNER (`canManageOrganizationSettings`) — organizasyonun ödeme
 * sağlayıcısı kimliğini/durumunu yönetmekle AYNI yetki sınırı (bkz.
 * checkout-service.ts/stripe-customer-service.ts AYNI kısıt).
 */
export async function reconcileOrganizationStripeSubscription(actor: SessionUser): Promise<ReconcileResult> {
  if (!canManageOrganizationSettings(actor.role)) throw forbidden("Yalnızca firma sahibi faturalama durumunu yeniden senkronize edebilir");

  const { environment } = getStripeConfig();
  const organizationId = actor.organizationId;

  const customerMapping = await db.organizationStripeCustomer.findUnique({
    where: { organizationId_environment: { organizationId, environment } },
    select: { stripeCustomerId: true },
  });
  if (!customerMapping) throw notFound("Bu organizasyon için henüz bir Stripe müşteri kaydı yok");

  const existingRow = await db.organizationStripeSubscription.findUnique({ where: { organizationId } });
  const gateway = resolveStripeGateway();

  let subscriptionId = existingRow?.stripeSubscriptionId ?? null;
  if (!subscriptionId) {
    // Yerel satır hiç YOK — webhook TAMAMEN kaçırılmış olabilir. Stripe'tan
    // müşterinin aboneliklerini listeleyerek KEŞFET (yalnızca mutabakat
    // yolunda; normal webhook akışı bunu ÇAĞIRMAZ, bkz. gateway arayüzü notu).
    const subs = await gateway.listSubscriptionsForCustomer(customerMapping.stripeCustomerId, 5);
    const mostRelevant =
      subs.find((s) => s.status === "active" || s.status === "trialing" || s.status === "past_due") ?? subs[0] ?? null;
    if (!mostRelevant) return { found: false, stripeSubscriptionId: null, status: null, planCode: null };
    subscriptionId = mostRelevant.id;
  }

  await syncSubscriptionFromStripe({
    organizationId,
    environment,
    expectedStripeCustomerId: customerMapping.stripeCustomerId,
    stripeSubscriptionId: subscriptionId,
    // Gerçek bir Stripe olayı DEĞİLDİR — sentetik, "şimdi" zaman damgası
    // kullanılır ki refetch edilen GÜNCEL durum her zaman yazılsın (bkz.
    // dosya başı "refetch-on-write" stratejisi — bu senkronizasyon yolu için
    // de geçerlidir, sıra-dışı kaygısı YOKTUR çünkü zaten en güncel anı temsil eder).
    eventId: `reconcile:${organizationId}:${Date.now()}`,
    eventCreatedAt: new Date(),
  });

  const updated = await db.organizationStripeSubscription.findUnique({ where: { organizationId } });
  return {
    found: true,
    stripeSubscriptionId: updated?.stripeSubscriptionId ?? subscriptionId,
    status: updated?.status ?? null,
    planCode: updated?.planCode ?? null,
  };
}
