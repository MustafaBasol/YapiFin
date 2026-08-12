import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { cleanDatabase, createFakeStripeGateway, createOwnerOrg } from "./helpers";
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
import { resetBillingSweepSecretCacheForTests } from "@/lib/billing/notification-policy";
import { sweepBillingNotifications } from "@/server/services/billing/billing-notification-sweep-service";

/**
 * YF-821 — dunning e-posta bildirim sweep'i (server/services/billing/billing-notification-sweep-service.ts)
 * + sweep uç noktası (app/api/internal/billing/dunning-sweep/route.ts) testleri.
 *
 * `tests/billing-dunning.test.ts` (YF-814) İLE AYNI kurulum kalıbı: gerçek
 * Stripe ağ çağrısı YOK, sahte gateway kullanılır. Gerçek e-posta gönderim
 * SEVİYESİ (`@/lib/email/mailer` `sendMail`) mock'lanır — YALNIZCA ihraç
 * edilen bağlayıcı (binding) override edilir; `sendMail`'in modül İÇİNDEKİ
 * diğer tüketicileri (ör. `sendVerificationEmail`, kayıt akışında
 * `createOwnerOrg` tarafından TETİKLENİR) kendi yerel kapanışlarını (closure)
 * kullanmaya devam eder ve gerçek dev-outbox (konsola yazma) davranışıyla
 * ETKİLENMEDEN çalışır (bkz. tests/mailer.test.ts "development + SMTP yok").
 */

const { sendMailMock } = vi.hoisted(() => ({ sendMailMock: vi.fn() }));
vi.mock("@/lib/email/mailer", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/email/mailer")>();
  return { ...actual, sendMail: sendMailMock };
});

const { POST } = await import("@/app/api/internal/billing/dunning-sweep/route");

function fakeSecretKey(mode: "test" | "live"): string {
  return ["sk", mode, "0000000000000000000000FAKE"].join("_");
}

const TEST_SECRET_KEY = fakeSecretKey("test");
const SWEEP_SECRET = `sweep-secret-${"x".repeat(24)}`;
const WRONG_SWEEP_SECRET = SWEEP_SECRET.slice(0, -1) + (SWEEP_SECRET.endsWith("0") ? "1" : "0");

