import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { cleanDatabase, createFakeStripeGateway, createOwnerOrg } from "./helpers";
import { resetEnvCacheForTests } from "@/lib/env";
import { resetStripeConfigCacheForTests } from "@/lib/billing/stripe-config";
import {
  resetStripeGatewayForTests,
  setStripeGatewayForTests,
  type StripeDisputeRef,
  type StripeSubscriptionRef,
  type StripeWebhookEventRef,
} from "@/lib/billing/stripe-gateway";
import { ensureOrganizationStripeCustomer } from "@/server/services/billing/stripe-customer-service";
import {
  processStripeWebhookEvent,
  reconcileOrganizationStripeSubscription,
} from "@/server/services/billing/webhook-service";
import { createOrganizationBillingPortalSession } from "@/server/services/billing/billing-portal-service";
import { checkLimit } from "@/lib/entitlements/entitlement-service";
import {
  GRACE_PERIOD_DURATION_DAYS,
  computePaymentFailureState,
  openDunningEpisode,
  clearDunningEpisode,
  hasActiveDunningRestriction,
} from "@/lib/billing/dunning-policy";
import { hasActiveDisputeRestriction } from "@/lib/billing/dispute-policy";
import { assertNotBillingRestricted, hasActiveBillingRestriction } from "@/lib/billing/billing-restriction-policy";
import { createProject } from "@/server/services/project-service";
import { ServiceError } from "@/server/services/errors";
import type { SessionUser } from "@/lib/auth/session";

/**
 * YF-814 — Stripe ödeme gecikmesi (dunning) / grace period / faturalama
 * kurtarma servis-katmanı testleri. `tests/billing-subscription-sync.test.ts`
 * (YF-810) ve `tests/billing-dispute.test.ts` (YF-815) İLE AYNI kalıp: imza
 * doğrulaması ATLANIR, gerçek Stripe kimlik bilgisi/ağ çağrısı GEREKMEZ.
 */

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
});

afterEach(async () => {
  resetStripeGatewayForTests();
  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnv)) delete process.env[key];
  }
  Object.assign(process.env, originalEnv);
  resetEnvCacheForTests();
  resetStripeConfigCacheForTests();
  await cleanDatabase();
});

afterAll(async () => {
  await db.$disconnect();
});

function nextEventId(): string {
  eventSequence += 1;
  return `evt_dunning_test_${eventSequence}`;
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
    invoiceId: overrides.invoiceId ?? `in_test_${eventSequence}`,
    amountDue: 149900,
    currency: "try",
  };
}

function disputeEvent(overrides: { type?: string; disputeId: string; createdAt?: number }): StripeWebhookEventRef {
  return {
    kind: "DISPUTE",
    id: nextEventId(),
    type: overrides.type ?? "charge.dispute.created",
    createdAt: overrides.createdAt ?? NOW_SECONDS,
    disputeId: overrides.disputeId,
  };
}

function disputeRef(overrides: Partial<StripeDisputeRef> & { id: string; customerId: string | null }): StripeDisputeRef {
  return {
    status: "needs_response",
    amount: 5000,
    currency: "try",
    chargeId: `ch_${overrides.id}`,
    paymentIntentId: null,
    reason: "fraudulent",
    createdAt: NOW_SECONDS,
    ...overrides,
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
    subscriptionEvent({ type: "customer.subscription.created", subscriptionId: subId, customerId: stripeCustomerId }),
  );
  return sub;
}

