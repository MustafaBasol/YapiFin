import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { cleanDatabase, createFakeStripeGateway, createOrgUser, createOwnerOrg } from "./helpers";
import { resetEnvCacheForTests } from "@/lib/env";
import { resetStripeConfigCacheForTests } from "@/lib/billing/stripe-config";
import {
  resetStripeGatewayForTests,
  setStripeGatewayForTests,
  type StripeSubscriptionRef,
  type StripeWebhookEventRef,
} from "@/lib/billing/stripe-gateway";
import { ensureOrganizationStripeCustomer } from "@/server/services/billing/stripe-customer-service";
import { processStripeWebhookEvent } from "@/server/services/billing/webhook-service";

/**
 * YF-821 — dunning/grace-period (YF-814) e-posta bildirimleri: servis-katmanı
 * testleri. `tests/billing-dunning.test.ts` (YF-814) İLE AYNI kurulum deseni
 * (`setStripeEnv`, `setUpOrgWithCustomer`, `createFakeStripeGateway`) — imza
 * doğrulaması ATLANIR, gerçek Stripe kimlik bilgisi/ağ çağrısı GEREKMEZ.
 *
 * ## Mailer mocklama stratejisi
 *
 * `tests/email-delivery-failure.test.ts` İLE AYNI, BU KOD TABANINDA ZATEN
 * KURULU desen: `@/lib/email/mailer` modülü `vi.mock` ile TAMAMEN
 * değiştirilir (`vi.hoisted` ile önce tanımlanan tek bir `sendMailMock`).
 * `tests/mailer.test.ts` bunun BİR KATMAN ALTINDA (nodemailer'ı mocklayarak)
 * `sendMail`'in KENDİSİNİ test eder — bu dosyanın amacı O DEĞİL, bu dosya
 * `sendMail`'in ÜZERİNDEKİ orkestrasyon katmanını (kim/ne zaman/ne içerikle
 * çağrılır, idempotency, yeniden deneme) test eder. `sendMail`'i doğrudan
 * mocklamak (SMTP env değişkenleri kurup nodemailer'ı taklit etmek YERİNE)
 * hem daha basit/hızlı hem de bu dosyanın odağıyla (orkestrasyon, SMTP
 * detayı DEĞİL) daha DOĞRU hizalıdır — `billing-notification-mailer.ts`
 * `sendMail`'i `@/lib/email/mailer`'dan İTHAL EDER, bu yüzden mock TÜM 4
 * e-posta fonksiyonunun (`sendPaymentFailedGraceStartedEmail`, ...) gerçek
 * içerik/konu render mantığını KORUR (yalnızca ağ G/Ç'si taklit edilir) —
 * böylece e-posta içeriği (ör. dispute-kompozisyon metni) uçtan uca
 * doğrulanabilir.
 */

interface MailMessage {
  to: string;
  subject: string;
  html: string;
  text: string;
}

const { sendMailMock } = vi.hoisted(() => ({
  sendMailMock: vi.fn(async (_message: MailMessage) => {}),
}));

// `sendMail` YALNIZCA harici çağıranlar (ör. `billing-notification-mailer.ts`)
// İÇİN değiştirilir — diğer export'lar (`sendVerificationEmail` vb.,
// `createOwnerOrg`/`registerOwnerAndOrganization` tarafından kullanılır)
// `importOriginal` ile GERÇEK uygulamalarını KORUR. Not: ESM modül-içi
// çağrılar (ör. `sendVerificationEmail`in KENDİ modülü İÇİNDE `sendMail`i
// çağırması) bu export takasından ETKİLENMEZ — bu yüzden `createOwnerOrg`
// gerçek (dev-outbox, konsola loglanan) e-posta yolunu kullanmaya devam
// eder, YALNIZCA bu dosyanın odağı olan faturalama bildirimi e-postaları
// (`billing-notification-mailer.ts`, ayrı bir modülden `sendMail`i İTHAL
// EDER) mocklanır.
vi.mock("@/lib/email/mailer", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/email/mailer")>();
  return { ...actual, sendMail: sendMailMock };
});

