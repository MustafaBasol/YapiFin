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
import { confirmAddonCheckoutSession } from "@/server/services/billing/addon-grant-service";
import { resolveOrganizationForCustomer } from "@/server/services/billing/customer-resolution";
import { processRefundWebhookEvent } from "@/server/services/billing/refund-service";
import { processDisputeWebhookEvent } from "@/server/services/billing/dispute-service";
import { openDunningEpisode, clearDunningEpisode, type DunningState } from "@/lib/billing/dunning-policy";
import {
  scheduleBillingNotification,
  dispatchPendingBillingNotifications,
} from "@/server/services/billing/billing-notification-service";
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
 *
 * ## YF-814 — ödeme gecikmesi (dunning) / grace period yakınsaması
 *
 * `reconcileDunningState` (aşağıda), `syncSubscriptionFromStripe`in HER
 * çağrısının SONUNDA, o çağrının YENİDEN ÇEKTİĞİ (refetch-on-write)
 * abonelik durumuna göre çalışır — hangi olay/tetikleyici (`SUBSCRIPTION`
 * webhook'u, `INVOICE` webhook'u veya manuel mutabakat) ÖNEMLİ DEĞİLDİR,
 * yukarıdaki "sıra-dışı olay koruması" İLE TAMAMEN AYNI strateji kullanılır:
 *
 * - `status === PAST_DUE` gözlemlenir ve açık bir bölüm YOKSA → YENİ bir
 *   gecikme bölümü açılır (bkz. `lib/billing/dunning-policy.ts`
 *   `openDunningEpisode` — zaten açıksa İDEMPOTENT no-op, grace süresi ASLA
 *   uzatılmaz).
 * - `status` bir GRANT (`ACTIVE`/`TRIALING`) veya tam bir REVOKE
 *   (`CANCELED`/`UNPAID`/…) durumuna geçer → açık bölüm varsa KAPATILIR (bkz.
 *   `clearDunningEpisode`). Tam revoke durumunda bu, `Organization.planId`
 *   zaten `null`landığı (erişim NO_PLAN ile TAMAMEN kapalı olduğu) için
 *   yalnızca gözlemlenebilirlik/UI netliği amaçlıdır (bayat bir "grace süresi
 *   doldu" durumu, "abonelik iptal edildi" durumunun YANINDA GÖSTERİLMEZ).
 * - `INCOMPLETE`/`INCOMPLETE_EXPIRED` bilinçli olarak DOKUNULMAZ — bunlar
 *   İLK ödeme ÖNCESİ (checkout akışı, YF-809) durumlarıdır, TEKRARLANAN bir
 *   ödemenin başarısızlığı DEĞİLDİR (görev talimatı kapsamı: "failed-payment
 *   grace period").
 *
 * Bu TEK yakınsama noktası sayesinde sıra-dışı/geç teslim edilen bir
 * `invoice.payment_failed`/`invoice.payment_succeeded` olayı bile ASLA
 * yanlış bir kısıtlama/kurtarma ÜRETEMEZ: karar HER ZAMAN o ANDA Stripe'tan
 * YENİDEN ÇEKİLEN `status`a göre verilir, olayın KENDİ türüne (`FAILED`/
 * `SUCCEEDED` etiketine) GÜVENİLMEZ (bkz. `recordInvoicePayment` — YALNIZCA
 * gözlemlenebilirlik alanlarını [`lastPaymentStatus`/`lastPaymentAt`/
 * `lastInvoiceId`] günceller, dunning KARARINA KATILMAZ).
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
/**
 * YF-814 — `server/services/billing/checkout-service.ts`
 * `isTransientLockConflict`/`withLockConflictRetry` İLE AYNI, KANITLANMIŞ
 * desen (kasıtlı olarak KOPYALANIR, paylaşılan bir yardımcı modüle
 * ÇIKARILMAZ — bu görev kapsamının DIŞINDaki bir refactor olurdu). Bu
 * görevin eşzamanlı webhook testi (`tests/billing-dunning.test.ts`
 * "eşzamanlı (concurrent) mükerrer teslimat") AYNI organizasyon için İKİ
 * eşzamanlı `syncSubscriptionFromStripe` çağrısının (`lockOrganizationForEntitlement`
 * satır kilidi + ARDINDAN `organizationStripeSubscription` satır yazması —
 * iki farklı kaynak üzerinde iki satır kilidi) nadiren gerçek bir PostgreSQL
 * deadlock'u (`40P01`) tetikleyebildiğini KANITLADI — bu, YF-814'e ÖZGÜ
 * DEĞİLDİR (herhangi İKİ eşzamanlı webhook/mutabakat çağrısı, ör. eşzamanlı
 * `customer.subscription.updated` + `invoice.payment_failed`, AYNI riski
 * taşır), bu yüzden düzeltme `syncSubscriptionFromStripe`in TÜM
 * çağıranlarını (webhook + mutabakat) kapsayacak şekilde burada uygulanır.
 */
const LOCK_CONFLICT_MAX_ATTEMPTS = 5;

function isTransientLockConflict(err: unknown): boolean {
  let current: unknown = err;
  for (let hop = 0; hop < 5 && current; hop++) {
    const code = (current as { code?: string } | null)?.code;
    if (code === "P2034") return true;
    const metaCode = (current as { meta?: { code?: string } } | null)?.meta?.code;
    if (metaCode === "40P01" || metaCode === "40001") return true;
    const message = current instanceof Error ? current.message : "";
    if (message.includes("deadlock detected") || message.includes("could not serialize access")) return true;
    current = current instanceof Error ? (current as Error & { cause?: unknown }).cause : undefined;
  }
  return false;
}

async function withLockConflictRetry<T>(fn: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (isTransientLockConflict(err) && attempt < LOCK_CONFLICT_MAX_ATTEMPTS) continue;
      throw err;
    }
  }
}