describe("YF-814 — saf politika fonksiyonları (dunning-policy.ts)", () => {
  it("computePaymentFailureState: hiç bölüm yoksa NONE", () => {
    expect(computePaymentFailureState({ delinquentSince: null, gracePeriodEndsAt: null }, new Date())).toBe("NONE");
  });

  it("computePaymentFailureState: grace süresi İÇİNDE GRACE_PERIOD, dışında RESTRICTED (deterministik saat karşılaştırması)", () => {
    const delinquentSince = new Date("2026-01-01T00:00:00.000Z");
    const gracePeriodEndsAt = new Date("2026-01-08T00:00:00.000Z");
    expect(computePaymentFailureState({ delinquentSince, gracePeriodEndsAt }, new Date("2026-01-07T23:59:59.999Z"))).toBe(
      "GRACE_PERIOD",
    );
    expect(computePaymentFailureState({ delinquentSince, gracePeriodEndsAt }, new Date("2026-01-08T00:00:00.000Z"))).toBe(
      "RESTRICTED",
    );
    expect(computePaymentFailureState({ delinquentSince, gracePeriodEndsAt }, new Date("2026-01-08T00:00:00.001Z"))).toBe(
      "RESTRICTED",
    );
  });

  it("openDunningEpisode: bölüm zaten AÇIKSA no-op döner (grace süresi ASLA uzatılmaz)", () => {
    const now = new Date("2026-01-01T00:00:00.000Z");
    const opened = openDunningEpisode({ delinquentSince: null, gracePeriodEndsAt: null, recoveredAt: null }, now);
    expect(opened.delinquentSince).toEqual(now);
    expect(opened.gracePeriodEndsAt!.getTime() - now.getTime()).toBe(GRACE_PERIOD_DURATION_DAYS * 24 * 60 * 60 * 1000);

    const alreadyOpen = { delinquentSince: now, gracePeriodEndsAt: opened.gracePeriodEndsAt!, recoveredAt: null };
    const laterNow = new Date("2026-01-05T00:00:00.000Z");
    const reopened = openDunningEpisode(alreadyOpen, laterNow);
    expect(reopened).toEqual({}); // İdempotent no-op.
  });

  it("clearDunningEpisode: açık bölüm YOKSA no-op döner; açık bölüm VARSA recoveredAt damgalanır", () => {
    const now = new Date("2026-01-10T00:00:00.000Z");
    expect(clearDunningEpisode({ delinquentSince: null, gracePeriodEndsAt: null, recoveredAt: null }, now)).toEqual({});

    const cleared = clearDunningEpisode(
      { delinquentSince: new Date("2026-01-01T00:00:00.000Z"), gracePeriodEndsAt: new Date("2026-01-08T00:00:00.000Z"), recoveredAt: null },
      now,
    );
    expect(cleared).toEqual({ delinquentSince: null, gracePeriodEndsAt: null, recoveredAt: now });
  });
});

describe("YF-814 — ilk ödeme başarısızlığı grace period BAŞLATIR", () => {
  it("invoice.payment_failed + past_due refetch → delinquentSince/gracePeriodEndsAt olay zaman damgasından hesaplanır", async () => {
    const { organizationId, fake, stripeCustomerId } = await setUpOrgWithCustomer();
    const sub = await grantActiveSubscription(fake, stripeCustomerId, "sub_first_fail");

    fake.setSubscription({ ...sub, status: "past_due" });
    const failedAt = NOW_SECONDS + 1000;
    await processStripeWebhookEvent(
      invoiceEvent({ type: "invoice.payment_failed", subscriptionId: sub.id, customerId: stripeCustomerId, createdAt: failedAt }),
    );

    const row = await db.organizationStripeSubscription.findUniqueOrThrow({ where: { organizationId } });
    expect(row.status).toBe("PAST_DUE");
    expect(row.delinquentSince!.getTime()).toBe(failedAt * 1000);
    expect(row.gracePeriodEndsAt!.getTime()).toBe(failedAt * 1000 + GRACE_PERIOD_DURATION_DAYS * 24 * 60 * 60 * 1000);
    expect(row.recoveredAt).toBeNull();

    const auditLog = await db.auditLog.findFirst({ where: { organizationId, action: "billing.dunning.grace_started" } });
    expect(auditLog).not.toBeNull();
  });

  it("mükerrer AYNI webhook olayı ikinci kez işlenmez (idempotent)", async () => {
    const { organizationId, fake, stripeCustomerId } = await setUpOrgWithCustomer();
    const sub = await grantActiveSubscription(fake, stripeCustomerId, "sub_dup_fail");
    fake.setSubscription({ ...sub, status: "past_due" });

    const event = invoiceEvent({ type: "invoice.payment_failed", subscriptionId: sub.id, customerId: stripeCustomerId });
    const first = await processStripeWebhookEvent(event);
    expect(first.outcome).toBe("PROCESSED");
    const rowAfterFirst = await db.organizationStripeSubscription.findUniqueOrThrow({ where: { organizationId } });

    const second = await processStripeWebhookEvent(event); // AYNI stripeEventId.
    expect(second.outcome).toBe("DUPLICATE");

    const rowAfterSecond = await db.organizationStripeSubscription.findUniqueOrThrow({ where: { organizationId } });
    expect(rowAfterSecond.delinquentSince).toEqual(rowAfterFirst.delinquentSince);
    expect(rowAfterSecond.gracePeriodEndsAt).toEqual(rowAfterFirst.gracePeriodEndsAt);

    const auditCount = await db.auditLog.count({ where: { organizationId, action: "billing.dunning.grace_started" } });
    expect(auditCount).toBe(1);
  });

  it("tekrarlanan başarısız yeniden denemeler (FARKLI event id) grace süresini ASLA UZATMAZ (aynı bölüm yakınsar)", async () => {
    const { organizationId, fake, stripeCustomerId } = await setUpOrgWithCustomer();
    const sub = await grantActiveSubscription(fake, stripeCustomerId, "sub_retry_fail");
    fake.setSubscription({ ...sub, status: "past_due" });

    await processStripeWebhookEvent(
      invoiceEvent({ type: "invoice.payment_failed", subscriptionId: sub.id, customerId: stripeCustomerId, createdAt: NOW_SECONDS }),
    );
    const rowAfterFirst = await db.organizationStripeSubscription.findUniqueOrThrow({ where: { organizationId } });

    // Stripe'ın kendi akıllı yeniden deneme (smart retry) takviminden 3 GÜN
    // sonra İKİNCİ bir bağımsız `invoice.payment_failed` olayı (Stripe HÂLÂ
    // past_due döner).
    await processStripeWebhookEvent(
      invoiceEvent({
        type: "invoice.payment_failed",
        subscriptionId: sub.id,
        customerId: stripeCustomerId,
        createdAt: NOW_SECONDS + 3 * 24 * 60 * 60,
      }),
    );
    const rowAfterSecond = await db.organizationStripeSubscription.findUniqueOrThrow({ where: { organizationId } });

    expect(rowAfterSecond.delinquentSince).toEqual(rowAfterFirst.delinquentSince); // AYNI bölüm — dokunulmadı.
    expect(rowAfterSecond.gracePeriodEndsAt).toEqual(rowAfterFirst.gracePeriodEndsAt); // Grace süresi UZATILMADI.

    const auditCount = await db.auditLog.count({ where: { organizationId, action: "billing.dunning.grace_started" } });
    expect(auditCount).toBe(1); // Yalnızca İLK geçişte bildirim/audit üretildi — replay/retry mükerrer üretmedi.
  });

  it("eşzamanlı (concurrent) mükerrer teslimat çökmez ve TEK, tutarlı bir bölüm üretir", async () => {
    const { organizationId, fake, stripeCustomerId } = await setUpOrgWithCustomer();
    const sub = await grantActiveSubscription(fake, stripeCustomerId, "sub_concurrent_fail");
    fake.setSubscription({ ...sub, status: "past_due" });

    const event = invoiceEvent({ type: "invoice.payment_failed", subscriptionId: sub.id, customerId: stripeCustomerId });
    const results = await Promise.all([processStripeWebhookEvent(event), processStripeWebhookEvent(event)]);
    expect(results.every((r) => r.outcome === "PROCESSED" || r.outcome === "DUPLICATE")).toBe(true);

    const row = await db.organizationStripeSubscription.findUniqueOrThrow({ where: { organizationId } });
    expect(row.delinquentSince).not.toBeNull();
    expect(row.gracePeriodEndsAt!.getTime() - row.delinquentSince!.getTime()).toBe(
      GRACE_PERIOD_DURATION_DAYS * 24 * 60 * 60 * 1000,
    );

    const eventRows = await db.stripeWebhookEvent.findMany({ where: { stripeEventId: event.id } });
    expect(eventRows).toHaveLength(1); // Veritabanı düzeyinde tekillik korunur.
  });
});