import {
  GRACE_REMINDER_HOURS_BEFORE_EXPIRY,
  isWithinGraceReminderWindow,
  resolveBillingNotificationRecipients,
  resetBillingSweepSecretCacheForTests,
  type BillingNotificationRecipient,
} from "@/lib/billing/notification-policy";
import { sendPaymentRecoveredEmail } from "@/lib/email/billing-notification-mailer";
import {
  scheduleBillingNotification,
  dispatchPendingBillingNotifications,
} from "@/server/services/billing/billing-notification-service";
import { sweepBillingNotifications } from "@/server/services/billing/billing-notification-sweep-service";

function fakeSecretKey(mode: "test" | "live"): string {
  return ["sk", mode, "0000000000000000000000FAKE"].join("_");
}

const TEST_SECRET_KEY = fakeSecretKey("test");

function setStripeEnv(overrides: Record<string, string | undefined> = {}) {
  const values: Record<string, string | undefined> = {
    STRIPE_SECRET_KEY: TEST_SECRET_KEY,
    STRIPE_ENVIRONMENT: undefined,
    NEXT_PUBLIC_APP_URL: "https://app.example.com",
    STRIPE_PRICE_STARTER_MONTHLY: "price_FAKEstarterM001",
    STRIPE_PRICE_STARTER_ANNUAL: "price_FAKEstarterA001",
    STRIPE_PRICE_PROFESSIONAL_MONTHLY: "price_FAKEprofessionalM001",
    STRIPE_PRICE_PROFESSIONAL_ANNUAL: "price_FAKEprofessionalA001",
    STRIPE_PRICE_BUSINESS_MONTHLY: "price_FAKEbusinessM001",
    STRIPE_PRICE_BUSINESS_ANNUAL: "price_FAKEbusinessA001",
    STRIPE_PRICE_ENTERPRISE: "CONTACT_SALES",
    ...overrides,
  };
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  resetEnvCacheForTests();
  resetStripeConfigCacheForTests();
  resetBillingSweepSecretCacheForTests();
}

let originalEnv: Record<string, string | undefined>;
let eventSequence = 0;

beforeAll(async () => {
  await cleanDatabase();
});

beforeEach(() => {
  originalEnv = { ...process.env };
  setStripeEnv();
  eventSequence = 0;
  sendMailMock.mockClear();
});

afterEach(async () => {
  resetStripeGatewayForTests();
  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnv)) delete process.env[key];
  }
  Object.assign(process.env, originalEnv);
  resetEnvCacheForTests();
  resetStripeConfigCacheForTests();
  resetBillingSweepSecretCacheForTests();
  await cleanDatabase();
});

afterAll(async () => {
  await db.$disconnect();
});

function nextEventId(): string {
  eventSequence += 1;
  return `evt_notif_test_${eventSequence}`;
}

const NOW_SECONDS = Math.floor(Date.now() / 1000);

function subscriptionRef(overrides: Partial<StripeSubscriptionRef> & { id: string; customerId: string }): StripeSubscriptionRef {
  return {
    status: "active",
    cancelAtPeriodEnd: false,
    priceId: "price_FAKEprofessionalM001",
    currentPeriodStart: NOW_SECONDS,
    currentPeriodEnd: NOW_SECONDS + 30 * 24 * 60 * 60,
    trialStart: null,
    trialEnd: null,
    canceledAt: null,
    endedAt: null,
    ...overrides,
  };
}

function invoiceEvent(overrides: {
  type: "invoice.payment_succeeded" | "invoice.payment_failed";
  subscriptionId: string | null;
  customerId: string | null;
  invoiceId?: string;
  createdAt?: number;
}): StripeWebhookEventRef {
  return {
    kind: "INVOICE",
    id: nextEventId(),
    type: overrides.type,
    createdAt: overrides.createdAt ?? NOW_SECONDS,
    subscriptionId: overrides.subscriptionId,
    customerId: overrides.customerId,
    invoiceId: overrides.invoiceId ?? `in_test_${eventSequence}`,
    amountDue: 149900,
    currency: "try",
  };
}

async function setUpOrgWithCustomer() {
  const { owner, organizationId } = await createOwnerOrg();
  const fake = createFakeStripeGateway();
  setStripeGatewayForTests(fake.gateway);
  const customer = await ensureOrganizationStripeCustomer(owner);
  return { owner, organizationId, fake, stripeCustomerId: customer.stripeCustomerId };
}