async function syncSubscriptionFromStripe(params: SyncParams): Promise<void> {
  const gateway = resolveStripeGateway();
  const subscription = await gateway.retrieveSubscription(params.stripeSubscriptionId);
  // YF-814 — bölüm açma/kapama için TEK "şimdi" referansı (bkz. modül başı
  // "dunning yakınsaması" notu): Stripe'ın olay zaman damgası mevcutsa (gerçek
  // webhook) O kullanılır — wall-clock işleme zamanından DAHA otoritatiftir
  // (görev talimatı "prefer... if Stripe provides a better authoritative
  // basis"). Manuel mutabakat sentetik `eventCreatedAt: new Date()` geçtiği
  // için (bkz. `reconcileOrganizationStripeSubscription`) bu ayrım OTOMATİK
  // olarak doğru davranışa düşer.
  const now = params.eventCreatedAt;

  await withLockConflictRetry(() => db.$transaction(async (tx) => {
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
        await reconcileDunningState(tx, params.organizationId, "CANCELED", existingRow, now, params.eventId);
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

    // YF-814 — bkz. modül başı "dunning yakınsaması" notu. `existingRow`
    // (upsert'ten ÖNCE okunan) burada güvenle yeniden kullanılır: yukarıdaki
    // `upsertSubscriptionRow` dunning alanlarına (`delinquentSince`/
    // `gracePeriodEndsAt`/`recoveredAt`) HİÇ DOKUNMAZ (bkz. o fonksiyonun
    // `data` nesnesi).
    await reconcileDunningState(tx, params.organizationId, status, existingRow, now, params.eventId);
  }));

  // YF-821 — dunning e-posta bildirimleri: gerçek SMTP G/Ç'si transaction
  // DIŞINDA, commit SONRASI yapılır (bkz. billing-notification-service.ts
  // dosya başı notu). Bu, EN İYİ ÇABA (best-effort) bir gerçek-zamanlı
  // gönderim denemesidir — burada oluşan HERHANGİ bir hata (SMTP dahil)
  // yutulur ve webhook'un kendi başarı/başarısızlık durumunu (`claimEvent`/
  // `markEventOutcome`) ETKİLEMEZ; zaten yukarıdaki abonelik senkronizasyonu
  // BAŞARIYLA TAMAMLANDI. Kalıcı yeniden deneme, tek doğruluk kaynağı olan
  // `BillingNotification` defterine bakan periyodik sweep'e AİTTİR (bkz.
  // billing-notification-sweep-service.ts) — bu satır yalnızca bir hızlandırmadır.
  try {
    await dispatchPendingBillingNotifications(params.organizationId);
  } catch (err) {
    console.error(
      JSON.stringify({
        level: "error",
        event: "billing.notification.dispatch_failed",
        organizationId: params.organizationId,
        message: err instanceof Error ? err.message : "unknown",
      }),
    );
  }
}

/**
 * YF-814 — bir organizasyonun dunning (ödeme gecikmesi) bölümünü, o ANDA
 * Stripe'tan YENİDEN ÇEKİLEN abonelik `status`una göre yakınsatır (bkz.
 * modül başı "YF-814 — dunning yakınsaması" notu). Saf karar mantığı
 * `lib/billing/dunning-policy.ts`dedir (`openDunningEpisode`/
 * `clearDunningEpisode`) — bu fonksiyon yalnızca HANGİ durumda hangisinin
 * çağrılacağına karar verir ve İDEMPOTENT no-op'ları (`{}` yama) gereksiz bir
 * DB yazmasına dönüştürmez.
 */