describe("YF-814 — erişim politikası (grace aktif / grace süresi dolmuş)", () => {
  it("grace aktifken YENİ ücretli kaynak oluşturma HÂLÂ MÜMKÜNDÜR (yalnızca uyarı, kısıtlama YOK)", async () => {
    const { organizationId, owner, fake, stripeCustomerId } = await setUpOrgWithCustomer();
    const sub = await grantActiveSubscription(fake, stripeCustomerId, "sub_grace_active");
    fake.setSubscription({ ...sub, status: "past_due" });
    await processStripeWebhookEvent(
      invoiceEvent({ type: "invoice.payment_failed", subscriptionId: sub.id, customerId: stripeCustomerId }),
    );

    expect(await hasActiveDunningRestriction(db, organizationId)).toBe(false);
    await expect(assertNotBillingRestricted(db, organizationId)).resolves.toBeUndefined();
    await expect(
      createProject(owner as SessionUser, { code: "PRJ-GRACE-OK", name: "Grace İçinde" } as never),
    ).resolves.toBeDefined();
  });

  it("grace süresi DOLUNCA YENİ ücretli kaynak oluşturma ENGELLENİR (mevcut veri SİLİNMEZ, salt-okunur yollar ETKİLENMEZ)", async () => {
    const { organizationId, owner, fake, stripeCustomerId } = await setUpOrgWithCustomer();
    const existingProject = await db.project.create({
      data: { organizationId, code: "PRJ-EXISTING", name: "Mevcut Proje" },
    });

    const sub = await grantActiveSubscription(fake, stripeCustomerId, "sub_grace_expired");
    fake.setSubscription({ ...sub, status: "past_due" });
    await processStripeWebhookEvent(
      invoiceEvent({ type: "invoice.payment_failed", subscriptionId: sub.id, customerId: stripeCustomerId }),
    );

    // Grace süresinin GERÇEKTEN dolduğunu simüle etmek için mutlak son
    // tarihi geçmişe TAŞI (bkz. modül başı "mutlak zaman damgası" tasarımı —
    // hiçbir yeni webhook/mutabakat GEREKMEZ, bir SONRAKİ okuma anında karar
    // otomatik olarak RESTRICTED'e yakınsar).
    await db.organizationStripeSubscription.update({
      where: { organizationId },
      data: { gracePeriodEndsAt: new Date(Date.now() - 1000) },
    });

    expect(await hasActiveDunningRestriction(db, organizationId)).toBe(true);
    await expect(assertNotBillingRestricted(db, organizationId)).rejects.toBeInstanceOf(ServiceError);
    await expect(
      createProject(owner as SessionUser, { code: "PRJ-BLOCKED", name: "Engellenmeli" } as never),
    ).rejects.toBeInstanceOf(ServiceError);

    // Salt-okunur yol (`checkLimit`) ETKİLENMEZ.
    const limitCheck = await checkLimit(db, organizationId, "projects.active");
    expect(limitCheck.canAddOne).toBe(true);

    // Mevcut veri SİLİNMEZ — organizasyon ve mevcut proje erişilebilir kalır.
    const project = await db.project.findUnique({ where: { id: existingProject.id } });
    expect(project).not.toBeNull();
  });

  it("tenant izolasyonu: bir organizasyonun grace süresi dolması BAŞKA bir organizasyonu ETKİLEMEZ", async () => {
    const orgA = await setUpOrgWithCustomer();
    // orgB, orgA'nın ZATEN kurulu sahte gateway'ini PAYLAŞIR (bkz.
    // tests/billing-dispute.test.ts "cross-tenant koruması" AYNI desen) —
    // `setUpOrgWithCustomer`'ın İKİNCİ kez çağrılması YENİ, bağımsız bir
    // sahte gateway kurup mevcut olanın YERİNE geçirir ve her ikisinin
    // müşteri sırası 1'den başladığı için AYNI sahte Stripe müşteri
    // kimliğini üretip çakışmaya (unique constraint) yol açar.
    const { organizationId: organizationIdB, owner: ownerB } = await createOwnerOrg();
    const customerB = await ensureOrganizationStripeCustomer(ownerB);
    const orgB = { organizationId: organizationIdB, stripeCustomerId: customerB.stripeCustomerId };

    const subA = await grantActiveSubscription(orgA.fake, orgA.stripeCustomerId, "sub_tenant_a");
    orgA.fake.setSubscription({ ...subA, status: "past_due" });
    await processStripeWebhookEvent(
      invoiceEvent({ type: "invoice.payment_failed", subscriptionId: subA.id, customerId: orgA.stripeCustomerId }),
    );
    await db.organizationStripeSubscription.update({
      where: { organizationId: orgA.organizationId },
      data: { gracePeriodEndsAt: new Date(Date.now() - 1000) },
    });

    expect(await hasActiveDunningRestriction(db, orgA.organizationId)).toBe(true);
    expect(await hasActiveDunningRestriction(db, orgB.organizationId)).toBe(false);
    await expect(assertNotBillingRestricted(db, orgB.organizationId)).resolves.toBeUndefined();
  });
});

