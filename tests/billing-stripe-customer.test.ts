import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import Stripe from "stripe";
import { db } from "@/lib/db";
import {
  cleanDatabase,
  createFakeStripeGateway,
  createOrgUser,
  createOwnerOrg,
  createTestPlan,
  setOrganizationPlan,
} from "./helpers";
import { resetEnvCacheForTests } from "@/lib/env";
import { resetStripeConfigCacheForTests } from "@/lib/billing/stripe-config";
import {
  resetStripeGatewayForTests,
  setStripeGatewayForTests,
  toBillingProviderError,
  type StripeGateway,
} from "@/lib/billing/stripe-gateway";
import { BillingConfigError, BillingProviderError } from "@/lib/billing/errors";
import {
  buildCustomerIdempotencyKey,
  ensureOrganizationStripeCustomer,
  getOrganizationStripeCustomer,
} from "@/server/services/billing/stripe-customer-service";
import { ServiceError } from "@/server/services/errors";
import {
  canUseCapability,
  checkLimit,
  getEffectivePlan,
} from "@/lib/entitlements/entitlement-service";

/**
 * YF-808 — Organizasyon ↔ Stripe Customer eşlemesi, eşzamanlılık/idempotency,
 * tenant izolasyonu ve **YF-802 entitlement otoritesinin korunduğunun** kanıtı.
 *
 * Gerçek Stripe kimlik bilgisi GEREKMEZ: `setStripeGatewayForTests` ile
 * deterministik bir sahte gateway takılır, hiçbir ağ çağrısı yapılmaz.
 */

/**
 * Sahte anahtarlar kaynakta ANAHTAR BİÇİMİNDE yazılmaz — parçalardan
 * üretilir. Böylece gerçek bir sır olmasalar bile sır tarayıcıları (GitHub
 * push protection vb.) tarafından yanlışlıkla işaretlenmezler.
 */
function fakeSecretKey(mode: "test" | "live"): string {
  return ["sk", mode, "0000000000000000000000FAKE"].join("_");
}

const TEST_SECRET_KEY = fakeSecretKey("test");
const LIVE_SECRET_KEY = fakeSecretKey("live");

/** YF-809 — bu dosyada Checkout Session oluşturma hiç çağrılmadığı için sabit bir "kullanılmadı" stub'u yeterlidir. */
async function unusedCreateCheckoutSession(): Promise<never> {
  throw new Error("createCheckoutSession bu testte kullanılmamalıydı");
}

/** YF-813 — bu dosyada add-on Checkout işlemleri hiç çağrılmadığı için sabit bir "kullanılmadı" stub seti yeterlidir. */
async function unusedCreateAddonCheckoutSession(): Promise<never> {
  throw new Error("createAddonCheckoutSession bu testte kullanılmamalıydı");
}
async function unusedRetrieveCheckoutSessionForAddon(): Promise<null> {
  return null;
}

/** YF-810 — bu dosyada abonelik/webhook işlemleri hiç çağrılmadığı için sabit bir "kullanılmadı" stub seti yeterlidir. */
async function unusedRetrieveSubscription(): Promise<null> {
  return null;
}
async function unusedListSubscriptionsForCustomer(): Promise<never[]> {
  return [];
}
function unusedConstructWebhookEvent(): never {
  throw new Error("constructWebhookEvent bu testte kullanılmamalıydı");
}

/** YF-815 — bu dosyada iade/uyuşmazlık işlemleri hiç çağrılmadığı için sabit bir "kullanılmadı" stub seti yeterlidir. */
async function unusedRetrieveRefund(): Promise<null> {
  return null;
}
async function unusedRetrieveCharge(): Promise<null> {
  return null;
}
async function unusedRetrieveDispute(): Promise<null> {
  return null;
}