function setTestEnv(overrides: Record<string, string | undefined> = {}) {
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
    BILLING_SWEEP_SECRET: SWEEP_SECRET,
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
  setTestEnv();
  eventSequence = 0;
  sendMailMock.mockReset();
  sendMailMock.mockResolvedValue(undefined);
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
  return `evt_sweep_test_${eventSequence}`;
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

function subscriptionEvent(overrides: {
  type?: string;
  subscriptionId: string;
  customerId: string;
  createdAt?: number;
}): StripeWebhookEventRef {
  return {
    kind: "SUBSCRIPTION",
    id: nextEventId(),
    type: overrides.type ?? "customer.subscription.updated",
    createdAt: overrides.createdAt ?? NOW_SECONDS,
    subscriptionId: overrides.subscriptionId,
    customerId: overrides.customerId,
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
    invoiceId: overrides.invoiceId ?? `in_sweep_test_${eventSequence}`,
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

/** Aktif bir abonelik grantlar, ardından `invoice.payment_failed` ile bir dunning bölümü AÇAR (webhook akışının kendisi — gerçek zamanlı en-iyi-çaba gönderimi TETİKLER). */
async function openEpisodeViaWebhook(
  fake: ReturnType<typeof createFakeStripeGateway>,
  stripeCustomerId: string,
  subId: string,
): Promise<void> {
  const sub = subscriptionRef({ id: subId, customerId: stripeCustomerId });
  fake.setSubscription(sub);
  await processStripeWebhookEvent(
    subscriptionEvent({ type: "customer.subscription.created", subscriptionId: subId, customerId: stripeCustomerId }),
  );
  fake.setSubscription({ ...sub, status: "past_due" });
  await processStripeWebhookEvent(
    invoiceEvent({ type: "invoice.payment_failed", subscriptionId: subId, customerId: stripeCustomerId }),
  );
}

describe("YF-821 — GRACE_EXPIRING_REMINDER hatırlatma penceresi", () => {
  it("gracePeriodEndsAt 72 saat uzaktaysa (pencere DIŞINDA) sweep hiçbir şey planlamaz", async () => {
    const { organizationId, fake, stripeCustomerId } = await setUpOrgWithCustomer();
    await openEpisodeViaWebhook(fake, stripeCustomerId, "sub_window_72h");
    sendMailMock.mockClear();

    await db.organizationStripeSubscription.update({
      where: { organizationId },
      data: { gracePeriodEndsAt: new Date(Date.now() + 72 * 60 * 60 * 1000) },
    });

    const result = await sweepBillingNotifications(new Date());
    expect(result.remindersScheduled).toBe(0);

    const reminders = await db.billingNotification.findMany({ where: { organizationId, type: "GRACE_EXPIRING_REMINDER" } });
    expect(reminders).toHaveLength(0);
    expect(sendMailMock).not.toHaveBeenCalled();
  });

  it("gracePeriodEndsAt 40 saat uzaktaysa (pencere İÇİNDE, henüz dolmamış) sweep TAM BİR hatırlatma planlar ve gönderir; TEKRAR sweep mükerrer üretmez", async () => {
    const { organizationId, fake, stripeCustomerId } = await setUpOrgWithCustomer();
    await openEpisodeViaWebhook(fake, stripeCustomerId, "sub_window_40h");
    sendMailMock.mockClear();

    await db.organizationStripeSubscription.update({
      where: { organizationId },
      data: { gracePeriodEndsAt: new Date(Date.now() + 40 * 60 * 60 * 1000) },
    });

    const first = await sweepBillingNotifications(new Date());
    expect(first.remindersScheduled).toBe(1);

    const reminder = await db.billingNotification.findFirstOrThrow({
      where: { organizationId, type: "GRACE_EXPIRING_REMINDER" },
    });
    expect(reminder.status).toBe("SENT");
    expect(reminder.recipientCount).toBe(1);
    expect(sendMailMock).toHaveBeenCalledTimes(1);

    const second = await sweepBillingNotifications(new Date());
    expect(second.remindersScheduled).toBe(0);

    const remindersAfter = await db.billingNotification.findMany({
      where: { organizationId, type: "GRACE_EXPIRING_REMINDER" },
    });
    expect(remindersAfter).toHaveLength(1); // Mükerrer satır ÜRETİLMEDİ (@@unique).
    expect(sendMailMock).toHaveBeenCalledTimes(1); // İkinci sweep TEKRAR göndermedi.
  });
});

describe("YF-821 — webhook HİÇ gelmeden grace süresinin dolması (RESTRICTED) tespiti", () => {
  it("gracePeriodEndsAt geçmişe alınırsa (YENİ webhook YOK) sweep RESTRICTED durumunu SAF zaman karşılaştırmasıyla tespit eder ve TAM BİR GRACE_EXPIRED_RESTRICTED gönderir; tekrar sweep mükerrer üretmez", async () => {
    const { organizationId, fake, stripeCustomerId } = await setUpOrgWithCustomer();
    await openEpisodeViaWebhook(fake, stripeCustomerId, "sub_expired_no_webhook");
    sendMailMock.mockClear();

    // Zamanın geçtiğini simüle eder — hiçbir Stripe webhook'u/mutabakat GEREKMEZ,
    // bkz. lib/billing/dunning-policy.ts "mutlak zaman damgası" tasarımı.
    await db.organizationStripeSubscription.update({
      where: { organizationId },
      data: { gracePeriodEndsAt: new Date(Date.now() - 1000) },
    });

    const first = await sweepBillingNotifications(new Date());
    expect(first.expiredScheduled).toBe(1);

    const notification = await db.billingNotification.findFirstOrThrow({
      where: { organizationId, type: "GRACE_EXPIRED_RESTRICTED" },
    });
    expect(notification.status).toBe("SENT");
    expect(sendMailMock).toHaveBeenCalledTimes(1);

    const second = await sweepBillingNotifications(new Date());
    expect(second.expiredScheduled).toBe(0);

    const rows = await db.billingNotification.findMany({ where: { organizationId, type: "GRACE_EXPIRED_RESTRICTED" } });
    expect(rows).toHaveLength(1);
    expect(sendMailMock).toHaveBeenCalledTimes(1);
  });
});

describe("YF-821 — sweep, FAILED bildirimleri YENİDEN dener", () => {
  it("önceden FAILED (simüle edilmiş bir önceki SMTP hatası) işaretlenmiş bir satır, sweep tarafından YENİDEN denenir ve SENT'e geçer", async () => {
    const { organizationId } = await createOwnerOrg();
    sendMailMock.mockClear();

    const failedNotification = await db.billingNotification.create({
      data: {
        organizationId,
        type: "PAYMENT_RECOVERED",
        episodeKey: new Date("2026-01-01T00:00:00.000Z").toISOString(),
        status: "FAILED",
        attemptCount: 1,
        lastError: "CONNECTION_TIMEOUT",
      },
    });

    const result = await sweepBillingNotifications(new Date());
    expect(result.organizationsDispatched).toBeGreaterThanOrEqual(1);
    expect(sendMailMock).toHaveBeenCalledTimes(1);

    const updated = await db.billingNotification.findUniqueOrThrow({ where: { id: failedNotification.id } });
    expect(updated.status).toBe("SENT");
    expect(updated.attemptCount).toBe(2); // 1 (önceki başarısız deneme) + 1 (bu yeniden deneme).
    expect(updated.lastError).toBeNull(); // Başarılı gönderim ÖNCEKİ hata özetini TEMİZLER.
  });
});

describe("YF-821 — sweep tekrar tekrar çağrılması güvenlidir (idempotent)", () => {
  it("art arda 3 sweep çağrısı, bildirim/gönderim sayısını SINIRSIZ ARTIRMAZ — yalnızca GERÇEKTEN vadesi gelen TEK SEFER gönderilir", async () => {
    const { organizationId, fake, stripeCustomerId } = await setUpOrgWithCustomer();
    await openEpisodeViaWebhook(fake, stripeCustomerId, "sub_idempotent_repeat");
    sendMailMock.mockClear();

    await db.organizationStripeSubscription.update({
      where: { organizationId },
      data: { gracePeriodEndsAt: new Date(Date.now() + 24 * 60 * 60 * 1000) }, // 48s pencere İÇİNDE.
    });

    const r1 = await sweepBillingNotifications(new Date());
    const r2 = await sweepBillingNotifications(new Date());
    const r3 = await sweepBillingNotifications(new Date());

    expect([r1.remindersScheduled, r2.remindersScheduled, r3.remindersScheduled]).toEqual([1, 0, 0]);

    const reminders = await db.billingNotification.findMany({
      where: { organizationId, type: "GRACE_EXPIRING_REMINDER" },
    });
    expect(reminders).toHaveLength(1);
    expect(sendMailMock).toHaveBeenCalledTimes(1);
  });
});

function sweepRouteRequest(headers: Record<string, string> = {}): NextRequest {
  return new NextRequest(new URL("http://localhost/api/internal/billing/dunning-sweep"), {
    method: "POST",
    headers,
  });
}

describe("YF-821 — POST /api/internal/billing/dunning-sweep yetkilendirme", () => {
  it("Authorization başlığı YOKSA 401 döner", async () => {
    const res = await POST(sweepRouteRequest());
    expect(res.status).toBe(401);
  });

  it("YANLIŞ sırla 401 döner", async () => {
    const res = await POST(sweepRouteRequest({ authorization: `Bearer ${WRONG_SWEEP_SECRET}` }));
    expect(res.status).toBe(401);
  });

  it("DOĞRU sırla (Bearer <BILLING_SWEEP_SECRET>) 200 döner ve sweep sonucu şeklini içerir", async () => {
    const res = await POST(sweepRouteRequest({ authorization: `Bearer ${SWEEP_SECRET}` }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      scanned: expect.any(Number),
      remindersScheduled: expect.any(Number),
      expiredScheduled: expect.any(Number),
      organizationsDispatched: expect.any(Number),
    });
  });

  it("BILLING_SWEEP_SECRET yapılandırılmamışsa fail-closed 500 döner (sessizce 200 DÖNMEZ)", async () => {
    setTestEnv({ BILLING_SWEEP_SECRET: undefined });
    const res = await POST(sweepRouteRequest({ authorization: `Bearer ${SWEEP_SECRET}` }));
    expect(res.status).toBe(500);
  });
});
