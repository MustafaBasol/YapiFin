import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { cleanDatabase, createFakeStripeGateway, createOwnerOrg } from "./helpers";
import { resetEnvCacheForTests } from "@/lib/env";
import { resetStripeConfigCacheForTests } from "@/lib/billing/stripe-config";
import {
  resetStripeGatewayForTests,
  setStripeGatewayForTests,
  type StripeChargeRef,
  type StripeRefundRef,
  type StripeWebhookEventRef,
} from "@/lib/billing/stripe-gateway";
import { ensureOrganizationStripeCustomer } from "@/server/services/billing/stripe-customer-service";
import { processStripeWebhookEvent } from "@/server/services/billing/webhook-service";
import { reconcilePendingOrganizationRefunds, reconcileRefund } from "@/server/services/billing/refund-service";
import { getAiQuotaPeriodStart } from "@/lib/ai/quota-period";

/**
 * YF-815 — Stripe iade (refund) webhook işleme + YF-803 add-on kota
 * politikası + mutabakat servis-katmanı testleri. `tests/billing-subscription-sync.test.ts`
 * (YF-810)/`tests/billing-addon-grant.test.ts` (YF-813) ile AYNI kalıp:
 * imza doğrulaması ATLANIR, gerçek Stripe kimlik bilgisi/ağ çağrısı GEREKMEZ.
 */

function fakeSecretKey(mode: "test" | "live"): string {
  return ["sk", mode, "0000000000000000000000FAKE"].join("_");
}

const TEST_SECRET_KEY = fakeSecretKey("test");
const AI_PRICE = "price_FAKEaddonAiCredits001";