function setStripeEnv(overrides: Record<string, string | undefined> = {}) {
  const values: Record<string, string | undefined> = {
    STRIPE_SECRET_KEY: TEST_SECRET_KEY,
    STRIPE_ENVIRONMENT: undefined,
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

function clearStripeEnv() {
  for (const key of [
    "STRIPE_SECRET_KEY",
    "STRIPE_ENVIRONMENT",
    "STRIPE_PRICE_STARTER_MONTHLY",
    "STRIPE_PRICE_STARTER_ANNUAL",
    "STRIPE_PRICE_PROFESSIONAL_MONTHLY",
    "STRIPE_PRICE_PROFESSIONAL_ANNUAL",
    "STRIPE_PRICE_BUSINESS_MONTHLY",
    "STRIPE_PRICE_BUSINESS_ANNUAL",
    "STRIPE_PRICE_ENTERPRISE",
  ]) {
    delete process.env[key];
  }
  resetEnvCacheForTests();
  resetStripeConfigCacheForTests();
}

let originalEnv: Record<string, string | undefined>;

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

describe("YF-808 — Stripe müşteri eşlemesi: oluştur/yeniden kullan", () => {
  it("ilk çağrı müşteri oluşturur, ikinci çağrı MEVCUDU yeniden kullanır (mükerrer yok)", async () => {
    const fake = createFakeStripeGateway();
    setStripeGatewayForTests(fake.gateway);
    const { owner, organizationId } = await createOwnerOrg();

    const first = await ensureOrganizationStripeCustomer(owner);
    expect(first.created).toBe(true);
    expect(first.organizationId).toBe(organizationId);
    expect(first.environment).toBe("TEST");

    const second = await ensureOrganizationStripeCustomer(owner);
    expect(second.created).toBe(false);
    expect(second.stripeCustomerId).toBe(first.stripeCustomerId);

    const rows = await db.organizationStripeCustomer.findMany({ where: { organizationId } });
    expect(rows).toHaveLength(1);
    // İkinci çağrı Stripe'a hiç gitmez (DB doğruluk kaynağıdır).
    expect(fake.customerCalls).toHaveLength(1);
  });

  it("idempotency anahtarı deterministik ve ortam bazlıdır", async () => {
    const { organizationId } = await createOwnerOrg();
    const testKey = buildCustomerIdempotencyKey(organizationId, "TEST");
    expect(testKey).toBe(buildCustomerIdempotencyKey(organizationId, "TEST"));
    expect(testKey).not.toBe(buildCustomerIdempotencyKey(organizationId, "LIVE"));
    expect(testKey).toContain(organizationId);
    expect(testKey.length).toBeLessThanOrEqual(255);
  });

  it("aynı idempotency anahtarıyla tekrar (retry) Stripe'ta ikinci müşteri OLUŞTURMAZ", async () => {
    const fake = createFakeStripeGateway();
    setStripeGatewayForTests(fake.gateway);
    const { owner, organizationId } = await createOwnerOrg();

    await ensureOrganizationStripeCustomer(owner);
    // Kalıcı satırı silip "yalnızca Stripe tarafı yazılmış, DB yazılamamış"
    // yarım kalmış bir denemeyi simüle ediyoruz — retry aynı anahtarı
    // kullandığı için Stripe AYNI müşteriyi döner.
    await db.organizationStripeCustomer.deleteMany({ where: { organizationId } });
    const retried = await ensureOrganizationStripeCustomer(owner);

    expect(fake.customerCalls).toHaveLength(2);
    expect(fake.customerCalls[0].idempotencyKey).toBe(fake.customerCalls[1].idempotencyKey);
    expect(fake.distinctCustomerCount).toBe(1);
    expect(retried.stripeCustomerId).toBe("cus_fake_test_1");
  });

  it("eşzamanlı çağrılar tek satır ve tek Stripe müşterisi üretir", async () => {
    const fake = createFakeStripeGateway();
    setStripeGatewayForTests(fake.gateway);
    const { owner, organizationId } = await createOwnerOrg();

    const results = await Promise.all([
      ensureOrganizationStripeCustomer(owner),
      ensureOrganizationStripeCustomer(owner),
      ensureOrganizationStripeCustomer(owner),
    ]);

    const ids = new Set(results.map((r) => r.stripeCustomerId));
    expect(ids.size).toBe(1);
    expect(results.filter((r) => r.created)).toHaveLength(1);

    const rows = await db.organizationStripeCustomer.findMany({ where: { organizationId } });
    expect(rows).toHaveLength(1);
    expect(fake.distinctCustomerCount).toBe(1);
  });

  it("Stripe idempotency çakışmasında (eşzamanlı istek) mevcut satır yeniden kullanılır", async () => {
    const fake = createFakeStripeGateway();
    setStripeGatewayForTests(fake.gateway);
    const { owner } = await createOwnerOrg();
    const first = await ensureOrganizationStripeCustomer(owner);

    // Bundan sonra gateway her çağrıda IDEMPOTENCY_CONFLICT fırlatsın.
    setStripeGatewayForTests({
      environment: "TEST",
      async createCustomer() {
        throw new BillingProviderError("çakışma", "IDEMPOTENCY_CONFLICT", "idempotency_key_in_use");
      },
      async retrieveCustomer() {
        return null;
      },
      createCheckoutSession: unusedCreateCheckoutSession,
      createAddonCheckoutSession: unusedCreateAddonCheckoutSession,
      retrieveCheckoutSessionForAddon: unusedRetrieveCheckoutSessionForAddon,
      retrieveSubscription: unusedRetrieveSubscription,
      listSubscriptionsForCustomer: unusedListSubscriptionsForCustomer,
      retrieveRefund: unusedRetrieveRefund,
      retrieveCharge: unusedRetrieveCharge,
      retrieveDispute: unusedRetrieveDispute,
      constructWebhookEvent: unusedConstructWebhookEvent,
    });

    const reused = await ensureOrganizationStripeCustomer(owner);
    expect(reused.created).toBe(false);
    expect(reused.stripeCustomerId).toBe(first.stripeCustomerId);
  });

  it("henüz satır yokken idempotency çakışması kontrollü CONFLICT hatasına çevrilir", async () => {
    setStripeGatewayForTests({
      environment: "TEST",
      async createCustomer() {
        throw new BillingProviderError("çakışma", "IDEMPOTENCY_CONFLICT", "idempotency_key_in_use");
      },
      async retrieveCustomer() {
        return null;
      },
      createCheckoutSession: unusedCreateCheckoutSession,
      createAddonCheckoutSession: unusedCreateAddonCheckoutSession,
      retrieveCheckoutSessionForAddon: unusedRetrieveCheckoutSessionForAddon,
      retrieveSubscription: unusedRetrieveSubscription,
      listSubscriptionsForCustomer: unusedListSubscriptionsForCustomer,
      retrieveRefund: unusedRetrieveRefund,
      retrieveCharge: unusedRetrieveCharge,
      retrieveDispute: unusedRetrieveDispute,
      constructWebhookEvent: unusedConstructWebhookEvent,
    });
    const { owner } = await createOwnerOrg();

    await expect(ensureOrganizationStripeCustomer(owner)).rejects.toMatchObject({
      name: "ServiceError",
      code: "CONFLICT",
    });
  });

  it("müşteri oluşturma audit log üretir ve sır yazmaz", async () => {
    setStripeGatewayForTests(createFakeStripeGateway().gateway);
    const { owner, organizationId } = await createOwnerOrg();
    await ensureOrganizationStripeCustomer(owner);

    const log = await db.auditLog.findFirst({
      where: { organizationId, action: "billing.stripe_customer.create" },
    });
    expect(log).not.toBeNull();
    expect(log!.actorId).toBe(owner.id);
    expect(JSON.stringify(log!.afterJson)).not.toContain("sk_test");
  });
});

describe("YF-808 — ortam ayrımı kalıcı eşlemede de geçerlidir", () => {
  it("TEST ortamında oluşan müşteri LIVE ortamında yeniden KULLANILMAZ", async () => {
    const { owner, organizationId } = await createOwnerOrg();

    setStripeEnv({ STRIPE_SECRET_KEY: TEST_SECRET_KEY });
    setStripeGatewayForTests(createFakeStripeGateway("TEST").gateway);
    const testMapping = await ensureOrganizationStripeCustomer(owner);
    expect(testMapping.environment).toBe("TEST");

    setStripeEnv({ STRIPE_SECRET_KEY: LIVE_SECRET_KEY });
    setStripeGatewayForTests(createFakeStripeGateway("LIVE").gateway);
    const liveMapping = await ensureOrganizationStripeCustomer(owner);

    expect(liveMapping.environment).toBe("LIVE");
    expect(liveMapping.created).toBe(true);
    expect(liveMapping.stripeCustomerId).not.toBe(testMapping.stripeCustomerId);

    const rows = await db.organizationStripeCustomer.findMany({ where: { organizationId } });
    expect(rows.map((r) => r.environment).sort()).toEqual(["LIVE", "TEST"]);

    // LIVE yapılandırmasındayken TEST eşlemesi hiçbir okumada görünmez.
    const visible = await getOrganizationStripeCustomer(owner);
    expect(visible!.environment).toBe("LIVE");
  });

  it("Stripe yapılandırılmamışsa eşleme işlemleri fail-closed reddedilir", async () => {
    const { owner } = await createOwnerOrg();
    clearStripeEnv();
    await expect(ensureOrganizationStripeCustomer(owner)).rejects.toBeInstanceOf(BillingConfigError);
    await expect(getOrganizationStripeCustomer(owner)).rejects.toBeInstanceOf(BillingConfigError);
  });
});

describe("YF-808 — tenant izolasyonu ve rol yetkisi", () => {
  it("A organizasyonu B'nin Stripe eşlemesine erişemez", async () => {
    setStripeGatewayForTests(createFakeStripeGateway().gateway);
    const a = await createOwnerOrg();
    const b = await createOwnerOrg();

    const mappingA = await ensureOrganizationStripeCustomer(a.owner);
    const mappingB = await ensureOrganizationStripeCustomer(b.owner);
    expect(mappingA.stripeCustomerId).not.toBe(mappingB.stripeCustomerId);

    const seenByA = await getOrganizationStripeCustomer(a.owner);
    const seenByB = await getOrganizationStripeCustomer(b.owner);
    expect(seenByA!.stripeCustomerId).toBe(mappingA.stripeCustomerId);
    expect(seenByB!.stripeCustomerId).toBe(mappingB.stripeCustomerId);
    expect(seenByA!.organizationId).toBe(a.organizationId);
    expect(seenByB!.organizationId).toBe(b.organizationId);
  });

  it("aynı Stripe müşterisi iki organizasyona bağlanamaz (DB düzeyinde imkânsız)", async () => {
    const a = await createOwnerOrg();
    const b = await createOwnerOrg();
    await db.organizationStripeCustomer.create({
      data: {
        organizationId: a.organizationId,
        environment: "TEST",
        stripeCustomerId: "cus_shared_fake",
        idempotencyKey: buildCustomerIdempotencyKey(a.organizationId, "TEST"),
      },
    });

    await expect(
      db.organizationStripeCustomer.create({
        data: {
          organizationId: b.organizationId,
          environment: "TEST",
          stripeCustomerId: "cus_shared_fake",
          idempotencyKey: buildCustomerIdempotencyKey(b.organizationId, "TEST"),
        },
      }),
    ).rejects.toMatchObject({ code: "P2002" });
  });

  it("servis fonksiyonları istemciden organizationId/Stripe kimliği KABUL ETMEZ", () => {
    // İmza yalnızca oturum kullanıcısını alır — istemci girdisi için hiçbir
    // parametre yoktur (yapısal kanıt).
    expect(ensureOrganizationStripeCustomer.length).toBe(1);
    expect(getOrganizationStripeCustomer.length).toBe(1);
  });

  it("OWNER dışındaki roller müşteri oluşturamaz; FINANCE/PM okuyamaz", async () => {
    setStripeGatewayForTests(createFakeStripeGateway().gateway);
    const { owner, organizationId } = await createOwnerOrg();
    const admin = await createOrgUser(organizationId, "ADMIN");
    const finance = await createOrgUser(organizationId, "FINANCE");
    const pm = await createOrgUser(organizationId, "PROJECT_MANAGER");

    await expect(ensureOrganizationStripeCustomer(admin)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(ensureOrganizationStripeCustomer(finance)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(getOrganizationStripeCustomer(finance)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(getOrganizationStripeCustomer(pm)).rejects.toMatchObject({ code: "FORBIDDEN" });

    await ensureOrganizationStripeCustomer(owner);
    // ADMIN salt-okunur erişebilir.
    await expect(getOrganizationStripeCustomer(admin)).resolves.not.toBeNull();
  });
});

describe("YF-808 — sağlayıcı hataları kontrollü servis hatalarına çevrilir", () => {
  it("gateway hatası ham Stripe hatası olarak DEĞİL, BillingProviderError olarak yüzeye çıkar", async () => {
    setStripeGatewayForTests({
      environment: "TEST",
      async createCustomer() {
        throw new BillingProviderError(
          "Ödeme sağlayıcısı kimlik doğrulaması başarısız oldu (yapılandırma hatası).",
          "AUTH_CONFIG",
          "api_key_expired",
        );
      },
      async retrieveCustomer() {
        return null;
      },
      createCheckoutSession: unusedCreateCheckoutSession,
      createAddonCheckoutSession: unusedCreateAddonCheckoutSession,
      retrieveCheckoutSessionForAddon: unusedRetrieveCheckoutSessionForAddon,
      retrieveSubscription: unusedRetrieveSubscription,
      listSubscriptionsForCustomer: unusedListSubscriptionsForCustomer,
      retrieveRefund: unusedRetrieveRefund,
      retrieveCharge: unusedRetrieveCharge,
      retrieveDispute: unusedRetrieveDispute,
      constructWebhookEvent: unusedConstructWebhookEvent,
    });
    const { owner } = await createOwnerOrg();

    const err = await ensureOrganizationStripeCustomer(owner).catch((e) => e);
    expect(err).toBeInstanceOf(BillingProviderError);
    expect(err).not.toBeInstanceOf(Stripe.errors.StripeError);
    expect(err.category).toBe("AUTH_CONFIG");
    expect(err.message).not.toMatch(/sk_(test|live)/);
  });

  it("ham Stripe SDK hataları kategorize edilir ve ham mesaj taşınmaz", () => {
    const authErr = new Stripe.errors.StripeAuthenticationError({
      type: "invalid_request_error",
      message: `Invalid API Key provided: ${TEST_SECRET_KEY}`,
      code: "api_key_expired",
    });
    const translatedAuth = toBillingProviderError(authErr);
    expect(translatedAuth).toBeInstanceOf(BillingProviderError);
    expect(translatedAuth.category).toBe("AUTH_CONFIG");
    expect(translatedAuth.providerCode).toBe("api_key_expired");
    expect(translatedAuth.message).not.toContain(TEST_SECRET_KEY);
    expect(translatedAuth.message).not.toContain("Invalid API Key provided");

    const rateErr = new Stripe.errors.StripeRateLimitError({ type: "rate_limit_error", message: "too many" });
    expect(toBillingProviderError(rateErr).category).toBe("RATE_LIMIT");

    const invalidErr = new Stripe.errors.StripeInvalidRequestError({
      type: "invalid_request_error",
      message: "No such price",
      code: "resource_missing",
    });
    expect(toBillingProviderError(invalidErr).category).toBe("VALIDATION");

    // Stripe kaynaklı olmayan hatalar da sızmaz.
    const unknown = toBillingProviderError(new Error(`beklenmeyen ${TEST_SECRET_KEY}`));
    expect(unknown.category).toBe("UNKNOWN");
    expect(unknown.message).not.toContain(TEST_SECRET_KEY);
  });
});

describe("YF-808 — entitlement otoritesi YapiFin Plan modelinde kalır (YF-802 ayrımı)", () => {
  it("(a) Stripe eşlemesi oluşturmak HİÇBİR yetenek/limit KAZANDIRMAZ", async () => {
    setStripeGatewayForTests(createFakeStripeGateway().gateway);
    const { owner, organizationId } = await createOwnerOrg();
    await setOrganizationPlan(organizationId, "STARTER");

    const before = {
      plan: await getEffectivePlan(db, organizationId),
      ocr: await canUseCapability(db, organizationId, "ocr"),
      ai: await canUseCapability(db, organizationId, "ai.features"),
      users: await checkLimit(db, organizationId, "users.active"),
      planId: (await db.organization.findUniqueOrThrow({ where: { id: organizationId } })).planId,
    };
    expect(before.ocr).toBe(false);

    await ensureOrganizationStripeCustomer(owner);

    expect((await getEffectivePlan(db, organizationId)).code).toBe(before.plan.code);
    expect(await canUseCapability(db, organizationId, "ocr")).toBe(false);
    expect(await canUseCapability(db, organizationId, "ai.features")).toBe(false);
    expect((await checkLimit(db, organizationId, "users.active")).max).toBe(before.users.max);
    // Stripe eşlemesi Organization.planId'ye ASLA dokunmaz.
    expect((await db.organization.findUniqueOrThrow({ where: { id: organizationId } })).planId).toBe(
      before.planId,
    );
  });

  it("(b) entitlement çözümlemesi YALNIZCA Plan modelinden okur", async () => {
    setStripeGatewayForTests(createFakeStripeGateway().gateway);
    const { owner, organizationId } = await createOwnerOrg();
    await setOrganizationPlan(organizationId, "STARTER");
    await ensureOrganizationStripeCustomer(owner);

    expect(await canUseCapability(db, organizationId, "ocr")).toBe(false);

    // Stripe tarafında ne değişirse değişsin entitlement DEĞİŞMEZ...
    setStripeEnv({ STRIPE_PRICE_STARTER_MONTHLY: "price_FAKEenterpriseLookalike" });
    await db.organizationStripeCustomer.updateMany({
      where: { organizationId },
      data: { stripeCustomerId: "cus_enterprise_lookalike" },
    });
    expect(await canUseCapability(db, organizationId, "ocr")).toBe(false);
    expect((await getEffectivePlan(db, organizationId)).code).toBe("STARTER");

    // ...ama YapiFin Plan kaydı değişince ANINDA değişir (tek otorite budur).
    const richPlan = await createTestPlan({ capabilities: { ocr: true }, limits: { "users.active": 99 } });
    await db.organization.update({ where: { id: organizationId }, data: { planId: richPlan.id } });
    expect(await canUseCapability(db, organizationId, "ocr")).toBe(true);
    expect((await checkLimit(db, organizationId, "users.active")).max).toBe(99);
  });

  it("(c) uydurma Stripe Product/Price/metadata entitlement kontrolünü BYPASS EDEMEZ", async () => {
    // Gateway, Stripe müşterisini "ENTERPRISE" iddiasıyla dönen sahte
    // metadata ile oluşturuyormuş gibi davranıyor.
    const claimingGateway: StripeGateway = {
      environment: "TEST",
      async createCustomer() {
        return { id: "cus_claims_enterprise_plan" };
      },
      async retrieveCustomer() {
        return { id: "cus_claims_enterprise_plan" };
      },
      createCheckoutSession: unusedCreateCheckoutSession,
      createAddonCheckoutSession: unusedCreateAddonCheckoutSession,
      retrieveCheckoutSessionForAddon: unusedRetrieveCheckoutSessionForAddon,
      retrieveSubscription: unusedRetrieveSubscription,
      listSubscriptionsForCustomer: unusedListSubscriptionsForCustomer,
      retrieveRefund: unusedRetrieveRefund,
      retrieveCharge: unusedRetrieveCharge,
      retrieveDispute: unusedRetrieveDispute,
      constructWebhookEvent: unusedConstructWebhookEvent,
    };
    setStripeGatewayForTests(claimingGateway);

    const { owner, organizationId } = await createOwnerOrg();
    await setOrganizationPlan(organizationId, "STARTER");
    await ensureOrganizationStripeCustomer(owner);

    // Saklanan Stripe kimliği doğrudan "kurcalansa" bile:
    await db.organizationStripeCustomer.updateMany({
      where: { organizationId },
      data: {
        stripeCustomerId: "cus_ENTERPRISE_ALL_ACCESS",
        idempotencyKey: "yapifin:test:customer:FORGED",
      },
    });
    // ...ve tüm plan fiyatları Enterprise'a yönlendirilse bile:
    setStripeEnv({
      STRIPE_PRICE_STARTER_MONTHLY: "price_FAKEenterprise001",
      STRIPE_PRICE_ENTERPRISE: "price_FAKEenterprise001",
    });

    expect((await getEffectivePlan(db, organizationId)).code).toBe("STARTER");
    for (const capability of ["ocr", "bank_import", "e_document", "ai.features", "reports.advanced"] as const) {
      expect(await canUseCapability(db, organizationId, capability)).toBe(false);
    }
    expect((await checkLimit(db, organizationId, "projects.active")).max).toBe(5);
  });

  it("eşleme tablosunda plan/yetenek/limit taşıyan HİÇBİR sütun yoktur (yapısal ayrım)", async () => {
    const columns = await db.$queryRaw<{ column_name: string }[]>`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'OrganizationStripeCustomer'
    `;
    const names = columns.map((c) => c.column_name).sort();
    expect(names).toEqual([
      "createdAt",
      "createdById",
      "environment",
      "id",
      "idempotencyKey",
      "organizationId",
      "stripeCustomerId",
      "updatedAt",
    ]);
    for (const forbidden of ["planId", "plan", "capabilities", "limits", "priceId", "productId"]) {
      expect(names).not.toContain(forbidden);
    }
  });

  it("entitlement servisi Stripe modüllerine bağımlı DEĞİLDİR (tek yönlü bağımlılık)", async () => {
    const { readFile } = await import("node:fs/promises");
    for (const file of ["lib/entitlements/entitlement-service.ts", "lib/entitlements/capabilities.ts"]) {
      const source = await readFile(new URL(`../${file}`, import.meta.url), "utf8");
      expect(source.toLowerCase(), `${file} Stripe'a bağımlı olmamalı`).not.toContain("stripe");
      expect(source.toLowerCase()).not.toContain("billing");
    }
  });

  it("ServiceError sözleşmesi korunur (yetki hataları kullanıcıya gösterilebilir Türkçe hatadır)", async () => {
    setStripeGatewayForTests(createFakeStripeGateway().gateway);
    const { organizationId } = await createOwnerOrg();
    const finance = await createOrgUser(organizationId, "FINANCE");
    const err = await ensureOrganizationStripeCustomer(finance).catch((e) => e);
    expect(err).toBeInstanceOf(ServiceError);
    expect(err.code).toBe("FORBIDDEN");
  });
});