describe("YF-814 — kurtarma (recovery)", () => {
  it("başarılı yeniden deneme (Stripe active'e döner) kısıtlamayı TEMİZLER ve recoveredAt damgalar", async () => {
    const { organizationId, fake, stripeCustomerId } = await setUpOrgWithCustomer();
    const sub = await grantActiveSubscription(fake, stripeCustomerId, "sub_recover_1");
    fake.setSubscription({ ...sub, status: "past_due" });
    await processStripeWebhookEvent(
      invoiceEvent({ type: "invoice.payment_failed", subscriptionId: sub.id, customerId: stripeCustomerId }),
    );
    expect((await db.organizationStripeSubscription.findUniqueOrThrow({ where: { organizationId } })).delinquentSince).not.toBeNull();

    fake.setSubscription({ ...sub, status: "active" });
    const recoveredAtSeconds = NOW_SECONDS + 500;
    await processStripeWebhookEvent(
      invoiceEvent({
        type: "invoice.payment_succeeded",
        subscriptionId: sub.id,
        customerId: stripeCustomerId,
        createdAt: recoveredAtSeconds,
      }),
    );

    const row = await db.organizationStripeSubscription.findUniqueOrThrow({ where: { organizationId } });
    expect(row.delinquentSince).toBeNull();
    expect(row.gracePeriodEndsAt).toBeNull();
    expect(row.recoveredAt!.getTime()).toBe(recoveredAtSeconds * 1000);
    await expect(assertNotBillingRestricted(db, organizationId)).resolves.toBeUndefined();

    const auditLog = await db.auditLog.findFirst({ where: { organizationId, action: "billing.dunning.recovered" } });
    expect(auditLog).not.toBeNull();
  });

  it("mükerrer başarı olayı İKİNCİ bir kurtarma audit kaydı ÜRETMEZ", async () => {
    const { organizationId, fake, stripeCustomerId } = await setUpOrgWithCustomer();
    const sub = await grantActiveSubscription(fake, stripeCustomerId, "sub_dup_success");
    fake.setSubscription({ ...sub, status: "past_due" });
    await processStripeWebhookEvent(
      invoiceEvent({ type: "invoice.payment_failed", subscriptionId: sub.id, customerId: stripeCustomerId }),
    );

    fake.setSubscription({ ...sub, status: "active" });
    await processStripeWebhookEvent(
      invoiceEvent({ type: "invoice.payment_succeeded", subscriptionId: sub.id, customerId: stripeCustomerId }),
    );
    // Rutin, İKİNCİ bir başarılı yenileme ödemesi (organizasyon ZATEN sağlıklı).
    await processStripeWebhookEvent(
      invoiceEvent({ type: "invoice.payment_succeeded", subscriptionId: sub.id, customerId: stripeCustomerId }),
    );

    const auditCount = await db.auditLog.count({ where: { organizationId, action: "billing.dunning.recovered" } });
    expect(auditCount).toBe(1); // Zaten sağlıklıyken YENİDEN "kurtarıldı" olayı ÜRETİLMEDİ.
  });

  it("kurtarma SONRASI yeni bir başarısızlık BAĞIMSIZ, yeni bir gecikme bölümü başlatır", async () => {
    const { organizationId, fake, stripeCustomerId } = await setUpOrgWithCustomer();
    const sub = await grantActiveSubscription(fake, stripeCustomerId, "sub_new_episode");

    fake.setSubscription({ ...sub, status: "past_due" });
    await processStripeWebhookEvent(
      invoiceEvent({ type: "invoice.payment_failed", subscriptionId: sub.id, customerId: stripeCustomerId, createdAt: NOW_SECONDS }),
    );
    const firstEpisode = await db.organizationStripeSubscription.findUniqueOrThrow({ where: { organizationId } });

    fake.setSubscription({ ...sub, status: "active" });
    await processStripeWebhookEvent(
      invoiceEvent({ type: "invoice.payment_succeeded", subscriptionId: sub.id, customerId: stripeCustomerId, createdAt: NOW_SECONDS + 100 }),
    );

    fake.setSubscription({ ...sub, status: "past_due" });
    const secondFailureAt = NOW_SECONDS + 10 * 24 * 60 * 60;
    await processStripeWebhookEvent(
      invoiceEvent({
        type: "invoice.payment_failed",
        subscriptionId: sub.id,
        customerId: stripeCustomerId,
        createdAt: secondFailureAt,
      }),
    );

    const secondEpisode = await db.organizationStripeSubscription.findUniqueOrThrow({ where: { organizationId } });
    expect(secondEpisode.delinquentSince!.getTime()).toBe(secondFailureAt * 1000);
    expect(secondEpisode.delinquentSince!.getTime()).not.toBe(firstEpisode.delinquentSince!.getTime());
    expect(secondEpisode.gracePeriodEndsAt!.getTime()).toBe(
      secondFailureAt * 1000 + GRACE_PERIOD_DURATION_DAYS * 24 * 60 * 60 * 1000,
    );

    const graceStartedCount = await db.auditLog.count({ where: { organizationId, action: "billing.dunning.grace_started" } });
    expect(graceStartedCount).toBe(2); // İKİ BAĞIMSIZ bölüm — ikisi de ayrı ayrı kaydedildi.
  });

  it("sıra-dışı (out-of-order) ESKİ bir başarısızlık olayı, KURTARMA SONRASI yanlışlıkla YENİDEN KISITLAMAZ", async () => {
    const { organizationId, fake, stripeCustomerId } = await setUpOrgWithCustomer();
    const sub = await grantActiveSubscription(fake, stripeCustomerId, "sub_ooo_recovery");

    // Bölüm açılır (eski başarısızlık, geç teslimat SIRASINDA henüz YOK).
    fake.setSubscription({ ...sub, status: "past_due" });
    const oldFailureEvent = invoiceEvent({
      type: "invoice.payment_failed",
      subscriptionId: sub.id,
      customerId: stripeCustomerId,
      createdAt: NOW_SECONDS,
    });

    await processStripeWebhookEvent(oldFailureEvent);
    // NOT: `oldFailureEvent` HENÜZ Stripe'a/webhook kuyruğuna "gönderilmiş"
    // ama BİZE geç ulaşacak bir olayı temsil ediyor — burada BİLE İŞLENMİŞ
    // olsa senaryo geçerlidir (aşağıdaki asıl nokta: kurtarma SONRASI Stripe
    // artık `active` döndüğü İÇİN, bu event'in TEKRAR/geç işlenmesi dahi
    // yeniden kısıtlama ÜRETEMEZ — refetch-on-write kararı HER ZAMAN o ANKİ
    // Stripe gerçeğine göre verilir, olayın KENDİ etiketine DEĞİL).

    // Kurtarma: Stripe artık `active` döner.
    fake.setSubscription({ ...sub, status: "active" });
    await processStripeWebhookEvent(
      invoiceEvent({
        type: "invoice.payment_succeeded",
        subscriptionId: sub.id,
        customerId: stripeCustomerId,
        createdAt: NOW_SECONDS + 200,
      }),
    );
    expect((await db.organizationStripeSubscription.findUniqueOrThrow({ where: { organizationId } })).delinquentSince).toBeNull();

    // AYNI (eski, zaten işlenmiş) `invoice.payment_failed` olayının, farklı
    // bir `stripeEventId` ile GEÇ/yeniden gönderilen bir KOPYASI (Stripe'ın
    // gerçek dünyada farklı retry denemeleri farklı event id'lere sahip
    // olabilir) — Stripe'ın O ANKİ gerçeği HÂLÂ `active`dir.
    const lateDuplicateOfOldFailure = invoiceEvent({
      type: "invoice.payment_failed",
      subscriptionId: sub.id,
      customerId: stripeCustomerId,
      createdAt: NOW_SECONDS - 500, // Kurtarmadan bile ÖNCEKİ bir zaman damgası taşır.
    });
    await processStripeWebhookEvent(lateDuplicateOfOldFailure);

    const row = await db.organizationStripeSubscription.findUniqueOrThrow({ where: { organizationId } });
    expect(row.delinquentSince).toBeNull(); // YANLIŞLIKLA yeniden AÇILMADI.
    expect(row.status).toBe("ACTIVE"); // Refetch her zaman GÜNCEL Stripe gerçeğini yansıttı.
    await expect(assertNotBillingRestricted(db, organizationId)).resolves.toBeUndefined();
  });
});