/** Aktif bir aboneliği grantlar (dunning senaryolarının başlangıç noktası — "sağlıklı" bir organizasyon). */
async function grantActiveSubscription(fake: ReturnType<typeof createFakeStripeGateway>, stripeCustomerId: string, subId: string) {
  const sub = subscriptionRef({ id: subId, customerId: stripeCustomerId });
  fake.setSubscription(sub);
  await processStripeWebhookEvent(
    invoiceEvent({ type: "invoice.payment_succeeded", subscriptionId: subId, customerId: stripeCustomerId }),
  );
  return sub;
}

let disputeSeq = 0;
/** YF-815 — bir organizasyonu, `hasActiveDisputeRestriction` AÇISINDAN kısıtlı hale getiren bir `StripeDispute` satırını DOĞRUDAN oluşturur (bkz. `tests/billing-dispute.test.ts` "dispute lost → RESTRICTED" AYNI şekil). */
async function createRestrictingDispute(organizationId: string) {
  disputeSeq += 1;
  return db.stripeDispute.create({
    data: {
      organizationId,
      environment: "TEST",
      stripeDisputeId: `dp_notif_direct_${disputeSeq}`,
      stripeChargeId: `ch_notif_direct_${disputeSeq}`,
      status: "LOST",
      riskState: "RESTRICTED",
      amount: 5000,
      currency: "try",
    },
  });
}

describe("YF-821 — saf politika fonksiyonları (notification-policy.ts)", () => {
  it("isWithinGraceReminderWindow: pencere içinde/dışında ve sınır (boundary) davranışı", () => {
    const now = new Date("2026-03-01T00:00:00.000Z");
    const windowMs = GRACE_REMINDER_HOURS_BEFORE_EXPIRY * 60 * 60 * 1000;

    // Pencere İÇİNDE (47 saat kaldı).
    expect(isWithinGraceReminderWindow(new Date(now.getTime() + 47 * 60 * 60 * 1000), now)).toBe(true);
    // Çok ERKEN (49 saat kaldı) — pencere DIŞINDA.
    expect(isWithinGraceReminderWindow(new Date(now.getTime() + 49 * 60 * 60 * 1000), now)).toBe(false);
    // Zaten DOLMUŞ (1 saat önce) — pencere DIŞINDA (negatif kalan süre).
    expect(isWithinGraceReminderWindow(new Date(now.getTime() - 60 * 60 * 1000), now)).toBe(false);
    // Sınır: TAM 48 saat kaldı — üst sınır DAHİLDİR (İÇİNDE).
    expect(isWithinGraceReminderWindow(new Date(now.getTime() + windowMs), now)).toBe(true);
    // Sınır: 48 saat + 1ms kaldı — pencere DIŞINDA.
    expect(isWithinGraceReminderWindow(new Date(now.getTime() + windowMs + 1), now)).toBe(false);
    // Sınır: TAM ŞİMDİ doluyor (0 kaldı) — DIŞINDA (`> 0` şartı sağlanmaz).
    expect(isWithinGraceReminderWindow(now, now)).toBe(false);
  });
});

describe("YF-821 — bildirim alıcı çözümlemesi (resolveBillingNotificationRecipients)", () => {
  it("yalnızca AKTİF OWNER alıcı olarak döner", async () => {
    const { organizationId, owner } = await createOwnerOrg();
    const recipients = await resolveBillingNotificationRecipients(db, organizationId);
    expect(recipients).toHaveLength(1);
    expect(recipients[0]!.email).toBe(owner.email);
  });

  it.each(["ADMIN", "FINANCE", "PROJECT_MANAGER"] as const)(
    "%s rolündeki AKTİF kullanıcı bildirim ALMAZ (yalnızca OWNER)",
    async (role) => {
      const { organizationId, owner } = await createOwnerOrg();
      await createOrgUser(organizationId, role);
      const recipients = await resolveBillingNotificationRecipients(db, organizationId);
      expect(recipients).toHaveLength(1);
      expect(recipients[0]!.email).toBe(owner.email);
    },
  );

  it("BAŞKA bir organizasyonun OWNER'ı asla alıcı listesine karışmaz (tenant izolasyonu)", async () => {
    const orgA = await createOwnerOrg();
    const orgB = await createOwnerOrg();
    const recipientsA = await resolveBillingNotificationRecipients(db, orgA.organizationId);
    expect(recipientsA).toHaveLength(1);
    expect(recipientsA[0]!.email).toBe(orgA.owner.email);
    expect(recipientsA.some((r) => r.email === orgB.owner.email)).toBe(false);
  });

  it("aynı e-postanın BÜYÜK/küçük harfle farklı iki OWNER kaydı TEK alıcıya tekilleştirilir", async () => {
    const { organizationId, owner } = await createOwnerOrg();
    await db.user.create({
      data: {
        organizationId,
        firstName: "İkinci",
        lastName: "Sahip",
        email: owner.email.toUpperCase(),
        role: "OWNER",
        status: "ACTIVE",
        passwordHash: "unused",
      },
    });
    const recipients = await resolveBillingNotificationRecipients(db, organizationId);
    expect(recipients).toHaveLength(1);
  });

  it.each(["SUSPENDED", "INVITED"] as const)("%s durumundaki bir OWNER bildirim ALMAZ", async (status) => {
    const { organizationId } = await createOwnerOrg();
    const email = `askidaki-sahip-${status.toLowerCase()}@example.com`;
    await db.user.create({
      data: {
        organizationId,
        firstName: "Askıdaki",
        lastName: "Sahip",
        email,
        role: "OWNER",
        status,
        passwordHash: "unused",
      },
    });
    const recipients = await resolveBillingNotificationRecipients(db, organizationId);
    expect(recipients.some((r) => r.email === email)).toBe(false);
  });
});

