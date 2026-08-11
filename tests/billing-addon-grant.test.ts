import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { cleanDatabase, createFakeStripeGateway, createOrgUser, createOwnerOrg, setOrganizationPlan } from "./helpers";
import { resetEnvCacheForTests } from "@/lib/env";
import { resetStripeConfigCacheForTests } from "@/lib/billing/stripe-config";
import { resetStripeGatewayForTests, setStripeGatewayForTests, type StripeWebhookEventRef } from "@/lib/billing/stripe-gateway";
import { ensureOrganizationStripeCustomer } from "@/server/services/billing/stripe-customer-service";
import { processStripeWebhookEvent } from "@/server/services/billing/webhook-service";
import {
  buildAddonGrantIdempotencyKey,
  confirmAddonCheckoutSession,
  getAddonPurchaseStatus,
  reconcileAddonPurchase,
} from "@/server/services/billing/addon-grant-service";
import { checkLimit } from "@/lib/entitlements/entitlement-service";
import { ServiceError } from "@/server/services/errors";

/**
 * YF-813 — add-on (kullanım/ek-kota top-up) Stripe ödeme onayı/webhook/
 * mutabakat servis-katmanı testleri. `tests/billing-subscription-sync.test.ts`
 * (YF-810) ile AYNI kalıp: imza doğrulaması ATLANIR (yalnızca iş mantığı
 * test edilir), gerçek Stripe kimlik bilgisi/ağ çağrısı GEREKMEZ.
 */

function fakeSecretKey(mode: "test" | "live"): string {
  return ["sk", mode, "0000000000000000000000FAKE"].join("_");
}

const TEST_SECRET_KEY = fakeSecretKey("test");
const AI_PRICE = "price_FAKEaddonAiCredits001";
const OCR_PRICE = "price_FAKEaddonOcrDocs001";

