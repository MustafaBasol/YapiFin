import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { cleanDatabase, createFakeStripeGateway, createOwnerOrg, createPlatformAdmin, setOrganizationPlan } from "./helpers";
import { resetEnvCacheForTests } from "@/lib/env";
import { resetStripeConfigCacheForTests } from "@/lib/billing/stripe-config";
import { resetStripeGatewayForTests, setStripeGatewayForTests, type StripeSubscriptionRef, type StripeWebhookEventRef } from "@/lib/billing/stripe-gateway";
import { ensureOrganizationStripeCustomer } from "@/server/services/billing/stripe-customer-service";
import { processStripeWebhookEvent, reconcileOrganizationStripeSubscription } from "@/server/services/billing/webhook-service";
import { applyPlatformPlanOverride } from "@/server/services/platform/platform-plan-override-service";

/**
 * YF-819-F1 — Stripe kanonik plan senkronizasyonu (webhook VEYA mutabakat,
 * ikisi de AYNI `syncSubscriptionFromStripe` çekirdeğini kullanır) organizasyonun
 * planını ACTIVE bir Platform Admin geçersiz kılmasının hedefinden FARKLI bir
 * plana taşıdığında, o geçersiz kılmanın `SUPERSEDED` olarak işaretlendiğini
 * doğrular (bkz. platform-plan-override-service.ts `supersedeActiveOverrideIfPlanDiffers`).
 * Otorite modeli DEĞİŞMEZ — Stripe otorite kalır, bu yalnızca bayat/yanıltıcı
 * "aktif override" görünümünü düzeltir.
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
  return `evt_test_${eventSequence}`;
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

async function setUpOrgWithCustomer() {
  const { owner, organizationId } = await createOwnerOrg();
  const fake = createFakeStripeGateway();
  setStripeGatewayForTests(fake.gateway);
  const customer = await ensureOrganizationStripeCustomer(owner);
  return { owner, organizationId, fake, stripeCustomerId: customer.stripeCustomerId };
}

async function applyOverride(organizationId: string, targetPlanCode: string, expectedCurrentPlanCode: string) {
  const admin = await createPlatformAdmin();
  return applyPlatformPlanOverride({
    organizationId,
    targetPlanCode,
    reason: "YF-819-F1 test — override senkronizasyon testi",
    expiresAt: null,
    expectedCurrentPlanCode,
    platformAdminId: admin.id,
    ipAddress: null,
    userAgent: null,
  });
}

describe("YF-819-F1 — webhook senkronizasyonu ACTIVE override'ı supersede eder", () => {
  it("Stripe grantı override hedefinden FARKLI bir plana taşırsa, override SUPERSEDED olur ve org.planId Stripe'ı takip eder", async () => {
    const { organizationId, fake, stripeCustomerId } = await setUpOrgWithCustomer();
    await setOrganizationPlan(organizationId, "STARTER");

    const applied = await applyOverride(organizationId, "PROFESSIONAL", "STARTER");

    const sub = subscriptionRef({ id: "sub_supersede_1", customerId: stripeCustomerId, priceId: "price_FAKEbusinessM001" });
    fake.setSubscription(sub);
    await processStripeWebhookEvent(
      subscriptionEvent({ type: "customer.subscription.updated", subscriptionId: sub.id, customerId: stripeCustomerId }),
    );

    const overrideRow = await db.platformPlanOverride.findUniqueOrThrow({ where: { id: applied.overrideId } });
    expect(overrideRow.status).toBe("SUPERSEDED");

    const org = await db.organization.findUniqueOrThrow({ where: { id: organizationId }, include: { plan: true } });
    expect(org.plan?.code).toBe("BUSINESS"); // Stripe otorite kaldı.
  });

  it("Stripe revoke (iptal) org.planId'yi null'a taşırsa ve bu, override'ın Stripe grantı ile eşleştiği içindir; ACTIVE override SUPERSEDED olur", async () => {
    const { organizationId, fake, stripeCustomerId } = await setUpOrgWithCustomer();
    const sub = subscriptionRef({ id: "sub_supersede_revoke_1", customerId: stripeCustomerId, priceId: "price_FAKEstarterM001" });
    fake.setSubscription(sub);
    // Stripe önce STARTER grantlar (lastGrantedPlanId = STARTER).
    await processStripeWebhookEvent(
      subscriptionEvent({ type: "customer.subscription.created", subscriptionId: sub.id, customerId: stripeCustomerId }),
    );

    // Platform Admin FARKLI bir plana (PROFESSIONAL) override eder — org.planId
    // artık PROFESSIONAL, ama `lastGrantedPlanId` (Stripe'ın kendi defteri)
    // HÂLÂ STARTER'dır (override bu alana dokunmaz).
    const applied = await applyOverride(organizationId, "PROFESSIONAL", "STARTER");
    const professionalPlan = await db.plan.findUniqueOrThrow({ where: { code: "PROFESSIONAL" } });
    expect((await db.organization.findUniqueOrThrow({ where: { id: organizationId } })).planId).toBe(professionalPlan.id);

    // Stripe'taki abonelik SONRADAN (bağımsız olarak) da PROFESSIONAL'a
    // taşınır — bu, org.planId'nin ZATEN override hedefiyle aynı olduğu
    // "değişiklik yok" dalıdır (applyGrant "zaten grantlanmış" bookkeeping),
    // ama `lastGrantedPlanId`'yi de PROFESSIONAL'a hizalar.
    fake.setSubscription({ ...sub, priceId: "price_FAKEprofessionalM001" });
    await processStripeWebhookEvent(
      subscriptionEvent({ type: "customer.subscription.updated", subscriptionId: sub.id, customerId: stripeCustomerId }),
    );
    const overrideStillActive = await db.platformPlanOverride.findUniqueOrThrow({ where: { id: applied.overrideId } });
    expect(overrideStillActive.status).toBe("ACTIVE"); // Sonuç plan zaten override hedefiyle AYNI.

    // Şimdi Stripe aboneliği TAMAMEN iptal edilir — revoke güvenlik koruması
    // `org.planId === lastGrantedPlanId` (ikisi de PROFESSIONAL) olduğu için
    // bu kez GERÇEKTEN uygulanır ve planı null'lar.
    fake.setSubscription({ ...sub, priceId: "price_FAKEprofessionalM001", status: "canceled" });
    await processStripeWebhookEvent(
      subscriptionEvent({ type: "customer.subscription.deleted", subscriptionId: sub.id, customerId: stripeCustomerId }),
    );

    const org = await db.organization.findUniqueOrThrow({ where: { id: organizationId } });
    expect(org.planId).toBeNull();

    const overrideRow = await db.platformPlanOverride.findUniqueOrThrow({ where: { id: applied.overrideId } });
    expect(overrideRow.status).toBe("SUPERSEDED"); // Artık yanıltıcı olurdu — org gerçekte plansız.
  });

  it("Stripe'ın uyguladığı plan override hedefiyle AYNIYSA supersede edilmez (gereksiz supersede yok)", async () => {
    const { organizationId, fake, stripeCustomerId } = await setUpOrgWithCustomer();
    await setOrganizationPlan(organizationId, "STARTER");

    const applied = await applyOverride(organizationId, "BUSINESS", "STARTER");

    const sub = subscriptionRef({ id: "sub_same_plan_1", customerId: stripeCustomerId, priceId: "price_FAKEbusinessM001" });
    fake.setSubscription(sub);
    await processStripeWebhookEvent(
      subscriptionEvent({ type: "customer.subscription.updated", subscriptionId: sub.id, customerId: stripeCustomerId }),
    );

    const overrideRow = await db.platformPlanOverride.findUniqueOrThrow({ where: { id: applied.overrideId } });
    expect(overrideRow.status).toBe("ACTIVE"); // Sonuç plan zaten override hedefiyle AYNI (BUSINESS).
  });

  it("ACTIVE override yoksa hiçbir şey yapmaz (no-op) — normal Stripe senkronizasyonu ETKİLENMEZ", async () => {
    const { organizationId, fake, stripeCustomerId } = await setUpOrgWithCustomer();
    const sub = subscriptionRef({ id: "sub_no_override_1", customerId: stripeCustomerId, priceId: "price_FAKEbusinessM001" });
    fake.setSubscription(sub);

    await processStripeWebhookEvent(
      subscriptionEvent({ type: "customer.subscription.created", subscriptionId: sub.id, customerId: stripeCustomerId }),
    );

    const org = await db.organization.findUniqueOrThrow({ where: { id: organizationId }, include: { plan: true } });
    expect(org.plan?.code).toBe("BUSINESS");
    expect(await db.platformPlanOverride.count({ where: { organizationId } })).toBe(0);
  });

  it("mükerrer webhook teslimatı İDEMPOTENTTİR — ikinci teslimat override'ı tekrar SUPERSEDED yapmaya ÇALIŞMAZ (zaten SUPERSEDED, no-op)", async () => {
    const { organizationId, fake, stripeCustomerId } = await setUpOrgWithCustomer();
    await setOrganizationPlan(organizationId, "STARTER");
    const applied = await applyOverride(organizationId, "PROFESSIONAL", "STARTER");

    const sub = subscriptionRef({ id: "sub_dup_supersede_1", customerId: stripeCustomerId, priceId: "price_FAKEbusinessM001" });
    fake.setSubscription(sub);

    const event = subscriptionEvent({ type: "customer.subscription.updated", subscriptionId: sub.id, customerId: stripeCustomerId });
    const first = await processStripeWebhookEvent(event);
    expect(first.outcome).toBe("PROCESSED");

    const afterFirst = await db.platformPlanOverride.findUniqueOrThrow({ where: { id: applied.overrideId } });
    expect(afterFirst.status).toBe("SUPERSEDED");
    const supersededAtFirst = afterFirst.updatedAt.getTime();

    // Aynı olay TEKRAR teslim edilir (Stripe retry) — idempotency katmanı DUPLICATE döner.
    const second = await processStripeWebhookEvent(event);
    expect(second.outcome).toBe("DUPLICATE");

    const afterSecond = await db.platformPlanOverride.findUniqueOrThrow({ where: { id: applied.overrideId } });
    expect(afterSecond.status).toBe("SUPERSEDED");
    expect(afterSecond.updatedAt.getTime()).toBe(supersededAtFirst); // İkinci kez YAZILMADI.

    // Farklı bir olay kimliğiyle (ör. mutabakat) AYNI Stripe durumu tekrar
    // işlense bile override zaten SUPERSEDED — tekrar dokunulmaz.
    await processStripeWebhookEvent(
      subscriptionEvent({ type: "customer.subscription.updated", subscriptionId: sub.id, customerId: stripeCustomerId }),
    );
    const afterThird = await db.platformPlanOverride.findUniqueOrThrow({ where: { id: applied.overrideId } });
    expect(afterThird.status).toBe("SUPERSEDED");
  });

  it("geçmiş REVOKED/EXPIRED/SUPERSEDED override kayıtlarına dokunmaz — yalnızca GÜNCEL ACTIVE satır etkilenebilir", async () => {
    const { organizationId, fake, stripeCustomerId } = await setUpOrgWithCustomer();
    await setOrganizationPlan(organizationId, "STARTER");

    const first = await applyOverride(organizationId, "PROFESSIONAL", "STARTER");
    const second = await applyOverride(organizationId, "BUSINESS", "PROFESSIONAL"); // İlkini SUPERSEDED yapar.

    const firstRow = await db.platformPlanOverride.findUniqueOrThrow({ where: { id: first.overrideId } });
    expect(firstRow.status).toBe("SUPERSEDED");
    const firstUpdatedAtBefore = firstRow.updatedAt.getTime();

    const sub = subscriptionRef({ id: "sub_historical_1", customerId: stripeCustomerId, priceId: "price_FAKEstarterM001" });
    fake.setSubscription(sub);
    await processStripeWebhookEvent(
      subscriptionEvent({ type: "customer.subscription.updated", subscriptionId: sub.id, customerId: stripeCustomerId }),
    );

    // İkinci (GÜNCEL ACTIVE) override artık SUPERSEDED olmalı.
    const secondRow = await db.platformPlanOverride.findUniqueOrThrow({ where: { id: second.overrideId } });
    expect(secondRow.status).toBe("SUPERSEDED");

    // İlk (zaten geçmiş) kayıt DOKUNULMADI.
    const firstRowAfter = await db.platformPlanOverride.findUniqueOrThrow({ where: { id: first.overrideId } });
    expect(firstRowAfter.status).toBe("SUPERSEDED");
    expect(firstRowAfter.updatedAt.getTime()).toBe(firstUpdatedAtBefore);
  });

  it("FinancialTransaction/Settlement/AccountMovement tablolarına HİÇBİR yazma yapmaz", async () => {
    const { organizationId, fake, stripeCustomerId } = await setUpOrgWithCustomer();
    await setOrganizationPlan(organizationId, "STARTER");
    await applyOverride(organizationId, "PROFESSIONAL", "STARTER");

    const before = await Promise.all([
      db.financialTransaction.count({ where: { organizationId } }),
      db.settlement.count({ where: { organizationId } }),
      db.accountMovement.count({ where: { organizationId } }),
    ]);

    const sub = subscriptionRef({ id: "sub_finance_isolation_1", customerId: stripeCustomerId, priceId: "price_FAKEbusinessM001" });
    fake.setSubscription(sub);
    await processStripeWebhookEvent(
      subscriptionEvent({ type: "customer.subscription.updated", subscriptionId: sub.id, customerId: stripeCustomerId }),
    );

    const after = await Promise.all([
      db.financialTransaction.count({ where: { organizationId } }),
      db.settlement.count({ where: { organizationId } }),
      db.accountMovement.count({ where: { organizationId } }),
    ]);
    expect(after).toEqual(before);
  });
});

describe("YF-819-F1 — mutabakat (reconciliation) AYNI çekirdeği kullandığı için otomatik kapsanır", () => {
  it("reconcileOrganizationStripeSubscription ACTIVE override'ı, Stripe'ın gerçek planı FARKLIYSA supersede eder", async () => {
    const { owner, organizationId, fake, stripeCustomerId } = await setUpOrgWithCustomer();
    await setOrganizationPlan(organizationId, "STARTER");
    const applied = await applyOverride(organizationId, "PROFESSIONAL", "STARTER");

    const sub = subscriptionRef({ id: "sub_reconcile_supersede_1", customerId: stripeCustomerId, priceId: "price_FAKEbusinessM001" });
    fake.setSubscription(sub);

    const result = await reconcileOrganizationStripeSubscription(owner);
    expect(result.planCode).toBe("BUSINESS");

    const overrideRow = await db.platformPlanOverride.findUniqueOrThrow({ where: { id: applied.overrideId } });
    expect(overrideRow.status).toBe("SUPERSEDED");
  });

  it("mutabakat art arda çağrılması İDEMPOTENTTİR — override ikinci kez tekrar SUPERSEDED yazılmaz", async () => {
    const { owner, organizationId, fake, stripeCustomerId } = await setUpOrgWithCustomer();
    await setOrganizationPlan(organizationId, "STARTER");
    const applied = await applyOverride(organizationId, "PROFESSIONAL", "STARTER");

    const sub = subscriptionRef({ id: "sub_reconcile_idempotent_1", customerId: stripeCustomerId, priceId: "price_FAKEbusinessM001" });
    fake.setSubscription(sub);

    await reconcileOrganizationStripeSubscription(owner);
    const afterFirst = await db.platformPlanOverride.findUniqueOrThrow({ where: { id: applied.overrideId } });
    expect(afterFirst.status).toBe("SUPERSEDED");
    const updatedAtFirst = afterFirst.updatedAt.getTime();

    await reconcileOrganizationStripeSubscription(owner);
    const afterSecond = await db.platformPlanOverride.findUniqueOrThrow({ where: { id: applied.overrideId } });
    expect(afterSecond.status).toBe("SUPERSEDED");
    expect(afterSecond.updatedAt.getTime()).toBe(updatedAtFirst);
  });
});

describe("YF-819-F1 — eşzamanlılık: mevcut kilit/CAS tasarımıyla serileşme", () => {
  it("eşzamanlı Platform Admin override + Stripe webhook: hangi sırada tamamlanırsa tamamlansın, ACTIVE override (varsa) HER ZAMAN org.planId ile tutarlıdır", async () => {
    const { organizationId, fake, stripeCustomerId } = await setUpOrgWithCustomer();
    await setOrganizationPlan(organizationId, "STARTER");
    const admin = await createPlatformAdmin();

    const sub = subscriptionRef({ id: "sub_concurrent_1", customerId: stripeCustomerId, priceId: "price_FAKEbusinessM001" });
    fake.setSubscription(sub);

    await Promise.allSettled([
      applyPlatformPlanOverride({
        organizationId,
        targetPlanCode: "PROFESSIONAL",
        reason: "Eşzamanlı override — Stripe webhook ile aynı organizasyon satırı için yarışır",
        expiresAt: null,
        expectedCurrentPlanCode: "STARTER",
        platformAdminId: admin.id,
        ipAddress: null,
        userAgent: null,
      }),
      processStripeWebhookEvent(
        subscriptionEvent({ type: "customer.subscription.updated", subscriptionId: sub.id, customerId: stripeCustomerId }),
      ),
    ]);

    const org = await db.organization.findUniqueOrThrow({ where: { id: organizationId } });
    const activeOverride = await db.platformPlanOverride.findFirst({ where: { organizationId, status: "ACTIVE" } });
    // Hangi işlem satır kilidini ÖNCE/SONRA alırsa alsın, ACTIVE bir override
    // kalmışsa onun hedef planı GÜNCEL org.planId ile HER ZAMAN eşleşmelidir —
    // aksi halde UI yanıltıcı bir "aktif" durum gösterirdi.
    if (activeOverride) {
      expect(activeOverride.planId).toBe(org.planId);
    }
    // Hiçbir override satırı kaybolmadı (silinmedi).
    expect(await db.platformPlanOverride.count({ where: { organizationId } })).toBeGreaterThanOrEqual(1);
  });
});