describe("YF-814 — Stripe-otoritatif abonelik durumu (canceled/unpaid)", () => {
  it.each(["canceled", "unpaid"] as const)(
    "%s durumuna geçince açık bir grace bölümü VARSA temizlenir (erişim zaten NO_PLAN ile tam kapalıdır)",
    async (rawStatus) => {
      const { organizationId, fake, stripeCustomerId } = await setUpOrgWithCustomer();
      const sub = await grantActiveSubscription(fake, stripeCustomerId, `sub_cancel_${rawStatus}`);
      fake.setSubscription({ ...sub, status: "past_due" });
      await processStripeWebhookEvent(
        invoiceEvent({ type: "invoice.payment_failed", subscriptionId: sub.id, customerId: stripeCustomerId }),
      );
      expect((await db.organizationStripeSubscription.findUniqueOrThrow({ where: { organizationId } })).delinquentSince).not.toBeNull();

      fake.setSubscription({ ...sub, status: rawStatus, canceledAt: NOW_SECONDS, endedAt: NOW_SECONDS });
      await processStripeWebhookEvent(
        subscriptionEvent({ type: "customer.subscription.updated", subscriptionId: sub.id, customerId: stripeCustomerId }),
      );

      const row = await db.organizationStripeSubscription.findUniqueOrThrow({ where: { organizationId } });
      expect(row.delinquentSince).toBeNull();
      expect(row.gracePeriodEndsAt).toBeNull();

      const org = await db.organization.findUniqueOrThrow({ where: { id: organizationId } });
      expect(org.planId).toBeNull(); // NO_PLAN — dunning kısıtlamasından BAĞIMSIZ olarak zaten TAM kapalı.
    },
  );
});