describe("YF-821 — grace başlangıcı e-posta bildirimi", () => {
  it("ilk ödeme başarısızlığı OWNER'a TEK bir PAYMENT_FAILED_GRACE_STARTED e-postası gönderir", async () => {
    const { organizationId, owner, fake, stripeCustomerId } = await setUpOrgWithCustomer();
    const sub = await grantActiveSubscription(fake, stripeCustomerId, "sub_notif_grace");
    fake.setSubscription({ ...sub, status: "past_due" });
    await processStripeWebhookEvent(
      invoiceEvent({ type: "invoice.payment_failed", subscriptionId: sub.id, customerId: stripeCustomerId }),
    );

    const subRow = await db.organizationStripeSubscription.findUniqueOrThrow({ where: { organizationId } });
    const notifications = await db.billingNotification.findMany({
      where: { organizationId, type: "PAYMENT_FAILED_GRACE_STARTED" },
    });
    expect(notifications).toHaveLength(1);
    const notification = notifications[0]!;
    expect(notification.status).toBe("SENT");
    expect(notification.episodeKey).toBe(subRow.delinquentSince!.toISOString());
    expect(notification.gracePeriodEndsAt!.getTime()).toBe(subRow.gracePeriodEndsAt!.getTime());
    expect(notification.recipientCount).toBe(1);
    expect(notification.lastError).toBeNull();

    expect(sendMailMock).toHaveBeenCalledTimes(1);
    const [message] = sendMailMock.mock.calls[0]!;
    expect(message.to).toBe(owner.email);
    expect(message.subject).toContain("ödeme alınamadı");

    const auditLog = await db.auditLog.findFirst({ where: { organizationId, action: "billing.notification.sent" } });
    expect(auditLog).not.toBeNull();
  });
});