function setStripeEnv(overrides: Record<string, string | undefined> = {}) {
  const values: Record<string, string | undefined> = {
    STRIPE_SECRET_KEY: TEST_SECRET_KEY,
    STRIPE_ENVIRONMENT: undefined,
    NEXT_PUBLIC_APP_URL: "https://app.example.com",
    STRIPE_PRICE_ADDON_AI_CREDITS: AI_PRICE,
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
  return `evt_refund_test_${eventSequence}`;
}

const NOW_SECONDS = Math.floor(Date.now() / 1000);

function refundEvent(overrides: {
  type?: string;
  refundId: string;
  customerId: string | null;
  createdAt?: number;
}): StripeWebhookEventRef {
  return {
    kind: "REFUND",
    id: nextEventId(),
    type: overrides.type ?? "refund.created",
    createdAt: overrides.createdAt ?? NOW_SECONDS,
    refundId: overrides.refundId,
    customerId: overrides.customerId,
  };
}

async function setUpOrgWithCustomer() {
  const { owner, organizationId } = await createOwnerOrg();
  const fake = createFakeStripeGateway();
  setStripeGatewayForTests(fake.gateway);
  const customer = await ensureOrganizationStripeCustomer(owner);
  return { owner, organizationId, fake, stripeCustomerId: customer.stripeCustomerId };
}

/** Add-on Checkout Session'ı doğrudan sahte gateway üzerinde oluşturur ve "ödendi" işaretler — `confirmAddonCheckoutSession` ile gerçek bir `UsageAddonGrant` üretir. */
async function createPaidAddonGrant(
  fake: ReturnType<typeof createFakeStripeGateway>,
  organizationId: string,
  stripeCustomerId: string,
) {
  const session = await fake.gateway.createAddonCheckoutSession({
    organizationId,
    customerId: stripeCustomerId,
    priceId: AI_PRICE,
    addonKey: "ai_credits_pack",
    successUrl: "https://app.example.com/success",
    cancelUrl: "https://app.example.com/cancel",
    idempotencyKey: `test-addon-checkout-${organizationId}-${Math.random()}`,
  });
  fake.markAddonCheckoutSessionPaid(session.id);
  const event: StripeWebhookEventRef = {
    kind: "CHECKOUT_SESSION",
    id: nextEventId(),
    type: "checkout.session.completed",
    createdAt: NOW_SECONDS,
    subscriptionId: null,
    customerId: stripeCustomerId,
    checkoutSessionId: session.id,
  };
  const result = await processStripeWebhookEvent(event);
  expect(result.outcome).toBe("PROCESSED");
  const grant = await db.usageAddonGrant.findFirstOrThrow({ where: { organizationId } });
  const paymentIntentId = (grant.metadata as Record<string, unknown>).stripePaymentIntentId as string;
  return { grant, paymentIntentId };
}

function refundRef(overrides: Partial<StripeRefundRef> & { id: string; paymentIntentId: string; customerId: string }): StripeRefundRef {
  return {
    status: "succeeded",
    amount: 5000,
    currency: "try",
    chargeId: `ch_${overrides.id}`,
    createdAt: NOW_SECONDS,
    reason: "requested_by_customer",
    ...overrides,
  };
}

function chargeRef(overrides: Partial<StripeChargeRef> & { id: string }): StripeChargeRef {
  return {
    amount: 5000,
    amountRefunded: 5000,
    refunded: true,
    paymentIntentId: null,
    customerId: null,
    ...overrides,
  };
}

async function seedAiUsage(organizationId: string, consumedCredits: number) {
  const periodStart = getAiQuotaPeriodStart(new Date());
  await db.aiUsageLedger.create({
    data: {
      organizationId,
      periodStart,
      idempotencyKey: `test-ai-usage-${organizationId}-${Math.random()}`,
      provider: "test",
      status: "COMMITTED",
      reservedCredits: consumedCredits,
      consumedCredits,
      reservationExpiresAt: new Date(Date.now() + 60_000),
      correlationId: `test-corr-${Math.random()}`,
    },
  });
}

describe("YF-815 — add-on iade politikası (Case A/B/C)", () => {
  it("Case A — kullanılmamış add-on tam iade: grant tam olarak BİR kez sonlandırılır", async () => {
    const { organizationId, fake, stripeCustomerId } = await setUpOrgWithCustomer();
    const { grant, paymentIntentId } = await createPaidAddonGrant(fake, organizationId, stripeCustomerId);
    expect(grant.validUntil).toBeNull();

    const refund = refundRef({ id: "re_case_a", paymentIntentId, customerId: stripeCustomerId, chargeId: "ch_case_a" });
    fake.setRefund(refund);
    fake.setCharge(chargeRef({ id: "ch_case_a", paymentIntentId, customerId: stripeCustomerId, refunded: true }));

    const event = refundEvent({ refundId: refund.id, customerId: stripeCustomerId });
    const result = await processStripeWebhookEvent(event);
    expect(result.outcome).toBe("PROCESSED");

    const row = await db.stripeRefund.findUniqueOrThrow({
      where: { environment_stripeRefundId: { environment: "TEST", stripeRefundId: refund.id } },
    });
    expect(row.policyState).toBe("GRANT_EXPIRED");
    expect(row.relatedUsageAddonGrantId).toBe(grant.id);

    const updatedGrant = await db.usageAddonGrant.findUniqueOrThrow({ where: { id: grant.id } });
    expect(updatedGrant.validUntil).not.toBeNull();

    const auditCount = await db.auditLog.count({ where: { organizationId, action: "billing.refund.observed" } });
    expect(auditCount).toBe(1);
  });

  it("Case B — kısmi iade: bağış HİÇBİR mutasyona uğramaz, yalnızca kayıt tutulur (RETAINED)", async () => {
    const { organizationId, fake, stripeCustomerId } = await setUpOrgWithCustomer();
    const { grant, paymentIntentId } = await createPaidAddonGrant(fake, organizationId, stripeCustomerId);

    const refund = refundRef({
      id: "re_case_b",
      paymentIntentId,
      customerId: stripeCustomerId,
      chargeId: "ch_case_b",
      amount: 1000,
    });
    fake.setRefund(refund);
    // Charge KISMİ iade edildi (amount_refunded < amount, refunded: false).
    fake.setCharge(chargeRef({ id: "ch_case_b", paymentIntentId, customerId: stripeCustomerId, amount: 5000, amountRefunded: 1000, refunded: false }));

    const event = refundEvent({ refundId: refund.id, customerId: stripeCustomerId });
    await processStripeWebhookEvent(event);

    const row = await db.stripeRefund.findUniqueOrThrow({
      where: { environment_stripeRefundId: { environment: "TEST", stripeRefundId: refund.id } },
    });
    expect(row.policyState).toBe("RETAINED");

    const updatedGrant = await db.usageAddonGrant.findUniqueOrThrow({ where: { id: grant.id } });
    expect(updatedGrant.validUntil).toBeNull(); // Dokunulmadı.
  });

  it("Case C — tam iade ancak kullanım bu bağış olmadan üst sınırı aşıyor: grant SONLANDIRILIR ama EXPIRED_AFTER_CONSUMPTION ile işaretlenir, negatif kota OLUŞMAZ", async () => {
    const { organizationId, fake, stripeCustomerId } = await setUpOrgWithCustomer();
    const { grant, paymentIntentId } = await createPaidAddonGrant(fake, organizationId, stripeCustomerId);

    // PROFESSIONAL dahil kota: ai.monthly_quota = 500. Bu bağış olmadan
    // (max - grant.amount = 500) kullanım BUNU AŞACAK şekilde 600 kredi
    // tüketilmiş gibi kaydedilir — bağışın EN AZINDAN kısmen GEREKLİ olduğunu
    // kanıtlar.
    await seedAiUsage(organizationId, 600);

    const refund = refundRef({ id: "re_case_c", paymentIntentId, customerId: stripeCustomerId, chargeId: "ch_case_c" });
    fake.setRefund(refund);
    fake.setCharge(chargeRef({ id: "ch_case_c", paymentIntentId, customerId: stripeCustomerId, refunded: true }));

    const event = refundEvent({ refundId: refund.id, customerId: stripeCustomerId });
    await processStripeWebhookEvent(event);

    const row = await db.stripeRefund.findUniqueOrThrow({
      where: { environment_stripeRefundId: { environment: "TEST", stripeRefundId: refund.id } },
    });
    expect(row.policyState).toBe("EXPIRED_AFTER_CONSUMPTION");
    expect(row.manualReviewNote).not.toBeNull();

    const updatedGrant = await db.usageAddonGrant.findUniqueOrThrow({ where: { id: grant.id } });
    expect(updatedGrant.validUntil).not.toBeNull(); // Gelecekteki sayım durduruldu.

    // Geçmiş kullanım (AiUsageLedger) ASLA silinmez/mutasyona uğratılmaz.
    const usageCount = await db.aiUsageLedger.count({ where: { organizationId } });
    expect(usageCount).toBe(1);
  });

  it("Case D — mükerrer iade olayı: ikinci teslimat İKİNCİ bir eylem ÜRETMEZ", async () => {
    const { organizationId, fake, stripeCustomerId } = await setUpOrgWithCustomer();
    const { paymentIntentId } = await createPaidAddonGrant(fake, organizationId, stripeCustomerId);

    const refund = refundRef({ id: "re_case_d", paymentIntentId, customerId: stripeCustomerId, chargeId: "ch_case_d" });
    fake.setRefund(refund);
    fake.setCharge(chargeRef({ id: "ch_case_d", paymentIntentId, customerId: stripeCustomerId, refunded: true }));

    const event = refundEvent({ refundId: refund.id, customerId: stripeCustomerId });
    const first = await processStripeWebhookEvent(event);
    expect(first.outcome).toBe("PROCESSED");
    const second = await processStripeWebhookEvent(event); // AYNI stripeEventId — mükerrer teslimat.
    expect(second.outcome).toBe("DUPLICATE");

    const auditCount = await db.auditLog.count({ where: { organizationId, action: "billing.refund.observed" } });
    expect(auditCount).toBe(1);
  });

  it("eşzamanlı mükerrer iade işleme (org kilidi altında serileşir) grant'ı yalnızca BİR kez sonlandırır", async () => {
    const { organizationId, fake, stripeCustomerId, owner } = await setUpOrgWithCustomer();
    const { grant, paymentIntentId } = await createPaidAddonGrant(fake, organizationId, stripeCustomerId);

    const refund = refundRef({ id: "re_concurrent", paymentIntentId, customerId: stripeCustomerId, chargeId: "ch_concurrent" });
    fake.setRefund(refund);
    fake.setCharge(chargeRef({ id: "ch_concurrent", paymentIntentId, customerId: stripeCustomerId, refunded: true }));

    await Promise.all([reconcileRefund(owner, refund.id), reconcileRefund(owner, refund.id)]);

    const row = await db.stripeRefund.findUniqueOrThrow({
      where: { environment_stripeRefundId: { environment: "TEST", stripeRefundId: refund.id } },
    });
    expect(row.policyState).toBe("GRANT_EXPIRED");

    const updatedGrant = await db.usageAddonGrant.findUniqueOrThrow({ where: { id: grant.id } });
    expect(updatedGrant.validUntil).not.toBeNull();

    const auditCount = await db.auditLog.count({ where: { organizationId, action: "billing.refund.observed" } });
    expect(auditCount).toBe(1); // Org-satır kilidi eşzamanlı iki çağrıyı SERİLEŞTİRDİ — ikinci bir yan etki ÜRETMEDİ.
  });

  it("Case E — sıra-dışı (out-of-order) iade olayları AYNI güncel duruma yakınsar", async () => {
    const { organizationId, fake, stripeCustomerId } = await setUpOrgWithCustomer();
    const { grant, paymentIntentId } = await createPaidAddonGrant(fake, organizationId, stripeCustomerId);

    const refund = refundRef({ id: "re_case_e", paymentIntentId, customerId: stripeCustomerId, chargeId: "ch_case_e" });
    fake.setRefund(refund); // Fake gateway HER ZAMAN GÜNCEL (succeeded) durumu döner.
    fake.setCharge(chargeRef({ id: "ch_case_e", paymentIntentId, customerId: stripeCustomerId, refunded: true }));

    // "refund.updated" ÖNCE, "refund.created" SONRA işlenir (sıra-dışı teslimat simülasyonu).
    const updatedEvt = refundEvent({ type: "refund.updated", refundId: refund.id, customerId: stripeCustomerId });
    const createdEvt = refundEvent({ type: "refund.created", refundId: refund.id, customerId: stripeCustomerId });

    await processStripeWebhookEvent(updatedEvt);
    await processStripeWebhookEvent(createdEvt);

    const row = await db.stripeRefund.findUniqueOrThrow({
      where: { environment_stripeRefundId: { environment: "TEST", stripeRefundId: refund.id } },
    });
    expect(row.policyState).toBe("GRANT_EXPIRED");

    const updatedGrant = await db.usageAddonGrant.findUniqueOrThrow({ where: { id: grant.id } });
    expect(updatedGrant.validUntil).not.toBeNull();

    const auditCount = await db.auditLog.count({ where: { organizationId, action: "billing.refund.observed" } });
    expect(auditCount).toBe(1); // İkinci (yakınsayan) olay YENİ bir audit ÜRETMEDİ.
  });

  it("bilinmeyen Checkout/Payment referansı (add-on'a bağlanamayan iade — ör. abonelik ödemesi) NOT_APPLICABLE olarak kaydedilir, hiçbir grant ETKİLENMEZ", async () => {
    const { organizationId, fake, stripeCustomerId } = await setUpOrgWithCustomer();

    const refund = refundRef({ id: "re_no_grant", paymentIntentId: "pi_unrelated_subscription_payment", customerId: stripeCustomerId, chargeId: "ch_no_grant" });
    fake.setRefund(refund);
    fake.setCharge(chargeRef({ id: "ch_no_grant", paymentIntentId: "pi_unrelated_subscription_payment", customerId: stripeCustomerId, refunded: true }));

    const event = refundEvent({ refundId: refund.id, customerId: stripeCustomerId });
    const result = await processStripeWebhookEvent(event);
    expect(result.outcome).toBe("PROCESSED");

    const row = await db.stripeRefund.findUniqueOrThrow({
      where: { environment_stripeRefundId: { environment: "TEST", stripeRefundId: refund.id } },
    });
    expect(row.policyState).toBe("NOT_APPLICABLE");
    expect(row.relatedUsageAddonGrantId).toBeNull();

    // Abonelik iadesi otomatik olarak plan/entitlement DEĞİŞİKLİĞİNE yol AÇMAZ.
    const org = await db.organization.findUniqueOrThrow({ where: { id: organizationId } });
    const subRow = await db.organizationStripeSubscription.findUnique({ where: { organizationId } });
    expect(org.planId).not.toBeNull();
    expect(subRow).toBeNull();
  });

  it("wrong grant association — bir organizasyona ait paymentIntentId, o organizasyonun DIŞINDA HİÇBİR bağışı ETKİLEMEZ", async () => {
    const orgA = await setUpOrgWithCustomer();
    // Ayrı bir gateway/organizasyon: farklı bir fake gateway TAKILMAZ (aynı
    // gateway paylaşılır — Stripe tarafı TEK bir hesaptır), ama farklı bir
    // organizasyon/Stripe müşterisi kurulur.
    const { owner: ownerB, organizationId: organizationIdB } = await createOwnerOrg();
    const customerB = await ensureOrganizationStripeCustomer(ownerB);

    const { grant: grantA, paymentIntentId } = await createPaidAddonGrant(orgA.fake, orgA.organizationId, orgA.stripeCustomerId);

    // B organizasyonuna ait bir iade, A'nın paymentIntentId'sini (çakışma
    // simülasyonu) taşısa DAHİ, sorgu B'nin organizationId'siyle scope'landığı
    // için A'nın bağışını ASLA bulamaz/etkilemez.
    const refund = refundRef({ id: "re_wrong_assoc", paymentIntentId, customerId: customerB.stripeCustomerId, chargeId: "ch_wrong_assoc" });
    orgA.fake.setRefund(refund);
    orgA.fake.setCharge(chargeRef({ id: "ch_wrong_assoc", paymentIntentId, customerId: customerB.stripeCustomerId, refunded: true }));

    const event = refundEvent({ refundId: refund.id, customerId: customerB.stripeCustomerId });
    await processStripeWebhookEvent(event);

    const rowB = await db.stripeRefund.findUniqueOrThrow({
      where: { environment_stripeRefundId: { environment: "TEST", stripeRefundId: refund.id } },
    });
    expect(rowB.organizationId).toBe(organizationIdB);
    expect(rowB.policyState).toBe("NOT_APPLICABLE");
    expect(rowB.relatedUsageAddonGrantId).toBeNull();

    const unchangedGrantA = await db.usageAddonGrant.findUniqueOrThrow({ where: { id: grantA.id } });
    expect(unchangedGrantA.validUntil).toBeNull();
  });
});

describe("YF-815 — tenant izolasyonu ve bilinmeyen referanslar", () => {
  it("bilinmeyen Stripe müşterisine ait bir iade olayı güvenle YOK SAYILIR", async () => {
    setStripeGatewayForTests(createFakeStripeGateway().gateway);
    const event = refundEvent({ refundId: "re_unknown_customer", customerId: "cus_completely_unknown" });

    const result = await processStripeWebhookEvent(event);
    expect(result.outcome).toBe("IGNORED");

    const rowCount = await db.stripeRefund.count();
    expect(rowCount).toBe(0);
  });

  it("cross-tenant uyuşmazlık: Stripe'ın döndürdüğü GERÇEK customerId, beklenen ile eşleşmiyorsa fail-closed reddedilir", async () => {
    const orgA = await setUpOrgWithCustomer();
    const { owner: ownerB } = await createOwnerOrg();
    const customerB = await ensureOrganizationStripeCustomer(ownerB);

    // A'nın müşterisine ait olduğu SÖYLENEN (webhook payload) ama Stripe'tan
    // YENİDEN ÇEKİLDİĞİNDE aslında B'ye ait ÇIKAN bir iade (ör. tamperlenmiş/
    // yanlış eşleşmiş bir olay) — refetch-on-write bunu YAKALAR.
    const refund = refundRef({ id: "re_tenant_mismatch", paymentIntentId: "pi_x", customerId: customerB.stripeCustomerId, chargeId: "ch_x" });
    orgA.fake.setRefund(refund);

    const event = refundEvent({ refundId: refund.id, customerId: orgA.stripeCustomerId });
    const result = await processStripeWebhookEvent(event);
    expect(result.outcome).toBe("IGNORED");

    const rowCount = await db.stripeRefund.count();
    expect(rowCount).toBe(0);
  });
});

describe("YF-815 — mutabakat (reconciliation)", () => {
  it("kaçırılmış webhook: bilinen bir stripeRefundId ile manuel mutabakat, ilk kez doğru politika SONUCUNU üretir", async () => {
    const { organizationId, fake, stripeCustomerId, owner } = await setUpOrgWithCustomer();
    const { grant, paymentIntentId } = await createPaidAddonGrant(fake, organizationId, stripeCustomerId);

    const refund = refundRef({ id: "re_missed_webhook", paymentIntentId, customerId: stripeCustomerId, chargeId: "ch_missed" });
    fake.setRefund(refund);
    fake.setCharge(chargeRef({ id: "ch_missed", paymentIntentId, customerId: stripeCustomerId, refunded: true }));

    // HİÇBİR webhook olayı işlenmedi — doğrudan mutabakat.
    const result = await reconcileRefund(owner, refund.id);
    expect(result.found).toBe(true);
    expect(result.policyState).toBe("GRANT_EXPIRED");

    const updatedGrant = await db.usageAddonGrant.findUniqueOrThrow({ where: { id: grant.id } });
    expect(updatedGrant.validUntil).not.toBeNull();
  });

  it("stale/pending yerel kayıt: Stripe GÜNCEL gerçeği 'succeeded' olduğunda süpürme (sweep) İDEMPOTENT biçimde yakınsar", async () => {
    const { organizationId, fake, stripeCustomerId } = await setUpOrgWithCustomer();
    const { grant, paymentIntentId } = await createPaidAddonGrant(fake, organizationId, stripeCustomerId);

    const refund = refundRef({ id: "re_stale", paymentIntentId, customerId: stripeCustomerId, chargeId: "ch_stale", status: "pending" });
    fake.setRefund(refund);
    fake.setCharge(chargeRef({ id: "ch_stale", paymentIntentId, customerId: stripeCustomerId, refunded: false, amountRefunded: 0 }));

    const event = refundEvent({ refundId: refund.id, customerId: stripeCustomerId });
    await processStripeWebhookEvent(event);

    let row = await db.stripeRefund.findUniqueOrThrow({
      where: { environment_stripeRefundId: { environment: "TEST", stripeRefundId: refund.id } },
    });
    expect(row.status).toBe("PENDING");
    expect(row.policyState).toBe("NOT_APPLICABLE");

    // Stripe'ın GÜNCEL gerçeği artık "succeeded" + charge tam iade edildi.
    fake.setRefund({ ...refund, status: "succeeded" });
    fake.setCharge(chargeRef({ id: "ch_stale", paymentIntentId, customerId: stripeCustomerId, refunded: true }));

    const firstSweepCount = await reconcilePendingOrganizationRefunds(organizationId, "TEST");
    expect(firstSweepCount).toBe(1);

    row = await db.stripeRefund.findUniqueOrThrow({
      where: { environment_stripeRefundId: { environment: "TEST", stripeRefundId: refund.id } },
    });
    expect(row.status).toBe("SUCCEEDED");
    expect(row.policyState).toBe("GRANT_EXPIRED");

    const updatedGrant = await db.usageAddonGrant.findUniqueOrThrow({ where: { id: grant.id } });
    const expiredAt = updatedGrant.validUntil;
    expect(expiredAt).not.toBeNull();

    // Tekrarlı mutabakat: artık bekleyen kayıt YOK, ikinci süpürme no-op'tur; grant YENİDEN mutasyona UĞRAMAZ.
    const secondSweepCount = await reconcilePendingOrganizationRefunds(organizationId, "TEST");
    expect(secondSweepCount).toBe(0);

    const grantAfterSecondSweep = await db.usageAddonGrant.findUniqueOrThrow({ where: { id: grant.id } });
    expect(grantAfterSecondSweep.validUntil?.getTime()).toBe(expiredAt!.getTime());
  });
});

describe("YF-815 — finansal sınır (görev talimatı kritik sınır)", () => {
  it("iade işlemleri SIFIR proje FinancialTransaction kaydı üretir", async () => {
    const { organizationId, fake, stripeCustomerId } = await setUpOrgWithCustomer();
    const { paymentIntentId } = await createPaidAddonGrant(fake, organizationId, stripeCustomerId);

    const refund = refundRef({ id: "re_fin_boundary", paymentIntentId, customerId: stripeCustomerId, chargeId: "ch_fin" });
    fake.setRefund(refund);
    fake.setCharge(chargeRef({ id: "ch_fin", paymentIntentId, customerId: stripeCustomerId, refunded: true }));

    const event = refundEvent({ refundId: refund.id, customerId: stripeCustomerId });
    await processStripeWebhookEvent(event);

    const financialTransactionCount = await db.financialTransaction.count({ where: { organizationId } });
    expect(financialTransactionCount).toBe(0);
  });
});
