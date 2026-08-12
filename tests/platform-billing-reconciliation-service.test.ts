import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { cleanDatabase, createFakeStripeGateway, createOwnerOrg } from "./helpers";
import { resetEnvCacheForTests } from "@/lib/env";
import { resetStripeConfigCacheForTests } from "@/lib/billing/stripe-config";
import { resetStripeGatewayForTests, setStripeGatewayForTests, type StripeSubscriptionRef } from "@/lib/billing/stripe-gateway";
import { ensureOrganizationStripeCustomer } from "@/server/services/billing/stripe-customer-service";
import { reconcilePlatformOrganizationSubscription } from "@/server/services/platform/platform-billing-reconciliation-service";
import type { PlatformAdminSessionUser } from "@/lib/auth/platform-session";

/**
 * YF-820 — `reconcilePlatformOrganizationSubscription`
 * (server/services/platform/platform-billing-reconciliation-service.ts)
 * servis-katmanı testleri.
 *
 * Yetki kontrolü (`requirePlatformAdmin()`) BU FONKSİYONUN İÇİNDE YOKTUR —
 * çağıran server action'da uygulanır (bkz. app/actions/platform-billing.ts,
 * YF-818 `getOrganizationBillingHealthById` İLE AYNI kabul: servis katmanı
 * organizationId'yi işler, sayfa/action katmanı yetkiyi uygular). Bu yüzden
 * bu dosya yetki/rol testleri İÇERMEZ — bkz.
 * tests/platform-billing-action-security.test.ts.
 *
 * `createFakeStripeGateway`/`setStripeEnv` deseni `tests/billing-subscription-sync.test.ts`
 * (YF-810) İLE BİREBİR AYNIDIR — gerçek Stripe kimlik bilgisi/ağ çağrısı GEREKMEZ.
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

const FAKE_ADMIN: PlatformAdminSessionUser = {
  id: "platform-admin-test-id",
  email: "platform-admin@example.com",
  name: "Test Platform Admin",
  status: "ACTIVE",
};

beforeAll(async () => {
  await cleanDatabase();
});

beforeEach(() => {
  originalEnv = { ...process.env };
  setStripeEnv();
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

const NOW_SECONDS = Math.floor(Date.now() / 1000);

function subscriptionRef(
  overrides: Partial<StripeSubscriptionRef> & { id: string; customerId: string },
): StripeSubscriptionRef {
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

async function setUpOrgWithCustomer() {
  const { owner, organizationId } = await createOwnerOrg();
  const fake = createFakeStripeGateway();
  setStripeGatewayForTests(fake.gateway);
  const customer = await ensureOrganizationStripeCustomer(owner);
  return { organizationId, fake, stripeCustomerId: customer.stripeCustomerId };
}

describe("YF-820 — reconcilePlatformOrganizationSubscription", () => {
  it("bilinmeyen organizasyon için NOT_FOUND fırlatır", async () => {
    await expect(
      reconcilePlatformOrganizationSubscription(FAKE_ADMIN, "org_does_not_exist", null),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("aktif duruma YAKINSAR (converge) ve plan hakkı verir", async () => {
    const { organizationId, fake, stripeCustomerId } = await setUpOrgWithCustomer();
    const sub = subscriptionRef({ id: "sub_platform_1", customerId: stripeCustomerId, priceId: "price_FAKEbusinessM001" });
    fake.setSubscription(sub);

    const result = await reconcilePlatformOrganizationSubscription(FAKE_ADMIN, organizationId, "destek talebi #1");
    expect(result.after.status).toBe("ACTIVE");
    expect(result.after.planCode).toBe("BUSINESS");
    expect(result.changed).toBe(true);
    expect(result.warnings).toEqual([]);

    const org = await db.organization.findUniqueOrThrow({ where: { id: organizationId } });
    const businessPlan = await db.plan.findUniqueOrThrow({ where: { code: "BUSINESS" } });
    expect(org.planId).toBe(businessPlan.id);
  });

  it("past_due/canceled durumuna da YAKINSAR", async () => {
    const { organizationId, fake, stripeCustomerId } = await setUpOrgWithCustomer();
    const sub = subscriptionRef({ id: "sub_platform_2", customerId: stripeCustomerId, status: "canceled" });
    fake.setSubscription(sub);

    const result = await reconcilePlatformOrganizationSubscription(FAKE_ADMIN, organizationId, null);
    expect(result.after.status).toBe("CANCELED");
  });

  it("Stripe müşteri eşlemesi yoksa mutabakat GÜVENLE BAŞARISIZ olur ve başarısızlık audit'i yazar", async () => {
    const { organizationId } = await createOwnerOrg();
    setStripeGatewayForTests(createFakeStripeGateway().gateway);

    await expect(
      reconcilePlatformOrganizationSubscription(FAKE_ADMIN, organizationId, "test reason"),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    const auditRow = await db.auditLog.findFirstOrThrow({
      where: { organizationId, action: "platform.billing.reconciliation.failed" },
    });
    expect(auditRow.actorId).toBeNull(); // AuditLog.actorId User'a FK'lidir — platform admin kimliği ASLA buraya yazılmaz.
    expect(auditRow.afterJson).toMatchObject({
      platformAdminId: FAKE_ADMIN.id,
      platformAdminEmail: FAKE_ADMIN.email,
      reason: "test reason",
    });
  });

  it("müşterinin Stripe'ta HİÇ aboneliği yoksa GÜVENLE nötr sonuç döner (uyarı taşır, hata FIRLATMAZ)", async () => {
    const { organizationId } = await setUpOrgWithCustomer();
    const result = await reconcilePlatformOrganizationSubscription(FAKE_ADMIN, organizationId, null);
    expect(result.after.found).toBe(false);
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it("art arda çağrılması İDEMPOTENTTİR ama HER admin eylemi KENDİ hesap verebilirlik kaydını üretir (mükerrer çalıştırma GÜVENLİDİR)", async () => {
    const { organizationId, fake, stripeCustomerId } = await setUpOrgWithCustomer();
    const sub = subscriptionRef({ id: "sub_platform_dup", customerId: stripeCustomerId, priceId: "price_FAKEstarterM001" });
    fake.setSubscription(sub);

    const first = await reconcilePlatformOrganizationSubscription(FAKE_ADMIN, organizationId, null);
    const second = await reconcilePlatformOrganizationSubscription(FAKE_ADMIN, organizationId, null);

    expect(first.after).toEqual(second.after);
    expect(second.changed).toBe(false); // İkinci çağrıda ARTIK bir değişiklik YOK.

    const entitlementAuditCount = await db.auditLog.count({
      where: { organizationId, action: "billing.subscription.entitlement_granted" },
    });
    expect(entitlementAuditCount).toBe(1); // Alttaki kanonik entitlement motoru İDEMPOTENT — mükerrer yan etki YOK.

    const reconciliationAuditCount = await db.auditLog.count({
      where: { organizationId, action: "platform.billing.reconciliation.succeeded" },
    });
    expect(reconciliationAuditCount).toBe(2); // Her admin eylemi ayrı bir hesap verebilirlik kaydı bırakır.
  });

  it("hiçbir proje finans kaydı (FinancialTransaction/Settlement) OLUŞTURMAZ", async () => {
    const { organizationId, fake, stripeCustomerId } = await setUpOrgWithCustomer();
    const sub = subscriptionRef({ id: "sub_platform_finance", customerId: stripeCustomerId });
    fake.setSubscription(sub);

    await reconcilePlatformOrganizationSubscription(FAKE_ADMIN, organizationId, null);

    expect(await db.financialTransaction.count()).toBe(0);
    expect(await db.settlement.count()).toBe(0);
  });
});