describe("YF-821 — tekrar (replay) ve idempotency", () => {
  it("AYNI Stripe olayının ikinci teslimatı YENİDEN göndermez (webhook düzeyinde idempotency)", async () => {
    const { organizationId, fake, stripeCustomerId } = await setUpOrgWithCustomer();
    const sub = await grantActiveSubscription(fake, stripeCustomerId, "sub_notif_replay");
    fake.setSubscription({ ...sub, status: "past_due" });
    const event = invoiceEvent({ type: "invoice.payment_failed", subscriptionId: sub.id, customerId: stripeCustomerId });

    const first = await processStripeWebhookEvent(event);
    expect(first.outcome).toBe("PROCESSED");
    const second = await processStripeWebhookEvent(event); // AYNI stripeEventId.
    expect(second.outcome).toBe("DUPLICATE");

    const count = await db.billingNotification.count({ where: { organizationId, type: "PAYMENT_FAILED_GRACE_STARTED" } });
    expect(count).toBe(1);
    expect(sendMailMock).toHaveBeenCalledTimes(1);
  });

  it("AYNI açık bölümde tekrarlanan PAST_DUE teslimatları (FARKLI event id) ikinci bir bildirim ÜRETMEZ", async () => {
    const { organizationId, fake, stripeCustomerId } = await setUpOrgWithCustomer();
    const sub = await grantActiveSubscription(fake, stripeCustomerId, "sub_notif_retry");
    fake.setSubscription({ ...sub, status: "past_due" });

    await processStripeWebhookEvent(
      invoiceEvent({ type: "invoice.payment_failed", subscriptionId: sub.id, customerId: stripeCustomerId, createdAt: NOW_SECONDS }),
    );
    // Stripe'ın akıllı yeniden deneme (smart retry) takviminden 3 gün sonra, HÂLÂ past_due döndüren bağımsız bir ikinci olay.
    await processStripeWebhookEvent(
      invoiceEvent({
        type: "invoice.payment_failed",
        subscriptionId: sub.id,
        customerId: stripeCustomerId,
        createdAt: NOW_SECONDS + 3 * 24 * 60 * 60,
      }),
    );

    const count = await db.billingNotification.count({ where: { organizationId, type: "PAYMENT_FAILED_GRACE_STARTED" } });
    expect(count).toBe(1);
    expect(sendMailMock).toHaveBeenCalledTimes(1);
  });

  it("eşzamanlı (concurrent) scheduleBillingNotification çağrıları AYNI (org, tür, episodeKey) için TEK satır üretir (DB unique kısıtı yarışı kazanır)", async () => {
    const { organizationId } = await createOwnerOrg();
    const episodeKey = new Date("2026-02-01T00:00:00.000Z").toISOString();
    const gracePeriodEndsAt = new Date("2026-02-08T00:00:00.000Z");

    const results = await Promise.all([
      db.$transaction((tx) =>
        scheduleBillingNotification(tx, {
          organizationId,
          type: "PAYMENT_FAILED_GRACE_STARTED",
          episodeKey,
          gracePeriodEndsAt,
        }),
      ),
      db.$transaction((tx) =>
        scheduleBillingNotification(tx, {
          organizationId,
          type: "PAYMENT_FAILED_GRACE_STARTED",
          episodeKey,
          gracePeriodEndsAt,
        }),
      ),
    ]);

    expect(results.filter((r) => r.isNew)).toHaveLength(1); // Yarışı TEK çağrı kazanır.
    expect(results.filter((r) => !r.isNew)).toHaveLength(1); // Diğeri P2002'yi sessizce yutar.

    const rows = await db.billingNotification.findMany({ where: { organizationId, type: "PAYMENT_FAILED_GRACE_STARTED", episodeKey } });
    expect(rows).toHaveLength(1);

    await dispatchPendingBillingNotifications(organizationId);
    expect(sendMailMock).toHaveBeenCalledTimes(1); // TEK satır → TEK gönderim.
  });
});

describe("YF-821 — kurtarılmış organizasyon süpürmede (sweep) ADAY bile OLMAZ", () => {
  it("delinquentSince: null olan sağlıklı bir organizasyon için sweep hiçbir hatırlatma/bildirim ÜRETMEZ", async () => {
    const { organizationId, fake, stripeCustomerId } = await setUpOrgWithCustomer();
    await grantActiveSubscription(fake, stripeCustomerId, "sub_notif_healthy");

    const result = await sweepBillingNotifications(new Date());
    expect(result.scanned).toBe(0); // `delinquentSince: { not: null }` sorgusuna hiç GİRMEDİ.
    expect(result.remindersScheduled).toBe(0);
    expect(result.expiredScheduled).toBe(0);

    const count = await db.billingNotification.count({ where: { organizationId } });
    expect(count).toBe(0);
    expect(sendMailMock).not.toHaveBeenCalled();
  });
});