describe("YF-814 — uyuşmazlık (dispute) politikası KOMPOZİSYONU", () => {
  it("dunning kısıtlıyken dispute yalnızca FLAGGED ise EK bir etkisi YOKTUR (dunning tek başına yeterlidir)", async () => {
    const { organizationId, owner, fake, stripeCustomerId } = await setUpOrgWithCustomer();
    const sub = await grantActiveSubscription(fake, stripeCustomerId, "sub_compose_1");
    fake.setSubscription({ ...sub, status: "past_due" });
    await processStripeWebhookEvent(
      invoiceEvent({ type: "invoice.payment_failed", subscriptionId: sub.id, customerId: stripeCustomerId }),
    );
    await db.organizationStripeSubscription.update({
      where: { organizationId },
      data: { gracePeriodEndsAt: new Date(Date.now() - 1000) },
    });

    const dispute = disputeRef({ id: "dp_compose_1", customerId: stripeCustomerId, status: "needs_response" });
    fake.setDispute(dispute);
    await processStripeWebhookEvent(disputeEvent({ disputeId: dispute.id }));

    expect(await hasActiveDunningRestriction(db, organizationId)).toBe(true);
    expect(await hasActiveDisputeRestriction(db, organizationId)).toBe(false); // Yalnızca FLAGGED — henüz kısıtlamaz.
    expect(await hasActiveBillingRestriction(db, organizationId)).toBe(true); // Kompoze gate YİNE DE kısıtlar (dunning yeterli).
    await expect(
      createProject(owner as SessionUser, { code: "PRJ-C1", name: "x" } as never),
    ).rejects.toBeInstanceOf(ServiceError);
  });

  it("dunning KURTARILSA bile dispute LOST devam ediyorsa HÂLÂ kısıtlıdır (bir politika DİĞERİNİ zayıflatmaz)", async () => {
    const { organizationId, owner, fake, stripeCustomerId } = await setUpOrgWithCustomer();
    const sub = await grantActiveSubscription(fake, stripeCustomerId, "sub_compose_2");

    fake.setSubscription({ ...sub, status: "past_due" });
    await processStripeWebhookEvent(
      invoiceEvent({ type: "invoice.payment_failed", subscriptionId: sub.id, customerId: stripeCustomerId }),
    );

    const dispute = disputeRef({ id: "dp_compose_2", customerId: stripeCustomerId, status: "lost" });
    fake.setDispute(dispute);
    await processStripeWebhookEvent(disputeEvent({ disputeId: dispute.id }));

    // Dunning kurtarılır (Stripe active'e döner) ama dispute HÂLÂ LOST/RESTRICTED.
    fake.setSubscription({ ...sub, status: "active" });
    await processStripeWebhookEvent(
      invoiceEvent({ type: "invoice.payment_succeeded", subscriptionId: sub.id, customerId: stripeCustomerId }),
    );

    expect(await hasActiveDunningRestriction(db, organizationId)).toBe(false); // Dunning TEMİZ.
    expect(await hasActiveDisputeRestriction(db, organizationId)).toBe(true); // Dispute HÂLÂ kısıtlıyor.
    expect(await hasActiveBillingRestriction(db, organizationId)).toBe(true); // Kompoze gate HÂLÂ kısıtlar.
    await expect(
      createProject(owner as SessionUser, { code: "PRJ-C2", name: "x" } as never),
    ).rejects.toBeInstanceOf(ServiceError);
  });

  it("dispute TEMİZLENSE bile grace süresi dolmuşsa HÂLÂ kısıtlıdır", async () => {
    const { organizationId, owner, fake, stripeCustomerId } = await setUpOrgWithCustomer();
    const sub = await grantActiveSubscription(fake, stripeCustomerId, "sub_compose_3");
    fake.setSubscription({ ...sub, status: "past_due" });
    await processStripeWebhookEvent(
      invoiceEvent({ type: "invoice.payment_failed", subscriptionId: sub.id, customerId: stripeCustomerId }),
    );
    await db.organizationStripeSubscription.update({
      where: { organizationId },
      data: { gracePeriodEndsAt: new Date(Date.now() - 1000) },
    });

    const dispute = disputeRef({ id: "dp_compose_3", customerId: stripeCustomerId, status: "needs_response" });
    fake.setDispute(dispute);
    await processStripeWebhookEvent(disputeEvent({ disputeId: dispute.id }));
    fake.setDispute({ ...dispute, status: "won" });
    await processStripeWebhookEvent(disputeEvent({ type: "charge.dispute.updated", disputeId: dispute.id }));

    expect(await hasActiveDisputeRestriction(db, organizationId)).toBe(false); // Dispute TEMİZ.
    expect(await hasActiveDunningRestriction(db, organizationId)).toBe(true); // Grace HÂLÂ dolmuş durumda.
    await expect(
      createProject(owner as SessionUser, { code: "PRJ-C3", name: "x" } as never),
    ).rejects.toBeInstanceOf(ServiceError);
  });

  it("her ikisi de TEMİZLENİNCE normal erişim TAMAMEN geri döner", async () => {
    const { organizationId, owner, fake, stripeCustomerId } = await setUpOrgWithCustomer();
    const sub = await grantActiveSubscription(fake, stripeCustomerId, "sub_compose_4");
    fake.setSubscription({ ...sub, status: "past_due" });
    await processStripeWebhookEvent(
      invoiceEvent({ type: "invoice.payment_failed", subscriptionId: sub.id, customerId: stripeCustomerId }),
    );

    const dispute = disputeRef({ id: "dp_compose_4", customerId: stripeCustomerId, status: "lost" });
    fake.setDispute(dispute);
    await processStripeWebhookEvent(disputeEvent({ disputeId: dispute.id }));

    fake.setSubscription({ ...sub, status: "active" });
    await processStripeWebhookEvent(
      invoiceEvent({ type: "invoice.payment_succeeded", subscriptionId: sub.id, customerId: stripeCustomerId }),
    );
    fake.setDispute({ ...dispute, status: "won" });
    await processStripeWebhookEvent(disputeEvent({ type: "charge.dispute.updated", disputeId: dispute.id }));

    expect(await hasActiveBillingRestriction(db, organizationId)).toBe(false);
    await expect(assertNotBillingRestricted(db, organizationId)).resolves.toBeUndefined();
    await expect(
      createProject(owner as SessionUser, { code: "PRJ-C4", name: "x" } as never),
    ).resolves.toBeDefined();
  });
});

