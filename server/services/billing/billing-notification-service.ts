import type { BillingNotification, BillingNotificationType, Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { writeAuditLog } from "@/lib/audit";
import { classifyMailError } from "@/lib/email/errors";
import { hasActiveDisputeRestriction } from "@/lib/billing/dispute-policy";
import { resolveBillingNotificationRecipients, type BillingNotificationRecipient } from "@/lib/billing/notification-policy";
import {
  sendGraceExpiredRestrictedEmail,
  sendGraceExpiringReminderEmail,
  sendPaymentFailedGraceStartedEmail,
  sendPaymentRecoveredEmail,
} from "@/lib/email/billing-notification-mailer";

/**
 * YF-821 — `BillingNotification` defterinin TEK yazım/gönderim orkestrasyon
 * noktası (bkz. prisma/schema.prisma model dosya başı notu).
 *
 * ## İki aşamalı: planlama (transactional) → gönderim (transaction DIŞI)
 *
 * `scheduleBillingNotification` YALNIZCA çağıranın (webhook `reconcileDunningState`
 * VEYA sweep) KENDİ transaction'ı içinde çalışır ve YALNIZCA satırı yazar —
 * hiçbir ağ G/Ç'si (SMTP) YAPMAZ. Bunun nedeni: `nodemailer` bir HTTP/SMTP
 * round-trip'idir; bunu bir DB transaction'ının İÇİNDE çalıştırmak
 * bağlantıyı/kilitleri gereksiz yere uzun tutar (bu kod tabanında hiçbir
 * mevcut transaction I/O yapmaz — bkz. `server/services/billing/webhook-service.ts`
 * `syncSubscriptionFromStripe` İLE AYNI ilke). Gerçek gönderim
 * `dispatchPendingBillingNotifications` ile commit SONRASI, ayrı bir adımda
 * yapılır — hem webhook yolundan (gerçek zamanlı, en iyi çaba) HEM DE
 * `billing-notification-sweep-service.ts`'ten (periyodik yedek/yeniden
 * deneme) ÇAĞRILIR; ikisi de AYNI fonksiyonu kullanır, bu yüzden yeniden
 * deneme mantığı TEK bir yerde yaşar.
 *
 * ## Neden `PAYMENT_RECOVERED` uyuşmazlık metni CANLI okunur
 *
 * `gracePeriodEndsAt` (deadline) planlama anında DONDURULUR (bkz. şema
 * notu) ÇÜNKÜ tarihsel bir OLGUDUR. Ama "hesabınız hâlâ kısıtlı mı" (YF-815
 * dispute kompozisyonu) gönderim ANINDAKİ GÜNCEL gerçeği yansıtmalıdır —
 * `lib/billing/billing-restriction-policy.ts` dosya başı notuYLA AYNI ilke
 * (hiçbir erişim/durum kararı ÖNBELLEĞE ALINMAZ). Planlama ile gönderim
 * arasında bir dispute açılırsa/kapanırsa, e-posta HER ZAMAN gönderim
 * anındaki doğru durumu anlatır.
 */

type Tx = Prisma.TransactionClient;

/**
 * ## Eşzamanlı gönderim yarışı — atomik satır üstlenme (claim)
 *
 * `dispatchPendingBillingNotifications` İKİ BAĞIMSIZ yoldan (webhook'un
 * commit-sonrası en-iyi-çaba denemesi VE periyodik sweep) AYNI organizasyon
 * için ÇAKIŞABİLİR şekilde çağrılabilir (bkz. `webhook-service.ts`
 * `syncSubscriptionFromStripe` ve `billing-notification-sweep-service.ts`
 * dosya başı notları). `@@unique([organizationId, type, episodeKey])`
 * yalnızca bir satırın İKİ KEZ OLUŞTURULMASINI engeller — bir satırın İKİ
 * FARKLI süreç tarafından EŞZAMANLI OLARAK GÖNDERİLMESİNİ (aynı `SCHEDULED`
 * satırı iki `findMany` çağrısı tarafından gönderim ÖNCESİ okunması) TEK
 * BAŞINA engellemez. Bu yüzden gönderimden HEMEN ÖNCE, `SCHEDULED`/`FAILED`
 * → `SENDING` atomik bir `updateMany` (`WHERE id = ? AND status IN (...)`)
 * ile İŞARETLENİR; PostgreSQL bu satır üzerinde İKİ eşzamanlı `UPDATE`'i
 * SIRALAR — ikinci çağrı ilk COMMIT olduktan SONRA WHERE koşulunu yeniden
 * değerlendirir ve SIFIR satır eşleştirir (`status` artık `SENDING`), bu
 * yüzden GÖNDERİMİ ATLAR. Yalnızca üstlenen (claim eden) süreç e-postayı
 * GÖNDERİR.
 */
const STALE_SENDING_TIMEOUT_MS = 5 * 60_000;

/**
 * Bir sürecin gönderim SIRASINDA çökmesi (SMTP yanıtı beklenirken süreç
 * sonlandırılması) satırı SONSUZA KADAR `SENDING`'te bırakabilir — normal bir
 * SMTP round-trip'i saniyeler sürer, bu yüzden `STALE_SENDING_TIMEOUT_MS`
 * (5 dakika) SONRASINDA bu satırlar da yeniden deneme adayı olarak ele
 * alınır (bkz. dosya başı "tek yeniden deneme kaynağı" notu — sweep BU
 * durumu da kapsar).
 */
export function pendingStatusWhere(now: Date): Prisma.BillingNotificationWhereInput {
  return {
    OR: [
      { status: { in: ["SCHEDULED", "FAILED"] } },
      { status: "SENDING", updatedAt: { lt: new Date(now.getTime() - STALE_SENDING_TIMEOUT_MS) } },
    ],
  };
}

/** Satırı atomik olarak üstlenir — başka bir eşzamanlı çağrı ZATEN üstlenmişse `false` döner (gönderim ATLANMALIDIR). */
async function claimNotification(id: string, now: Date): Promise<boolean> {
  const result = await db.billingNotification.updateMany({
    where: { id, ...pendingStatusWhere(now) },
    data: { status: "SENDING" },
  });
  return result.count === 1;
}

export interface ScheduleBillingNotificationInput {
  readonly organizationId: string;
  readonly type: BillingNotificationType;
  /** `lib/billing/dunning-policy.ts` `delinquentSince` (ISO) — bölümü tanımlayan kararlı anahtar (bkz. şema notu). */
  readonly episodeKey: string;
  readonly triggeredByEventId?: string | null;
  /** Yalnızca GRACE_STARTED/GRACE_EXPIRING_REMINDER için — bkz. şema `gracePeriodEndsAt` notu. */
  readonly gracePeriodEndsAt?: Date | null;
}

export interface ScheduleBillingNotificationResult {
  readonly isNew: boolean;
}

/**
 * Çağıranın transaction'ı İÇİNDE, idempotent bir şekilde bir bildirim
 * PLANLAR. `@@unique([organizationId, type, episodeKey])` TEK doğruluk
 * kaynağıdır — ikinci bir çağrı (webhook replay, eşzamanlı işleme, sweep
 * çakışması) P2002 ile karşılaşır ve sessizce `isNew: false` döner (hiçbir
 * hata fırlatılmaz, çağıranın kendi transaction'ı BOZULMAZ).
 */
export async function scheduleBillingNotification(
  tx: Tx,
  input: ScheduleBillingNotificationInput,
): Promise<ScheduleBillingNotificationResult> {
  try {
    await tx.billingNotification.create({
      data: {
        organizationId: input.organizationId,
        type: input.type,
        episodeKey: input.episodeKey,
        triggeredByEventId: input.triggeredByEventId ?? null,
        gracePeriodEndsAt: input.gracePeriodEndsAt ?? null,
      },
    });
    return { isNew: true };
  } catch (err) {
    if ((err as { code?: string } | null)?.code === "P2002") {
      return { isNew: false };
    }
    throw err;
  }
}

async function markSent(notification: BillingNotification, recipientCount: number): Promise<void> {
  await db.$transaction(async (tx) => {
    await tx.billingNotification.update({
      where: { id: notification.id },
      data: { status: "SENT", sentAt: new Date(), recipientCount, lastError: null, attemptCount: { increment: 1 } },
    });
    await writeAuditLog(tx, {
      organizationId: notification.organizationId,
      actorId: null,
      action: "billing.notification.sent",
      entityType: "BillingNotification",
      entityId: notification.id,
      after: { type: notification.type, episodeKey: notification.episodeKey, recipientCount },
    });
  });
}

async function markFailed(notification: BillingNotification, err: unknown): Promise<void> {
  const classified = classifyMailError(err);
  await db.$transaction(async (tx) => {
    await tx.billingNotification.update({
      where: { id: notification.id },
      data: { status: "FAILED", lastError: classified.category, attemptCount: { increment: 1 } },
    });
    // Sınıflandırılmış kategori/retryable dışında hiçbir şey (ham hata
    // mesajı, SMTP yanıtı, alıcı adresi) audit log'a YAZILMAZ — bkz.
    // lib/email/mailer.ts `logMailFailure` İLE AYNI disiplin.
    await writeAuditLog(tx, {
      organizationId: notification.organizationId,
      actorId: null,
      action: "billing.notification.failed",
      entityType: "BillingNotification",
      entityId: notification.id,
      after: { type: notification.type, episodeKey: notification.episodeKey, category: classified.category, retryable: classified.retryable },
    });
  });
}

interface DispatchContext {
  readonly organizationName: string;
  readonly recipients: readonly BillingNotificationRecipient[];
  readonly disputeRestricted: boolean;
}

async function dispatchOne(notification: BillingNotification, ctx: DispatchContext, now: Date): Promise<void> {
  if (ctx.recipients.length === 0) {
    // Bildirilecek AKTİF OWNER yok — hata OLARAK işaretlenmez (kalıcı/
    // geçici sınıflandırması yanlış olurdu); satır `SCHEDULED`/`FAILED`
    // durumunda kalır, bir sonraki webhook/sweep turu bir OWNER aktifleşirse
    // tekrar dener.
    return;
  }
  // bkz. dosya başı "eşzamanlı gönderim yarışı" notu — üstlenemezsek (başka
  // bir eşzamanlı çağrı ZATEN göndermekte/göndermiş) BU satır sessizce
  // ATLANIR, mükerrer gönderim OLUŞMAZ.
  const claimed = await claimNotification(notification.id, now);
  if (!claimed) return;
  try {
    switch (notification.type) {
      case "PAYMENT_FAILED_GRACE_STARTED": {
        if (!notification.gracePeriodEndsAt) throw new Error("gracePeriodEndsAt eksik (grace_started)");
        await Promise.all(
          ctx.recipients.map((r) =>
            sendPaymentFailedGraceStartedEmail(r, {
              organizationName: ctx.organizationName,
              gracePeriodEndsAt: notification.gracePeriodEndsAt!,
            }),
          ),
        );
        break;
      }
      case "GRACE_EXPIRING_REMINDER": {
        if (!notification.gracePeriodEndsAt) throw new Error("gracePeriodEndsAt eksik (grace_expiring_reminder)");
        await Promise.all(
          ctx.recipients.map((r) =>
            sendGraceExpiringReminderEmail(r, {
              organizationName: ctx.organizationName,
              gracePeriodEndsAt: notification.gracePeriodEndsAt!,
            }),
          ),
        );
        break;
      }
      case "GRACE_EXPIRED_RESTRICTED": {
        await Promise.all(
          ctx.recipients.map((r) => sendGraceExpiredRestrictedEmail(r, { organizationName: ctx.organizationName })),
        );
        break;
      }
      case "PAYMENT_RECOVERED": {
        await Promise.all(
          ctx.recipients.map((r) =>
            sendPaymentRecoveredEmail(r, {
              organizationName: ctx.organizationName,
              stillRestrictedByDispute: ctx.disputeRestricted,
            }),
          ),
        );
        break;
      }
    }
    await markSent(notification, ctx.recipients.length);
  } catch (err) {
    await markFailed(notification, err);
  }
}

/**
 * Bir organizasyon için bekleyen (henüz `SENT` OLMAYAN — `SCHEDULED`, daha
 * önce `FAILED` veya bir önceki denemeden ÇÖKMÜŞ/takılı kalmış `SENDING`,
 * bkz. dosya başı notu) TÜM bildirimleri göndermeyi DENER. Her satır
 * BAĞIMSIZ değerlendirilir (biri başarısız olursa diğerleri ETKİLENMEZ) VE
 * gönderimden HEMEN ÖNCE atomik olarak ÜSTLENİLİR (`dispatchOne` →
 * `claimNotification`) — bu fonksiyonun İKİ eşzamanlı çağrısı (webhook +
 * sweep) AYNI satırı iki kez GÖNDEREMEZ. Şu anda organizasyona ait
 * recipient/isim/dispute bağlamı BİR KEZ okunur ve tüm satırlar arasında
 * PAYLAŞILIR (gereksiz tekrar sorgu YOKTUR).
 *
 * `now`: sweep çağıranı KENDİ `now`'ını (deterministik/test edilebilir)
 * geçirir; webhook yolu gerçek-zamanlı olduğu için varsayılanı kullanır
 * (bkz. `lib/billing/dunning-policy.ts` "now her zaman AÇIKÇA geçilir"
 * ilkesiyle AYNI, yalnızca bu çağıran için varsayılan pratik nedenlerle
 * (webhook'ta ayrı bir "now" kavramı YOKTUR) izin verilir).
 */
export async function dispatchPendingBillingNotifications(organizationId: string, now: Date = new Date()): Promise<void> {
  const pending = await db.billingNotification.findMany({
    where: { organizationId, ...pendingStatusWhere(now) },
    orderBy: { createdAt: "asc" },
  });
  if (pending.length === 0) return;

  const [organization, recipients, disputeRestricted] = await Promise.all([
    db.organization.findUnique({ where: { id: organizationId }, select: { name: true, tradeName: true } }),
    resolveBillingNotificationRecipients(db, organizationId),
    hasActiveDisputeRestriction(db, organizationId),
  ]);
  // Organizasyon bulunamadıysa (olağan akışta olmaz — savunma amaçlı) hiçbir
  // şey YAPILMAZ; bir sonraki tur tekrar dener.
  if (!organization) return;

  const ctx: DispatchContext = {
    organizationName: organization.tradeName ?? organization.name,
    recipients,
    disputeRestricted,
  };

  for (const notification of pending) {
    await dispatchOne(notification, ctx, now);
  }
}