async function reconcileDunningState(
  tx: Tx,
  organizationId: string,
  status: PrismaSubscriptionStatus,
  existingRow: DunningState | null,
  now: Date,
  eventId: string,
): Promise<void> {
  const current: DunningState = {
    delinquentSince: existingRow?.delinquentSince ?? null,
    gracePeriodEndsAt: existingRow?.gracePeriodEndsAt ?? null,
    recoveredAt: existingRow?.recoveredAt ?? null,
  };

  let patch: Partial<DunningState> = {};
  let action: "billing.dunning.grace_started" | "billing.dunning.recovered" | null = null;
  if (status === "PAST_DUE") {
    patch = openDunningEpisode(current, now);
    if (Object.keys(patch).length > 0) action = "billing.dunning.grace_started";
  } else if (ENTITLEMENT_GRANTING_STATUSES.includes(status) || ENTITLEMENT_REVOKING_STATUSES.includes(status)) {
    patch = clearDunningEpisode(current, now);
    if (Object.keys(patch).length > 0) action = "billing.dunning.recovered";
  }
  // INCOMPLETE / INCOMPLETE_EXPIRED zaten ENTITLEMENT_REVOKING_STATUSES
  // içindedir (yukarı bkz.) — yalnızca saf `INCOMPLETE` (ilk ödeme öncesi,
  // henüz REVOKING'e bile GİRMEMİŞ) bilinçli olarak nötr kalır.

  if (!action) return; // İDEMPOTENT no-op — zaten AYNI durumda, hiçbir yazma/olay ÜRETİLMEZ (bkz. mükerrer webhook/replay üzerinde bildirim tekrarını ÖNLEME notu).
  await tx.organizationStripeSubscription.update({ where: { organizationId }, data: patch });
  // YF-814 görev talimatı madde 10 — özel bir e-posta/bildirim platformu BU
  // görevde İNŞA EDİLMEZ (bkz. lib/email/mailer.ts mevcut altyapısı; bu
  // entegrasyon SONRAKİ görev sınırıdır). Bu denetlenebilir uygulama
  // olayı/audit log kaydı, o entegrasyonun tüketebileceği TEK doğruluk
  // kaynağıdır — webhook TEKRARINDA (replay) mükerrer bildirim ÜRETİLMEZ
  // (yukarıdaki İDEMPOTENT no-op koruması sayesinde: yalnızca GERÇEK bir
  // durum GEÇİŞİNDE yazılır).
  await writeAuditLog(tx, {
    organizationId,
    actorId: null,
    action,
    entityType: "OrganizationStripeSubscription",
    entityId: organizationId,
    after:
      action === "billing.dunning.grace_started"
        ? { delinquentSince: patch.delinquentSince?.toISOString(), gracePeriodEndsAt: patch.gracePeriodEndsAt?.toISOString() }
        : { recoveredAt: patch.recoveredAt?.toISOString() },
  });

  // YF-821 — GERÇEK bir durum GEÇİŞİNDE (yukarıdaki İDEMPOTENT no-op
  // korumasından SONRA, yalnızca bu satıra ulaşılırsa) bildirim defterine
  // PLANLAMA yazılır. `episodeKey` = bölümü tanımlayan donmuş
  // `delinquentSince` (bkz. BillingNotification şema notu) — webhook
  // tekrarı/eşzamanlı işleme `@@unique` tarafından veritabanı düzeyinde
  // ENGELLENİR (bu `action` kontrolü zaten aynı korumayı sağlasa da, çift
  // katmanlı savunma: bkz. billing-notification-service.ts dosya başı notu).
  if (action === "billing.dunning.grace_started") {
    await scheduleBillingNotification(tx, {
      organizationId,
      type: "PAYMENT_FAILED_GRACE_STARTED",
      episodeKey: patch.delinquentSince!.toISOString(),
      triggeredByEventId: eventId,
      gracePeriodEndsAt: patch.gracePeriodEndsAt!,
    });
  } else {
    await scheduleBillingNotification(tx, {
      organizationId,
      type: "PAYMENT_RECOVERED",
      episodeKey: current.delinquentSince!.toISOString(),
      triggeredByEventId: eventId,
    });
  }
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

  // YF-815 — DISPUTE KASITLI olarak DIŞARIDA bırakılır: Stripe `Dispute`
  // nesnesi doğrudan `customer` taşımaz, bu yüzden kendi tenant
  // çözümlemesini `processDisputeWebhookEvent` içinde, `retrieveDispute`
  // SONRASI kendisi yapar (bkz. dispute-service.ts dosya başı notu). Diğer
  // TÜM kind'ler (REFUND dahil) `customerId`'yi webhook payload'ından
  // ÜCRETSİZ taşır.
  const stripeCustomerId =
    rawEvent.kind === "UNHANDLED" || rawEvent.kind === "DISPUTE" ? null : rawEvent.customerId;
  const stripeSubscriptionId =
    rawEvent.kind === "SUBSCRIPTION" || rawEvent.kind === "INVOICE" || rawEvent.kind === "CHECKOUT_SESSION"
      ? rawEvent.subscriptionId
      : null;

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
    if (rawEvent.kind === "UNHANDLED") {
      // Ele alınmayan olay türü — fail-closed: hiçbir organizasyona yazma
      // YAPILMAZ, olay bilinçli olarak atlanır.
      await markEventOutcome(rawEvent.id, "IGNORED");
      return { outcome: "IGNORED" };
    }

    if (rawEvent.kind === "DISPUTE") {
      // bkz. yukarıdaki dosya başı notu — kendi tenant çözümlemesini YAPAR,
      // bu yüzden genel `!organizationId` kapısının (aşağıda) DIŞINDADIR.
      const result = await processDisputeWebhookEvent({
        disputeId: rawEvent.disputeId,
        environment,
        eventId: rawEvent.id,
        eventCreatedAt: stripeCreatedAt,
      });
      const status = result.outcome === "IGNORED" ? "IGNORED" : "PROCESSED";
      await markEventOutcome(rawEvent.id, status, result.outcome === "IGNORED" ? (result.reason ?? null) : null);
      return { outcome: status };
    }

    if (!organizationId) {
      // Bilinmeyen müşteri/abonelik — fail-closed: hiçbir organizasyona
      // yazma YAPILMAZ, olay bilinçli olarak atlanır (bkz. görev talimatı
      // test senaryosu "unknown Stripe customer/subscription").
      await markEventOutcome(rawEvent.id, "IGNORED");
      return { outcome: "IGNORED" };
    }

    if (rawEvent.kind === "REFUND") {
      const result = await processRefundWebhookEvent({
        refundId: rawEvent.refundId,
        organizationId,
        environment,
        expectedStripeCustomerId: stripeCustomerId!,
        eventId: rawEvent.id,
        eventCreatedAt: stripeCreatedAt,
      });
      const status = result.outcome === "IGNORED" ? "IGNORED" : "PROCESSED";
      await markEventOutcome(rawEvent.id, status, result.outcome === "IGNORED" ? (result.reason ?? null) : null);
      return { outcome: status };
    }

    if (rawEvent.kind === "CHECKOUT_SESSION" && !rawEvent.subscriptionId) {
      // YF-813 — abonelik-DIŞI (`subscriptionId` yok) bir Checkout Session
      // olayı: bir kullanım/ek-kota (add-on/top-up) tek seferlik `payment`
      // modu satın alması olabilir. Gerçek onay/bağış TAMAMEN
      // `confirmAddonCheckoutSession`'a delege edilir (bkz.
      // server/services/billing/addon-grant-service.ts dosya başı notu —
      // refetch-on-write + tenant/fiyat çapraz doğrulaması + idempotent
      // `grantUsageAddon`). İkinci bir webhook uç noktası/olay işleme yolu
      // İCAT EDİLMEZ — bu, AYNI `processStripeWebhookEvent` idempotency
      // zarfının (bkz. `claimEvent`) içindedir.
      const result = await confirmAddonCheckoutSession({
        checkoutSessionId: rawEvent.checkoutSessionId,
        organizationId,
        environment,
        expectedStripeCustomerId: stripeCustomerId!,
      });
      const status = result.outcome === "IGNORED" ? "IGNORED" : "PROCESSED";
      await markEventOutcome(rawEvent.id, status, result.outcome === "IGNORED" ? result.reason : null);
      return { outcome: status };
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

    // Yukarıdaki dallar `StripeWebhookEventRef`in ALTI `kind` üyesinin
    // TAMAMINI (UNHANDLED, DISPUTE, REFUND, SUBSCRIPTION|CHECKOUT_SESSION,
    // INVOICE) kapsar ve her biri erken döner — TypeScript bunu buradaki
    // `rawEvent: never` daralmasıyla ZATEN doğrular (derleme zamanı
    // bitişiklik/exhaustiveness kanıtı). Bu satıra ulaşılması yeni bir
    // `kind` üyesi eklenip yukarıdaki dallardan birinin GÜNCELLENMEMESİ
    // anlamına gelir.
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