describe("YF-814 — finansal sınır (SaaS faturalama, proje muhasebesinden AYRI)", () => {
  it("tam dunning yaşam döngüsü (başarısızlık → grace → kısıtlama → kurtarma) HİÇBİR FinancialTransaction ÜRETMEZ", async () => {
    const { organizationId, fake, stripeCustomerId } = await setUpOrgWithCustomer();
    const sub = await grantActiveSubscription(fake, stripeCustomerId, "sub_fin_boundary");

    fake.setSubscription({ ...sub, status: "past_due" });
    await processStripeWebhookEvent(
      invoiceEvent({ type: "invoice.payment_failed", subscriptionId: sub.id, customerId: stripeCustomerId }),
    );
    await db.organizationStripeSubscription.update({
      where: { organizationId },
      data: { gracePeriodEndsAt: new Date(Date.now() - 1000) },
    });
    expect(await hasActiveDunningRestriction(db, organizationId)).toBe(true);

    fake.setSubscription({ ...sub, status: "active" });
    await processStripeWebhookEvent(
      invoiceEvent({ type: "invoice.payment_succeeded", subscriptionId: sub.id, customerId: stripeCustomerId }),
    );

    const txCount = await db.financialTransaction.count({ where: { organizationId } });
    expect(txCount).toBe(0);
    const settlementCount = await db.settlement.count();
    expect(settlementCount).toBe(0);
  });
});