describe("YF-821 — kurtarma (recovery) bildirimi", () => {
  it("PAST_DUE → ACTIVE geçişi OWNER'a TEK bir PAYMENT_RECOVERED e-postası gönderir; mükerrer kurtarma YENİDEN göndermez", async () => {
    const { organizationId, owner, fake, stripeCustomerId } = await setUpOrgWithCustomer();
    const sub = await grantActiveSubscription(fake, stripeCustomerId, "sub_notif_recover");
    fake.setSubscription({ ...sub, status: "past_due" });
    await processStripeWebhookEvent(
      invoiceEvent({ type: "invoice.payment_failed", subscriptionId: sub.id, customerId: stripeCustomerId }),
    );
    const openEpisode = await db.organizationStripeSubscription.findUniqueOrThrow({ where: { organizationId } });

    fake.setSubscription({ ...sub, status: "active" });
    await processStripeWebhookEvent(
      invoiceEvent({ type: "invoice.payment_succeeded", subscriptionId: sub.id, customerId: stripeCustomerId }),
    );

    const recovered = await db.billingNotification.findMany({ where: { organizationId, type: "PAYMENT_RECOVERED" } });
    expect(recovered).toHaveLength(1);
    expect(recovered[0]!.status).toBe("SENT");
    expect(recovered[0]!.episodeKey).toBe(openEpisode.delinquentSince!.toISOString());

    // Rutin, İKİNCİ bir başarılı yenileme ödemesi (organizasyon ZATEN sağlıklı) — YENİDEN göndermez.
    await processStripeWebhookEvent(
      invoiceEvent({ type: "invoice.payment_succeeded", subscriptionId: sub.id, customerId: stripeCustomerId }),
    );
    const recoveredCountAfterSecond = await db.billingNotification.count({ where: { organizationId, type: "PAYMENT_RECOVERED" } });
    expect(recoveredCountAfterSecond).toBe(1);

    expect(sendMailMock).toHaveBeenCalledTimes(2); // grace_started (1) + recovered (1) — ikinci başarı YENİ gönderim üretmedi.
    const recoveredCall = sendMailMock.mock.calls.find(([msg]) => msg.to === owner.email && msg.subject.includes("çözüldü"));
    expect(recoveredCall).toBeDefined();
  });

  it("kurtarma SONRASI yeni bir başarısızlık FARKLI episodeKey ile bağımsız, yeni bir GRACE_STARTED bildirimi gönderir", async () => {
    const { organizationId, fake, stripeCustomerId } = await setUpOrgWithCustomer();
    const sub = await grantActiveSubscription(fake, stripeCustomerId, "sub_notif_new_episode");

    fake.setSubscription({ ...sub, status: "past_due" });
    await processStripeWebhookEvent(
      invoiceEvent({ type: "invoice.payment_failed", subscriptionId: sub.id, customerId: stripeCustomerId, createdAt: NOW_SECONDS }),
    );

    fake.setSubscription({ ...sub, status: "active" });
    await processStripeWebhookEvent(
      invoiceEvent({
        type: "invoice.payment_succeeded",
        subscriptionId: sub.id,
        customerId: stripeCustomerId,
        createdAt: NOW_SECONDS + 100,
      }),
    );

    fake.setSubscription({ ...sub, status: "past_due" });
    await processStripeWebhookEvent(
      invoiceEvent({
        type: "invoice.payment_failed",
        subscriptionId: sub.id,
        customerId: stripeCustomerId,
        createdAt: NOW_SECONDS + 10 * 24 * 60 * 60,
      }),
    );

    const graceStarted = await db.billingNotification.findMany({
      where: { organizationId, type: "PAYMENT_FAILED_GRACE_STARTED" },
      orderBy: { createdAt: "asc" },
    });
    expect(graceStarted).toHaveLength(2); // İKİ BAĞIMSIZ bölüm — ikisi de ayrı ayrı bildirildi.
    expect(graceStarted[0]!.episodeKey).not.toBe(graceStarted[1]!.episodeKey);
    expect(graceStarted.every((n) => n.status === "SENT")).toBe(true);

    expect(sendMailMock).toHaveBeenCalledTimes(3); // grace1 + recovered + grace2.
  });
});