function setStripeEnv(overrides: Record<string, string | undefined> = {}) {
  const values: Record<string, string | undefined> = {
    STRIPE_SECRET_KEY: TEST_SECRET_KEY,
    STRIPE_ENVIRONMENT: undefined,
    NEXT_PUBLIC_APP_URL: "https://app.example.com",
    STRIPE_PRICE_ADDON_AI_CREDITS: AI_PRICE,
    STRIPE_PRICE_ADDON_OCR_DOCS: OCR_PRICE,
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
  return `evt_addon_test_${eventSequence}`;
}

const NOW_SECONDS = Math.floor(Date.now() / 1000);

function checkoutSessionEvent(overrides: {
  type?: string;
  checkoutSessionId: string;
  customerId: string | null;
  createdAt?: number;
}): StripeWebhookEventRef {
  return {
    kind: "CHECKOUT_SESSION",
    id: nextEventId(),
    type: overrides.type ?? "checkout.session.completed",
    createdAt: overrides.createdAt ?? NOW_SECONDS,
    subscriptionId: null,
    customerId: overrides.customerId,
    checkoutSessionId: overrides.checkoutSessionId,
  };
}

async function setUpOrgWithCustomer() {
  const { owner, organizationId } = await createOwnerOrg();
  const fake = createFakeStripeGateway();
  setStripeGatewayForTests(fake.gateway);
  const customer = await ensureOrganizationStripeCustomer(owner);
  return { owner, organizationId, fake, stripeCustomerId: customer.stripeCustomerId };
}

/** Add-on Checkout Session'ı doğrudan (servis katmanını atlayarak) sahte gateway üzerinde oluşturur ve "ödendi" işaretler. */
async function createPaidAddonSession(
  fake: ReturnType<typeof createFakeStripeGateway>,
  organizationId: string,
  stripeCustomerId: string,
  addonKey: string,
  priceId: string,
) {
  const session = await fake.gateway.createAddonCheckoutSession({
    organizationId,
    customerId: stripeCustomerId,
    priceId,
    addonKey,
    successUrl: "https://app.example.com/success",
    cancelUrl: "https://app.example.com/cancel",
    idempotencyKey: `test-addon-checkout-${organizationId}-${addonKey}-${Math.random()}`,
  });
  fake.markAddonCheckoutSessionPaid(session.id);
  return session;
}

describe("YF-813 — webhook: başarılı ödeme → tam olarak bir UsageAddonGrant", () => {
  it("checkout.session.completed (payment_status=paid) → bir grant oluşur, doğru kaynak/miktar/köken", async () => {
    const { organizationId, fake, stripeCustomerId } = await setUpOrgWithCustomer();
    const session = await createPaidAddonSession(fake, organizationId, stripeCustomerId, "ai_credits_pack", AI_PRICE);

    const event = checkoutSessionEvent({ checkoutSessionId: session.id, customerId: stripeCustomerId });
    const result = await processStripeWebhookEvent(event);

    expect(result.outcome).toBe("PROCESSED");
    const grants = await db.usageAddonGrant.findMany({ where: { organizationId } });
    expect(grants).toHaveLength(1);
    expect(grants[0].resource).toBe("ai.monthly_quota");
    expect(grants[0].amount).toBe(250);
    expect(grants[0].source).toBe("stripe_topup");
    expect(grants[0].idempotencyKey).toBe(buildAddonGrantIdempotencyKey("TEST", session.id));
    expect((grants[0].metadata as Record<string, unknown>).stripeCheckoutSessionId).toBe(session.id);
    expect((grants[0].metadata as Record<string, unknown>).addonKey).toBe("ai_credits_pack");
  });

  it("OCR paketi doğru kaynak/miktara bağışlanır", async () => {
    const { organizationId, fake, stripeCustomerId } = await setUpOrgWithCustomer();
    const session = await createPaidAddonSession(
      fake,
      organizationId,
      stripeCustomerId,
      "ocr_documents_pack",
      OCR_PRICE,
    );

    await processStripeWebhookEvent(checkoutSessionEvent({ checkoutSessionId: session.id, customerId: stripeCustomerId }));

    const grant = await db.usageAddonGrant.findFirstOrThrow({ where: { organizationId } });
    expect(grant.resource).toBe("ocr.monthly_quota");
    expect(grant.amount).toBe(25);
  });

  it("checkout.session.async_payment_succeeded (gecikmeli ödeme yöntemi) da bir bağışı TETİKLER", async () => {
    const { organizationId, fake, stripeCustomerId } = await setUpOrgWithCustomer();
    const session = await createPaidAddonSession(fake, organizationId, stripeCustomerId, "ai_credits_pack", AI_PRICE);

    const result = await processStripeWebhookEvent(
      checkoutSessionEvent({
        type: "checkout.session.async_payment_succeeded",
        checkoutSessionId: session.id,
        customerId: stripeCustomerId,
      }),
    );

    expect(result.outcome).toBe("PROCESSED");
    expect(await db.usageAddonGrant.count({ where: { organizationId } })).toBe(1);
  });
});

describe("YF-813 — idempotency (mükerrer/eşzamanlı olay)", () => {
  it("aynı stripeEventId ikinci kez teslim edildiğinde ikinci kez işlenmez, hâlâ tek grant", async () => {
    const { organizationId, fake, stripeCustomerId } = await setUpOrgWithCustomer();
    const session = await createPaidAddonSession(fake, organizationId, stripeCustomerId, "ai_credits_pack", AI_PRICE);
    const event = checkoutSessionEvent({ checkoutSessionId: session.id, customerId: stripeCustomerId });

    const first = await processStripeWebhookEvent(event);
    const second = await processStripeWebhookEvent(event);

    expect(first.outcome).toBe("PROCESSED");
    expect(second.outcome).toBe("DUPLICATE");
    expect(await db.usageAddonGrant.count({ where: { organizationId } })).toBe(1);
  });

  it("AYNI session için FARKLI olay ID'leri (completed + async_payment_succeeded) hâlâ TEK grant üretir", async () => {
    const { organizationId, fake, stripeCustomerId } = await setUpOrgWithCustomer();
    const session = await createPaidAddonSession(fake, organizationId, stripeCustomerId, "ai_credits_pack", AI_PRICE);

    await processStripeWebhookEvent(
      checkoutSessionEvent({ type: "checkout.session.completed", checkoutSessionId: session.id, customerId: stripeCustomerId }),
    );
    await processStripeWebhookEvent(
      checkoutSessionEvent({
        type: "checkout.session.async_payment_succeeded",
        checkoutSessionId: session.id,
        customerId: stripeCustomerId,
      }),
    );

    expect(await db.usageAddonGrant.count({ where: { organizationId } })).toBe(1);
  });

  it("eşzamanlı `confirmAddonCheckoutSession` çağrıları (webhook + mutabakat yarışı) hâlâ TEK grant üretir", async () => {
    const { organizationId, fake, stripeCustomerId } = await setUpOrgWithCustomer();
    const session = await createPaidAddonSession(fake, organizationId, stripeCustomerId, "ai_credits_pack", AI_PRICE);

    const params = {
      checkoutSessionId: session.id,
      organizationId,
      environment: "TEST" as const,
      expectedStripeCustomerId: stripeCustomerId,
    };
    const [a, b] = await Promise.all([confirmAddonCheckoutSession(params), confirmAddonCheckoutSession(params)]);

    const outcomes = [a.outcome, b.outcome].sort();
    expect(outcomes).toEqual(["ALREADY_GRANTED", "GRANTED"]);
    expect(await db.usageAddonGrant.count({ where: { organizationId } })).toBe(1);
  });
});

describe("YF-813 — başarısız/eksik ödeme → bağış YOK", () => {
  it("henüz ödenmemiş (payment_status=unpaid) bir Checkout redirect'i TEK BAŞINA bağış ÜRETMEZ", async () => {
    const { organizationId, fake, stripeCustomerId } = await setUpOrgWithCustomer();
    // Kasıtlı olarak `markAddonCheckoutSessionPaid` ÇAĞRILMAZ — "Checkout
    // redirect alone -> no grant" senaryosu.
    const session = await fake.gateway.createAddonCheckoutSession({
      organizationId,
      customerId: stripeCustomerId,
      priceId: AI_PRICE,
      addonKey: "ai_credits_pack",
      successUrl: "https://app.example.com/success",
      cancelUrl: "https://app.example.com/cancel",
      idempotencyKey: "test-unpaid-1",
    });

    const result = await processStripeWebhookEvent(
      checkoutSessionEvent({ checkoutSessionId: session.id, customerId: stripeCustomerId }),
    );

    expect(result.outcome).toBe("IGNORED");
    expect(await db.usageAddonGrant.count({ where: { organizationId } })).toBe(0);
  });

  it("bilinmeyen Stripe müşteri kimliği → hiçbir organizasyona yazma yapılmaz", async () => {
    const fake = createFakeStripeGateway();
    setStripeGatewayForTests(fake.gateway);

    const result = await processStripeWebhookEvent(
      checkoutSessionEvent({ checkoutSessionId: "cs_unknown", customerId: "cus_never_mapped" }),
    );

    expect(result.outcome).toBe("IGNORED");
    expect(await db.usageAddonGrant.count()).toBe(0);
  });

  it("yanlış müşteri (tenant çapraz doğrulama başarısız) → bağış YOK, fail-closed", async () => {
    const { organizationId, fake, stripeCustomerId } = await setUpOrgWithCustomer();
    const session = await createPaidAddonSession(fake, organizationId, stripeCustomerId, "ai_credits_pack", AI_PRICE);

    // Stripe'tan YENİDEN ÇEKİLEN session'ın customerId'sini, mapping'in
    // beklediğinden FARKLI bir değere değiştir (ör. tampered/replay senaryosu).
    fake.setAddonCheckoutSession({
      id: session.id,
      mode: "payment",
      customerId: "cus_completely_different",
      paymentStatus: "paid",
      priceId: AI_PRICE,
      paymentIntentId: "pi_fake",
      clientReferenceId: organizationId,
      addonKeyMetadata: "ai_credits_pack",
    });

    const result = await processStripeWebhookEvent(
      checkoutSessionEvent({ checkoutSessionId: session.id, customerId: stripeCustomerId }),
    );

    expect(result.outcome).toBe("IGNORED");
    expect(await db.usageAddonGrant.count({ where: { organizationId } })).toBe(0);
  });

  it("uydurma/eşleşmeyen Price ID (arbitrary Price ID injection) → bağış YOK", async () => {
    const { organizationId, fake, stripeCustomerId } = await setUpOrgWithCustomer();
    const session = await createPaidAddonSession(fake, organizationId, stripeCustomerId, "ai_credits_pack", AI_PRICE);

    // Metadata "ai_credits_pack" diyor ama Stripe'ın FİİLEN faturaladığı
    // Price farklı — katalog fiyat çapraz doğrulaması bunu YAKALAR.
    fake.setAddonCheckoutSession({
      id: session.id,
      mode: "payment",
      customerId: stripeCustomerId,
      paymentStatus: "paid",
      priceId: "price_ATTACKER_INJECTED_CHEAP_PRICE",
      paymentIntentId: "pi_fake",
      clientReferenceId: organizationId,
      addonKeyMetadata: "ai_credits_pack",
    });

    const result = await processStripeWebhookEvent(
      checkoutSessionEvent({ checkoutSessionId: session.id, customerId: stripeCustomerId }),
    );

    expect(result.outcome).toBe("IGNORED");
    expect(await db.usageAddonGrant.count({ where: { organizationId } })).toBe(0);
  });

  it("addonKey metadata'sı eksik/bilinmeyen → bağış YOK (arbitrary resource/amount enjeksiyonu yapısal olarak imkânsız)", async () => {
    const { organizationId, fake, stripeCustomerId } = await setUpOrgWithCustomer();
    const session = await createPaidAddonSession(fake, organizationId, stripeCustomerId, "ai_credits_pack", AI_PRICE);

    fake.setAddonCheckoutSession({
      id: session.id,
      mode: "payment",
      customerId: stripeCustomerId,
      paymentStatus: "paid",
      priceId: AI_PRICE,
      paymentIntentId: "pi_fake",
      clientReferenceId: organizationId,
      addonKeyMetadata: null,
    });

    const result = await processStripeWebhookEvent(
      checkoutSessionEvent({ checkoutSessionId: session.id, customerId: stripeCustomerId }),
    );

    expect(result.outcome).toBe("IGNORED");
    expect(await db.usageAddonGrant.count({ where: { organizationId } })).toBe(0);
  });
});

describe("YF-813 — mutabakat (reconciliation)", () => {
  it("webhook kaçırılmış ödeme → manuel mutabakat kurtarır (tam olarak bir grant)", async () => {
    const { owner, organizationId, fake, stripeCustomerId } = await setUpOrgWithCustomer();
    const session = await createPaidAddonSession(fake, organizationId, stripeCustomerId, "ocr_documents_pack", OCR_PRICE);

    // Webhook HİÇ çağrılmaz — doğrudan kullanıcı tetiklemeli mutabakat.
    const result = await reconcileAddonPurchase(owner, session.id);

    expect(result.outcome).toBe("GRANTED");
    expect(await db.usageAddonGrant.count({ where: { organizationId } })).toBe(1);
  });

  it("tekrar tekrar mutabakat mükerrer grant ÜRETMEZ", async () => {
    const { owner, organizationId, fake, stripeCustomerId } = await setUpOrgWithCustomer();
    const session = await createPaidAddonSession(fake, organizationId, stripeCustomerId, "ai_credits_pack", AI_PRICE);

    await reconcileAddonPurchase(owner, session.id);
    const second = await reconcileAddonPurchase(owner, session.id);
    const third = await reconcileAddonPurchase(owner, session.id);

    expect(second.outcome).toBe("ALREADY_GRANTED");
    expect(third.outcome).toBe("ALREADY_GRANTED");
    expect(await db.usageAddonGrant.count({ where: { organizationId } })).toBe(1);
  });

  it("OWNER olmayan roller mutabakat başlatamaz", async () => {
    const { organizationId, fake, stripeCustomerId } = await setUpOrgWithCustomer();
    const session = await createPaidAddonSession(fake, organizationId, stripeCustomerId, "ai_credits_pack", AI_PRICE);
    const admin = await createOrgUser(organizationId, "ADMIN");

    await expect(reconcileAddonPurchase(admin, session.id)).rejects.toThrow(ServiceError);
  });

  it("başka bir organizasyona ait bir sessionId'yi mutabakat için pasted etmek hiçbir grant ÜRETMEZ (tenant izolasyonu)", async () => {
    const { fake, stripeCustomerId: customerA } = await setUpOrgWithCustomer();
    const { owner: ownerB, organizationId: orgB } = await createOwnerOrg();
    await ensureOrganizationStripeCustomer(ownerB);

    const sessionA = await createPaidAddonSession(fake, "org-a-placeholder", customerA, "ai_credits_pack", AI_PRICE);

    const result = await reconcileAddonPurchase(ownerB, sessionA.id);
    expect(result.outcome).toBe("IGNORED");
    expect(await db.usageAddonGrant.count({ where: { organizationId: orgB } })).toBe(0);
  });
});

describe("YF-813 — success sayfası durumu (getAddonPurchaseStatus, SALT OKUNUR)", () => {
  it("bağış henüz onaylanmamışsa confirmed=false döner (Stripe'a GİTMEZ)", async () => {
    const { owner, fake, stripeCustomerId, organizationId } = await setUpOrgWithCustomer();
    const session = await createPaidAddonSession(fake, organizationId, stripeCustomerId, "ai_credits_pack", AI_PRICE);
    // Webhook/mutabakat HENÜZ çalışmadı.

    const status = await getAddonPurchaseStatus(owner, session.id);
    expect(status.confirmed).toBe(false);
  });

  it("bağış onaylandıktan SONRA confirmed=true + doğru kaynak/miktar döner", async () => {
    const { owner, fake, stripeCustomerId, organizationId } = await setUpOrgWithCustomer();
    const session = await createPaidAddonSession(fake, organizationId, stripeCustomerId, "ocr_documents_pack", OCR_PRICE);
    await reconcileAddonPurchase(owner, session.id);

    const status = await getAddonPurchaseStatus(owner, session.id);
    expect(status.confirmed).toBe(true);
    expect(status.resource).toBe("ocr.monthly_quota");
    expect(status.amount).toBe(25);
  });
});

describe("YF-813 — kota regresyonu (entitlement servisi otomatik yansıtır)", () => {
  it("Stripe onaylı bağış sonrası dahil kota + satın alınan kota TOPLANIR (Stripe'a özgü kota okuma İCAT EDİLMEDİ)", async () => {
    const { owner, organizationId, fake, stripeCustomerId } = await setUpOrgWithCustomer();
    await setOrganizationPlan(organizationId, "PROFESSIONAL"); // ai.monthly_quota dahil = 500

    const before = await checkLimit(db, organizationId, "ai.monthly_quota");
    expect(before.includedMax).toBe(500);
    expect(before.addonMax).toBe(0);
    expect(before.max).toBe(500);

    const session = await createPaidAddonSession(fake, organizationId, stripeCustomerId, "ai_credits_pack", AI_PRICE);
    await reconcileAddonPurchase(owner, session.id);

    const after = await checkLimit(db, organizationId, "ai.monthly_quota");
    expect(after.includedMax).toBe(500);
    expect(after.addonMax).toBe(250);
    expect(after.max).toBe(750);
  });
});
