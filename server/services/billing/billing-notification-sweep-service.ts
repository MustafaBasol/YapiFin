import { db } from "@/lib/db";
import { computePaymentFailureState } from "@/lib/billing/dunning-policy";
import { isWithinGraceReminderWindow } from "@/lib/billing/notification-policy";
import {
  scheduleBillingNotification,
  dispatchPendingBillingNotifications,
  pendingStatusWhere,
} from "@/server/services/billing/billing-notification-service";

/**
 * YF-821 — dunning bildirimleri için periyodik mutabakat/sweep.
 *
 * ## Neden bir sweep var (ve neden bir zamanlayıcı İCAT EDİLMEDİ)
 *
 * Bu kod tabanında (proje genelinde arandı) HİÇBİR gömülü zamanlayıcı/kuyruk
 * altyapısı YOKTUR — mevcut "mutabakat" (`reconcilePendingOrganizationRefunds`,
 * `reconcileOpenOrganizationDisputes`) TAMAMEN OWNER tarafından el ile
 * tetiklenir (bkz. o dosyaların "yeni bir cron İCAT EDİLMEZ" notu). Ancak
 * "grace süresi doluyor" hatırlatması ve "webhook hiç gelmeden grace süresi
 * doldu" durumu, TANIM GEREĞİ bir kullanıcı eylemi olmadan zamanla
 * gerçekleşir — bu yüzden görev talimatı gereği ("An 'approaching expiry'
 * email requires scheduled evaluation... reuse existing scheduler") bu
 * fonksiyon, `app/api/internal/billing/dunning-sweep/route.ts` üzerinden
 * HARİCİ bir zamanlayıcı (işletim sistemi cron'u, barındırma platformunun
 * kendi zamanlayıcısı) tarafından periyodik (ör. saatlik) ÇAĞRILMASI
 * beklenen, SAF (bu modülün kendisi hiçbir zamanlayıcı süreç BAŞLATMAZ),
 * idempotent bir tarama fonksiyonudur — `docs/operations/` altında
 * işletimsel bir gereksinim olarak belgelenir.
 *
 * ## Tek yeniden deneme kaynağı
 *
 * `server/services/billing/webhook-service.ts` `syncSubscriptionFromStripe`
 * her durum geçişinden SONRA en iyi çaba (best-effort) bir gerçek-zamanlı
 * gönderim dener (bkz. o dosyanın notu). Bu fonksiyon ONUNLA YARIŞMAZ —
 * `dispatchPendingBillingNotifications` HER İKİ çağıran için de AYNI, tek
 * idempotent fonksiyondur (`@@unique` + satır durumu TEK doğruluk kaynağı).
 * Bu sweep, SCHEDULED/FAILED durumundaki HER organizasyon için bunu tekrar
 * dener — geçici bir SMTP hatası SONSUZA KADAR `FAILED` kalmaz, bir sonraki
 * sweep turunda otomatik olarak yeniden denenir.
 */
export interface SweepBillingNotificationsResult {
  readonly scanned: number;
  readonly remindersScheduled: number;
  readonly expiredScheduled: number;
  readonly organizationsDispatched: number;
}

export async function sweepBillingNotifications(now: Date): Promise<SweepBillingNotificationsResult> {
  // Yalnızca AÇIK bir dunning bölümü olan (delinquentSince set) satırlar
  // adaydır — `@@index([gracePeriodEndsAt])` (YF-814'ten beri zaten bu
  // tarama deseni İÇİN var) taramayı ucuzlaştırır. Kurtarılmış/hiç
  // gecikmemiş organizasyonlar bu sorguya hiç GİRMEZ (bkz.
  // "recovered account not reminded" test senaryosu — yapısal olarak
  // imkansızdır, `delinquentSince` zaten `null`'dır).
  const candidates = await db.organizationStripeSubscription.findMany({
    where: { delinquentSince: { not: null } },
    select: { organizationId: true, delinquentSince: true, gracePeriodEndsAt: true },
  });

  let remindersScheduled = 0;
  let expiredScheduled = 0;

  for (const row of candidates) {
    if (!row.delinquentSince || !row.gracePeriodEndsAt) continue;
    const episodeKey = row.delinquentSince.toISOString();
    const state = computePaymentFailureState(row, now);

    if (state === "GRACE_PERIOD" && isWithinGraceReminderWindow(row.gracePeriodEndsAt, now)) {
      const result = await db.$transaction((tx) =>
        scheduleBillingNotification(tx, {
          organizationId: row.organizationId,
          type: "GRACE_EXPIRING_REMINDER",
          episodeKey,
          gracePeriodEndsAt: row.gracePeriodEndsAt,
        }),
      );
      if (result.isNew) remindersScheduled += 1;
    } else if (state === "RESTRICTED") {
      const result = await db.$transaction((tx) =>
        scheduleBillingNotification(tx, {
          organizationId: row.organizationId,
          type: "GRACE_EXPIRED_RESTRICTED",
          episodeKey,
        }),
      );
      if (result.isNew) expiredScheduled += 1;
    }
    // GRACE_PERIOD ama hatırlatma penceresi DIŞINDA ("çok erken") veya NONE
    // (yapısal olarak bu sorguya girmez) — bilinçli olarak hiçbir şey
    // PLANLANMAZ.
  }

  // Yukarıdaki tarama TÜM organizasyonlar için `PAYMENT_FAILED_GRACE_STARTED`/
  // `PAYMENT_RECOVERED`'ı KAPSAMAZ (bunlar yalnızca webhook'ta GERÇEK bir
  // durum geçişinde PLANLANIR) — ama bu sorgu, webhook'un en-iyi-çaba
  // gönderim denemesinin BAŞARISIZ OLDUĞU (`FAILED`) VEYA hiç denenemediği
  // (ör. süreç webhook sırasında çöktü, satır `SCHEDULED` kaldı) HER TÜRÜ/
  // organizasyonu da yakalar — bkz. dosya başı "tek yeniden deneme kaynağı"
  // notu. `pendingStatusWhere` KULLANILIR (yalnızca `SCHEDULED`/`FAILED`
  // DEĞİL) — bir önceki gönderim denemesi SIRASINDA çökmüş (satır takılı
  // kalmış `SENDING`) organizasyonlar da bu taramaya DAHİL edilir (bkz.
  // billing-notification-service.ts dosya başı "eşzamanlı gönderim yarışı"
  // notu).
  const pendingOrganizations = await db.billingNotification.findMany({
    where: pendingStatusWhere(now),
    select: { organizationId: true },
    distinct: ["organizationId"],
  });

  for (const { organizationId } of pendingOrganizations) {
    await dispatchPendingBillingNotifications(organizationId, now);
  }

  return {
    scanned: candidates.length,
    remindersScheduled,
    expiredScheduled,
    organizationsDispatched: pendingOrganizations.length,
  };
}