describe("YF-821 — uyuşmazlık (dispute, YF-815) kompozisyonu", () => {
  it("sendPaymentRecoveredEmail: stillRestrictedByDispute bayrağına göre konu/içerik FARKLILAŞIR (tam kurtarma İDDİA EDİLMEZ)", async () => {
    const recipient: BillingNotificationRecipient = { userId: "u1", email: "owner@example.com", firstName: "Ayşe" };
    await sendPaymentRecoveredEmail(recipient, { organizationName: "Test Org", stillRestrictedByDispute: false });
    await sendPaymentRecoveredEmail(recipient, { organizationName: "Test Org", stillRestrictedByDispute: true });

    expect(sendMailMock).toHaveBeenCalledTimes(2);
    const [normalMsg] = sendMailMock.mock.calls[0]!;
    const [restrictedMsg] = sendMailMock.mock.calls[1]!;
    expect(normalMsg.subject).toBe("YapiFin — Ödeme sorunu çözüldü");
    expect(normalMsg.text).toContain("normal erişiminiz geri yüklendi");
    expect(restrictedMsg.subject).toContain("kısmen kısıtlı");
    expect(restrictedMsg.text).toContain("itiraz");
    expect(restrictedMsg.text).not.toContain("normal erişiminiz geri yüklendi"); // Tam kurtarma İDDİA EDİLMEZ.
  });

  it("dunning KURTARILDIĞINDA hâlâ LOST bir dispute varsa PAYMENT_RECOVERED e-postası kısıtlamanın DEVAM ettiğini belirtir", async () => {
    const { organizationId, owner, fake, stripeCustomerId } = await setUpOrgWithCustomer();
    const sub = await grantActiveSubscription(fake, stripeCustomerId, "sub_notif_dispute");
    fake.setSubscription({ ...sub, status: "past_due" });
    await processStripeWebhookEvent(
      invoiceEvent({ type: "invoice.payment_failed", subscriptionId: sub.id, customerId: stripeCustomerId }),
    );

    await createRestrictingDispute(organizationId);

    fake.setSubscription({ ...sub, status: "active" });
    await processStripeWebhookEvent(
      invoiceEvent({ type: "invoice.payment_succeeded", subscriptionId: sub.id, customerId: stripeCustomerId }),
    );

    const recoveredCall = sendMailMock.mock.calls.find(([msg]) => msg.to === owner.email && msg.subject.includes("çözüldü"));
    expect(recoveredCall).toBeDefined();
    const [message] = recoveredCall!;
    expect(message.subject).toContain("kısmen kısıtlı");
    expect(message.text).toContain("itiraz");
    expect(message.text).not.toContain("normal erişiminiz geri yüklendi");

    const recoveredRow = await db.billingNotification.findFirstOrThrow({ where: { organizationId, type: "PAYMENT_RECOVERED" } });
    expect(recoveredRow.status).toBe("SENT"); // Gönderim BAŞARILI oldu — yalnızca İÇERİK farklılaştı.
  });
});

describe("YF-821 — teslimat hataları ve yeniden deneme", () => {
  it("SMTP hatası satırı sınıflandırılmış, güvenli bir kategoriyle FAILED yapar; bir SONRAKİ deneme BAŞARIYLA SENT'e ulaşır (mükerrer YOK)", async () => {
    const { organizationId, owner, fake, stripeCustomerId } = await setUpOrgWithCustomer();
    const sub = await grantActiveSubscription(fake, stripeCustomerId, "sub_notif_fail_retry");
    fake.setSubscription({ ...sub, status: "past_due" });

    sendMailMock.mockRejectedValueOnce(
      Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:587"), { code: "ESOCKET" }),
    );
    await processStripeWebhookEvent(
      invoiceEvent({ type: "invoice.payment_failed", subscriptionId: sub.id, customerId: stripeCustomerId }),
    );

    const afterFailure = await db.billingNotification.findFirstOrThrow({
      where: { organizationId, type: "PAYMENT_FAILED_GRACE_STARTED" },
    });
    expect(afterFailure.status).toBe("FAILED");
    expect(afterFailure.lastError).toBe("CONNECTION_REFUSED"); // Sınıflandırılmış, güvenli kategori — ham hata mesajı DEĞİL.
    expect(afterFailure.lastError).not.toContain(owner.email);
    expect(afterFailure.attemptCount).toBe(1);

    const failedAudit = await db.auditLog.findFirst({ where: { organizationId, action: "billing.notification.failed" } });
    expect(failedAudit).not.toBeNull();
    expect(JSON.stringify(failedAudit!.afterJson)).not.toContain(owner.email); // Alıcı adresi audit'e YAZILMAZ.

    // Bir SONRAKİ deneme (ör. bir sonraki webhook/sweep turu) — bu sefer BAŞARILI (varsayılan mock uygulaması).
    await dispatchPendingBillingNotifications(organizationId);

    const afterRetry = await db.billingNotification.findFirstOrThrow({
      where: { organizationId, type: "PAYMENT_FAILED_GRACE_STARTED" },
    });
    expect(afterRetry.status).toBe("SENT");
    expect(afterRetry.attemptCount).toBe(2);
    expect(afterRetry.lastError).toBeNull();

    // TEK satır (mükerrer bildirim YOK) — yalnızca durum geçişi (FAILED → SENT).
    const totalRows = await db.billingNotification.count({ where: { organizationId, type: "PAYMENT_FAILED_GRACE_STARTED" } });
    expect(totalRows).toBe(1);
    expect(sendMailMock).toHaveBeenCalledTimes(2); // 1 başarısız deneme + 1 başarılı yeniden deneme.
  });
});