describe("YF-814 — mutabakat (reconciliation) kaçırılmış webhook'u kurtarır", () => {
  it("invoice.payment_failed webhook'u tamamen KAÇIRILMIŞSA, manuel mutabakat past_due'yu keşfedip grace period BAŞLATIR", async () => {
    const { owner, organizationId, fake, stripeCustomerId } = await setUpOrgWithCustomer();
    const sub = subscriptionRef({ id: "sub_reconcile_missed", customerId: stripeCustomerId, status: "past_due" });
    fake.setSubscription(sub);

    // Yerel satır HİÇ YOK — hiçbir webhook (ne subscription ne invoice) bu
    // organizasyon için hiç işlenmedi.
    expect(await db.organizationStripeSubscription.findUnique({ where: { organizationId } })).toBeNull();

    const result = await reconcileOrganizationStripeSubscription(owner);
    expect(result.found).toBe(true);
    expect(result.status).toBe("PAST_DUE");

    const row = await db.organizationStripeSubscription.findUniqueOrThrow({ where: { organizationId } });
    expect(row.delinquentSince).not.toBeNull();
    expect(row.gracePeriodEndsAt).not.toBeNull();
    expect(await hasActiveDunningRestriction(db, organizationId)).toBe(false); // Henüz grace İÇİNDE.
  });

  it("mutabakat art arda çağrılması İDEMPOTENTTİR (mükerrer grace_started audit kaydı ÜRETMEZ)", async () => {
    const { owner, organizationId, fake, stripeCustomerId } = await setUpOrgWithCustomer();
    const sub = subscriptionRef({ id: "sub_reconcile_idem", customerId: stripeCustomerId, status: "past_due" });
    fake.setSubscription(sub);

    await reconcileOrganizationStripeSubscription(owner);
    await reconcileOrganizationStripeSubscription(owner);
    const third = await reconcileOrganizationStripeSubscription(owner);
    expect(third.status).toBe("PAST_DUE");

    const auditCount = await db.auditLog.count({ where: { organizationId, action: "billing.dunning.grace_started" } });
    expect(auditCount).toBe(1);
  });
});

describe("YF-814 — faturalama portalı CTA (YF-811 için minimal, güvenli entegrasyon sınırı)", () => {
  it("yalnızca OWNER portal oturumu açabilir; Stripe müşteri kimliği İSTEMCİDEN alınmadan sunucu tarafında çözülür", async () => {
    const { owner, fake, stripeCustomerId } = await setUpOrgWithCustomer();
    const session = await createOrganizationBillingPortalSession(owner);
    expect(session.url).toContain(stripeCustomerId);
    expect(fake.billingPortalSessionCalls).toHaveLength(1);
    expect(fake.billingPortalSessionCalls[0]!.customerId).toBe(stripeCustomerId);
    expect(fake.billingPortalSessionCalls[0]!.returnUrl).toContain("/settings/plan");
  });
});