describe("YF-821 — finansal sınır (SaaS bildirimi, proje muhasebesinden AYRI)", () => {
  it("tam bildirim yaşam döngüsü (grace başlangıcı → hatırlatma → süre doldu → kurtarma) hiçbir finansal deftere YENİ satır EKLEMEZ", async () => {
    const { organizationId, owner, fake, stripeCustomerId } = await setUpOrgWithCustomer();
    await db.project.create({ data: { organizationId, code: "PRJ-NOTIF-FIN", name: "Bildirim Finansal Sınır" } });
    const account = await db.financialAccount.create({
      data: { organizationId, name: "Test Kasa", type: "CASH", currency: "TRY", isActive: true },
    });
    const category = await db.transactionCategory.create({
      data: { organizationId, type: "INCOME", name: "Test Kategori", isActive: true },
    });
    await db.financialTransaction.create({
      data: {
        organizationId,
        type: "INCOME",
        categoryId: category.id,
        description: "Baseline işlem",
        issueDate: new Date("2026-01-01T00:00:00.000Z"),
        subtotal: 1000,
        totalAmount: 1000,
        createdById: owner.id,
      },
    });
    await db.accountMovement.create({
      data: {
        organizationId,
        financialAccountId: account.id,
        type: "OPENING",
        direction: "CREDIT",
        amount: 1000,
        occurredAt: new Date("2026-01-01T00:00:00.000Z"),
        description: "Baseline açılış",
        createdById: owner.id,
      },
    });

    const before = {
      financialTransaction: await db.financialTransaction.count(),
      settlement: await db.settlement.count(),
      accountMovement: await db.accountMovement.count(),
      accountTransfer: await db.accountTransfer.count(),
      projectBudgetItem: await db.projectBudgetItem.count(),
    };

    const sub = await grantActiveSubscription(fake, stripeCustomerId, "sub_notif_fin_boundary");
    fake.setSubscription({ ...sub, status: "past_due" });
    await processStripeWebhookEvent(
      invoiceEvent({ type: "invoice.payment_failed", subscriptionId: sub.id, customerId: stripeCustomerId }),
    );

    // Hatırlatma penceresine GİR (sweep GRACE_EXPIRING_REMINDER planlar+gönderir).
    await db.organizationStripeSubscription.update({
      where: { organizationId },
      data: { gracePeriodEndsAt: new Date(Date.now() + 24 * 60 * 60 * 1000) },
    });
    await sweepBillingNotifications(new Date());

    // Grace süresi DOLDU (sweep GRACE_EXPIRED_RESTRICTED planlar+gönderir).
    await db.organizationStripeSubscription.update({
      where: { organizationId },
      data: { gracePeriodEndsAt: new Date(Date.now() - 1000) },
    });
    await sweepBillingNotifications(new Date());

    // Kurtarma.
    fake.setSubscription({ ...sub, status: "active" });
    await processStripeWebhookEvent(
      invoiceEvent({ type: "invoice.payment_succeeded", subscriptionId: sub.id, customerId: stripeCustomerId }),
    );

    const notifications = await db.billingNotification.findMany({
      where: { organizationId },
      select: { type: true, status: true },
    });
    expect(notifications.map((n) => n.type).sort()).toEqual(
      ["GRACE_EXPIRED_RESTRICTED", "GRACE_EXPIRING_REMINDER", "PAYMENT_FAILED_GRACE_STARTED", "PAYMENT_RECOVERED"].sort(),
    );
    expect(notifications.every((n) => n.status === "SENT")).toBe(true);

    const after = {
      financialTransaction: await db.financialTransaction.count(),
      settlement: await db.settlement.count(),
      accountMovement: await db.accountMovement.count(),
      accountTransfer: await db.accountTransfer.count(),
      projectBudgetItem: await db.projectBudgetItem.count(),
    };
    expect(after).toEqual(before); // Bildirim planlama/gönderimi bu tabloların HİÇBİRİNE dokunmadı.
  });
});
