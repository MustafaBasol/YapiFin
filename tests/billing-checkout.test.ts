import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { cleanDatabase, createDeferredStripeGateway, createFakeStripeGateway, createOrgUser, createOwnerOrg, waitFor } from "./helpers";
import { resetEnvCacheForTests } from "@/lib/env";
import { resetStripeConfigCacheForTests } from "@/lib/billing/stripe-config";
import { resetStripeGatewayForTests, setStripeGatewayForTests, type StripeGateway } from "@/lib/billing/stripe-gateway";
import { BillingConfigError, BillingProviderError } from "@/lib/billing/errors";
import {
  buildCheckoutIdempotencyKey,
  createPlanCheckoutSession,
} from "@/server/services/billing/checkout-service";
import { ServiceError } from "@/server/services/errors";
import { getEffectivePlan } from "@/lib/entitlements/entitlement-service";

/**
 * YF-809 — Stripe Checkout başlatma servisinin (server/services/billing/checkout-service.ts)
 * yetki, tenant izolasyonu, kanonik fiyat çözümlemesi, mükerrer deneme
 * koruması, idempotency ve entitlement-etkisizliği testleri.
 *
 * Gerçek Stripe kimlik bilgisi GEREKMEZ: `setStripeGatewayForTests` ile
 * deterministik bir sahte gateway (bkz. tests/helpers.ts createFakeStripeGateway)
 * takılır, hiçbir ağ çağrısı yapılmaz.
 */

function fakeSecretKey(mode: "test" | "live"): string {
  return ["sk", mode, "0000000000000000000000FAKE"].join("_");
}

const TEST_SECRET_KEY = fakeSecretKey("test");
const LIVE_SECRET_KEY = fakeSecretKey("live");

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

describe("YF-809 — geçerli istekte Checkout Session oluşturma", () => {
  it("OWNER geçerli plan+aralık için Checkout Session oluşturur ve barındırmalı URL döner", async () => {
    const fake = createFakeStripeGateway();
    setStripeGatewayForTests(fake.gateway);
    const { owner, organizationId } = await createOwnerOrg();

    const result = await createPlanCheckoutSession(owner, { planCode: "PROFESSIONAL", billingInterval: "MONTHLY" });

    expect(result.checkoutUrl).toContain("checkout.stripe");
    expect(fake.checkoutCalls).toHaveLength(1);

    const row = await db.organizationCheckoutAttempt.findUnique({ where: { organizationId } });
    expect(row).not.toBeNull();
    expect(row!.planCode).toBe("PROFESSIONAL");
    expect(row!.billingInterval).toBe("MONTHLY");
    expect(row!.environment).toBe("TEST");

    const log = await db.auditLog.findFirst({ where: { organizationId, action: "billing.checkout.create" } });
    expect(log).not.toBeNull();
    expect(log!.actorId).toBe(owner.id);
  });

  it("doğru kanonik Stripe fiyatı sunucu tarafında seçilir (aylık/yıllık BAĞIMSIZ)", async () => {
    const fake = createFakeStripeGateway();
    setStripeGatewayForTests(fake.gateway);
    const { owner: monthlyOwner } = await createOwnerOrg();
    const { owner: annualOwner } = await createOwnerOrg();

    await createPlanCheckoutSession(monthlyOwner, { planCode: "BUSINESS", billingInterval: "MONTHLY" });
    await createPlanCheckoutSession(annualOwner, { planCode: "BUSINESS", billingInterval: "ANNUAL" });

    expect(fake.checkoutCalls[0].priceId).toBe("price_FAKEbusinessM001");
    expect(fake.checkoutCalls[1].priceId).toBe("price_FAKEbusinessA001");
  });
});

describe("YF-809 — yetki (yalnızca OWNER)", () => {
  it("ADMIN/FINANCE/PROJECT_MANAGER ödeme başlatamaz", async () => {
    setStripeGatewayForTests(createFakeStripeGateway().gateway);
    const { organizationId } = await createOwnerOrg();
    const admin = await createOrgUser(organizationId, "ADMIN");
    const finance = await createOrgUser(organizationId, "FINANCE");
    const pm = await createOrgUser(organizationId, "PROJECT_MANAGER");

    for (const actor of [admin, finance, pm]) {
      await expect(
        createPlanCheckoutSession(actor, { planCode: "STARTER", billingInterval: "MONTHLY" }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
    }
  });

  it("servis imzası istemciden organizationId/Stripe kimliği KABUL ETMEZ (yalnızca actor + planCode/billingInterval)", () => {
    expect(createPlanCheckoutSession.length).toBe(2);
  });
});

describe("YF-809 — girdi doğrulama", () => {
  it("geçersiz plan kodu reddedilir", async () => {
    setStripeGatewayForTests(createFakeStripeGateway().gateway);
    const { owner } = await createOwnerOrg();
    await expect(
      createPlanCheckoutSession(owner, { planCode: "PLATINUM", billingInterval: "MONTHLY" }),
    ).rejects.toBeInstanceOf(ServiceError);
  });

  it("geçersiz faturalama aralığı reddedilir", async () => {
    setStripeGatewayForTests(createFakeStripeGateway().gateway);
    const { owner } = await createOwnerOrg();
    const invalidInterval = { planCode: "STARTER", billingInterval: "WEEKLY" } as unknown as Parameters<
      typeof createPlanCheckoutSession
    >[1];
    await expect(createPlanCheckoutSession(owner, invalidInterval)).rejects.toBeInstanceOf(ServiceError);
  });

  it("Enterprise/contact-sales için self-servis Checkout OLUŞTURULMAZ", async () => {
    const fake = createFakeStripeGateway();
    setStripeGatewayForTests(fake.gateway);
    const { owner } = await createOwnerOrg();

    await expect(
      createPlanCheckoutSession(owner, { planCode: "ENTERPRISE", billingInterval: "MONTHLY" }),
    ).rejects.toBeInstanceOf(ServiceError);
    // Stripe'a hiç gidilmedi.
    expect(fake.checkoutCalls).toHaveLength(0);
  });

  it("istemciden gelen fazladan alanlar (uydurma price/customer/tutar) Checkout'u ETKİLEMEZ", async () => {
    const fake = createFakeStripeGateway();
    setStripeGatewayForTests(fake.gateway);
    const { owner } = await createOwnerOrg();

    // Tip sözleşmesinde bu ekstra alanlar YOK; kurcalanmış bir çağrıyı simüle
    // etmek için tek bir `as unknown as` ile tip kontrolü bilinçli olarak
    // bypass edilir (satır bazlı `@ts-expect-error` yerine — derleyici
    // sürümüne göre "fazla özellik" tanılarının satır eşlemesi değişebilir).
    const tamperedInput = {
      planCode: "STARTER",
      billingInterval: "MONTHLY",
      priceId: "price_evil_injected",
      stripeCustomerId: "cus_evil_injected",
      amount: 1,
    } as unknown as Parameters<typeof createPlanCheckoutSession>[1];
    await createPlanCheckoutSession(owner, tamperedInput);

    expect(fake.checkoutCalls[0].priceId).toBe("price_FAKEstarterM001");
    expect(fake.checkoutCalls[0].customerId).not.toBe("cus_evil_injected");
  });

  it("yapılandırılmamış plan/aralık fiyatı fail-closed reddedilir (BillingConfigError)", async () => {
    setStripeGatewayForTests(createFakeStripeGateway().gateway);
    // Yıllık BUSINESS kasıtlı olarak yapılandırılmadı.
    setStripeEnv({ STRIPE_PRICE_BUSINESS_ANNUAL: undefined });
    const { owner } = await createOwnerOrg();

    await expect(
      createPlanCheckoutSession(owner, { planCode: "BUSINESS", billingInterval: "ANNUAL" }),
    ).rejects.toBeInstanceOf(BillingConfigError);
  });
});

describe("YF-809 — tenant izolasyonu", () => {
  it("A organizasyonunun denemesi B'yi ETKİLEMEZ; farklı organizasyonlar bağımsız çalışır", async () => {
    const fake = createFakeStripeGateway();
    setStripeGatewayForTests(fake.gateway);
    const a = await createOwnerOrg();
    const b = await createOwnerOrg();

    await createPlanCheckoutSession(a.owner, { planCode: "STARTER", billingInterval: "MONTHLY" });
    await createPlanCheckoutSession(b.owner, { planCode: "PROFESSIONAL", billingInterval: "ANNUAL" });

    const rowA = await db.organizationCheckoutAttempt.findUnique({ where: { organizationId: a.organizationId } });
    const rowB = await db.organizationCheckoutAttempt.findUnique({ where: { organizationId: b.organizationId } });
    expect(rowA!.planCode).toBe("STARTER");
    expect(rowB!.planCode).toBe("PROFESSIONAL");
  });
});

describe("YF-809 — mükerrer deneme koruması ve idempotency", () => {
  it("aynı organizasyon FARKLI bir plan için açık deneme varken CONFLICT ile reddedilir", async () => {
    setStripeGatewayForTests(createFakeStripeGateway().gateway);
    const { owner, organizationId } = await createOwnerOrg();

    await createPlanCheckoutSession(owner, { planCode: "STARTER", billingInterval: "MONTHLY" });
    await expect(
      createPlanCheckoutSession(owner, { planCode: "PROFESSIONAL", billingInterval: "MONTHLY" }),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    const rows = await db.organizationCheckoutAttempt.findMany({ where: { organizationId } });
    expect(rows).toHaveLength(1);
    expect(rows[0].planCode).toBe("STARTER");
  });

  it("idempotency anahtarı deterministik ve organizasyon+ortam+plan+aralık bazlıdır", async () => {
    const { organizationId } = await createOwnerOrg();
    const key = buildCheckoutIdempotencyKey(organizationId, "TEST", "STARTER", "MONTHLY");
    expect(key).toBe(buildCheckoutIdempotencyKey(organizationId, "TEST", "STARTER", "MONTHLY"));
    expect(key).not.toBe(buildCheckoutIdempotencyKey(organizationId, "TEST", "STARTER", "ANNUAL"));
    expect(key).not.toBe(buildCheckoutIdempotencyKey(organizationId, "LIVE", "STARTER", "MONTHLY"));
    expect(key).not.toBe(buildCheckoutIdempotencyKey(organizationId, "TEST", "PROFESSIONAL", "MONTHLY"));
  });

  it("hızlı çift tıklama (AYNI plan+aralık, eşzamanlı) TEK Stripe Checkout Session üretir, aynı URL döner", async () => {
    const fake = createFakeStripeGateway();
    setStripeGatewayForTests(fake.gateway);
    const { owner, organizationId } = await createOwnerOrg();

    const results = await Promise.all([
      createPlanCheckoutSession(owner, { planCode: "STARTER", billingInterval: "MONTHLY" }),
      createPlanCheckoutSession(owner, { planCode: "STARTER", billingInterval: "MONTHLY" }),
      createPlanCheckoutSession(owner, { planCode: "STARTER", billingInterval: "MONTHLY" }),
    ]);

    const urls = new Set(results.map((r) => r.checkoutUrl));
    expect(urls.size).toBe(1);
    expect(fake.distinctCheckoutSessionCount).toBe(1);

    const rows = await db.organizationCheckoutAttempt.findMany({ where: { organizationId } });
    expect(rows).toHaveLength(1);
  });

  it("süresi dolmuş deneme, FARKLI bir plan için yeni bir denemeyle yerini bırakır", async () => {
    setStripeGatewayForTests(createFakeStripeGateway().gateway);
    const { owner, organizationId } = await createOwnerOrg();

    await createPlanCheckoutSession(owner, { planCode: "STARTER", billingInterval: "MONTHLY" });
    await db.organizationCheckoutAttempt.update({
      where: { organizationId },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });

    await createPlanCheckoutSession(owner, { planCode: "BUSINESS", billingInterval: "ANNUAL" });

    const row = await db.organizationCheckoutAttempt.findUnique({ where: { organizationId } });
    expect(row!.planCode).toBe("BUSINESS");
    expect(row!.billingInterval).toBe("ANNUAL");
  });
});

describe("YF-809 — ortam ayrımı (test ↔ live) kalıcı deneme kaydında da güvenlidir", () => {
  it("TEST ortamında oluşan açık deneme LIVE ortamındaki YENİ bir denemeyi ENGELLEMEZ", async () => {
    const { owner, organizationId } = await createOwnerOrg();

    setStripeEnv({ STRIPE_SECRET_KEY: TEST_SECRET_KEY });
    setStripeGatewayForTests(createFakeStripeGateway("TEST").gateway);
    await createPlanCheckoutSession(owner, { planCode: "STARTER", billingInterval: "MONTHLY" });

    setStripeEnv({ STRIPE_SECRET_KEY: LIVE_SECRET_KEY });
    setStripeGatewayForTests(createFakeStripeGateway("LIVE").gateway);
    // Farklı bir plan olmasına rağmen (STARTER != PROFESSIONAL) TEST'teki
    // BAYAT kayıt farklı bir Stripe ortamına ait olduğu için ENGEL OLMAZ.
    await createPlanCheckoutSession(owner, { planCode: "PROFESSIONAL", billingInterval: "ANNUAL" });

    const row = await db.organizationCheckoutAttempt.findUnique({ where: { organizationId } });
    expect(row!.environment).toBe("LIVE");
    expect(row!.planCode).toBe("PROFESSIONAL");
  });
});

describe("YF-809 — sağlayıcı hataları kontrollü hatalara çevrilir", () => {
  it("gateway hatası ham Stripe hatası olarak DEĞİL, BillingProviderError olarak yüzeye çıkar; hiçbir deneme kaydı OLUŞMAZ", async () => {
    const failingGateway: StripeGateway = {
      environment: "TEST",
      async createCustomer(params) {
        return { id: `cus_${params.organizationId}` };
      },
      async retrieveCustomer(customerId) {
        return { id: customerId };
      },
      async createCheckoutSession() {
        throw new BillingProviderError("Ödeme sağlayıcısı geçici bir hata döndürdü.", "TEMPORARY_PROVIDER");
      },
      async createAddonCheckoutSession() {
        throw new Error("bu testte kullanılmamalıydı");
      },
      async retrieveCheckoutSessionForAddon() {
        return null;
      },
      async retrieveSubscription() {
        return null;
      },
      async listSubscriptionsForCustomer() {
        return [];
      },
      constructWebhookEvent() {
        throw new Error("bu testte kullanılmamalıydı");
      },
    };
    setStripeGatewayForTests(failingGateway);
    const { owner, organizationId } = await createOwnerOrg();

    const err = await createPlanCheckoutSession(owner, { planCode: "STARTER", billingInterval: "MONTHLY" }).catch(
      (e) => e,
    );
    expect(err).toBeInstanceOf(BillingProviderError);
    expect(err.category).toBe("TEMPORARY_PROVIDER");

    const row = await db.organizationCheckoutAttempt.findUnique({ where: { organizationId } });
    expect(row).toBeNull();
  });
});

describe("YF-809 — Checkout başlatmak hiçbir plan/entitlement mutasyonu YAPMAZ", () => {
  it("Checkout Session oluşturmak Organization.planId'ye DOKUNMAZ, entitlement DEĞİŞMEZ", async () => {
    setStripeGatewayForTests(createFakeStripeGateway().gateway);
    const { owner, organizationId } = await createOwnerOrg();

    const before = {
      plan: await getEffectivePlan(db, organizationId),
      planId: (await db.organization.findUniqueOrThrow({ where: { id: organizationId } })).planId,
    };

    await createPlanCheckoutSession(owner, { planCode: "BUSINESS", billingInterval: "ANNUAL" });

    const after = await db.organization.findUniqueOrThrow({ where: { id: organizationId } });
    expect(after.planId).toBe(before.planId);
    expect((await getEffectivePlan(db, organizationId)).code).toBe(before.plan.code);
  });
});

describe("YF-809 hotfix — çapraz-plan checkout yarışı (atomik rezervasyon)", () => {
  it("A rezervasyonu tamamlayıp gateway içinde bloklanmışken, FARKLI plan için eşzamanlı B isteği Stripe'a HİÇ gitmeden reddedilir; A serbest bırakılınca başarıyla tamamlanır", async () => {
    const deferred = createDeferredStripeGateway();
    setStripeGatewayForTests(deferred.gateway);
    const { owner, organizationId } = await createOwnerOrg();

    // 1) A: rezervasyonu (DB) tamamlar, gateway çağrısı içinde bloklanır.
    const aPromise = createPlanCheckoutSession(owner, { planCode: "STARTER", billingInterval: "MONTHLY" });
    await waitFor(() => deferred.checkoutCalls.length === 1);

    const reservedRow = await db.organizationCheckoutAttempt.findUnique({ where: { organizationId } });
    expect(reservedRow!.status).toBe("RESERVED");
    expect(reservedRow!.planCode).toBe("STARTER");

    // 2) B: FARKLI plan/aralık, A hâlâ gateway içindeyken başlar.
    // 3) B, gateway'e HİÇ gitmeden (checkoutCalls artmadan) reddedilmelidir.
    await expect(
      createPlanCheckoutSession(owner, { planCode: "PROFESSIONAL", billingInterval: "MONTHLY" }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(deferred.checkoutCalls).toHaveLength(1);
    expect(deferred.pendingCount).toBe(1);

    // 4) A serbest bırakılınca başarıyla tamamlanır.
    deferred.resolveNext();
    const result = await aPromise;
    expect(result.checkoutUrl).toContain("checkout.stripe");

    const finalRow = await db.organizationCheckoutAttempt.findUnique({ where: { organizationId } });
    expect(finalRow!.status).toBe("COMPLETED");
    expect(finalRow!.planCode).toBe("STARTER");
  });

  it("henüz Stripe'a gitmemiş (RESERVED, süresi dolmamış) bir rezervasyon da FARKLI plan için Stripe'a gitmeden reddeder", async () => {
    const { owner, organizationId } = await createOwnerOrg();
    await db.organizationCheckoutAttempt.create({
      data: {
        organizationId,
        environment: "TEST",
        planCode: "STARTER",
        billingInterval: "MONTHLY",
        status: "RESERVED",
        stripeCustomerId: "cus_fake_inflight",
        idempotencyKey: buildCheckoutIdempotencyKey(organizationId, "TEST", "STARTER", "MONTHLY"),
        attemptCount: 1,
        reservationExpiresAt: new Date(Date.now() + 60_000),
      },
    });

    const fake = createFakeStripeGateway();
    setStripeGatewayForTests(fake.gateway);
    await expect(
      createPlanCheckoutSession(owner, { planCode: "PROFESSIONAL", billingInterval: "ANNUAL" }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(fake.checkoutCalls).toHaveLength(0);
  });

  it("aynı organizasyon AYNI plan için eşzamanlı istekte (hızlı çift tıklama) hâlâ TEK Stripe Checkout Session üretir (regresyon)", async () => {
    const fake = createFakeStripeGateway();
    setStripeGatewayForTests(fake.gateway);
    const { owner, organizationId } = await createOwnerOrg();

    const results = await Promise.all([
      createPlanCheckoutSession(owner, { planCode: "STARTER", billingInterval: "MONTHLY" }),
      createPlanCheckoutSession(owner, { planCode: "STARTER", billingInterval: "MONTHLY" }),
      createPlanCheckoutSession(owner, { planCode: "STARTER", billingInterval: "MONTHLY" }),
    ]);

    const urls = new Set(results.map((r) => r.checkoutUrl));
    expect(urls.size).toBe(1);
    expect(fake.distinctCheckoutSessionCount).toBe(1);

    const rows = await db.organizationCheckoutAttempt.findMany({ where: { organizationId } });
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("COMPLETED");
  });

  it("sağlayıcı hatası rezervasyonu HEMEN serbest bırakır; ardından FARKLI bir plan için istek gecikmeden başarılı olur", async () => {
    const deferred = createDeferredStripeGateway();
    setStripeGatewayForTests(deferred.gateway);
    const { owner, organizationId } = await createOwnerOrg();

    const aPromise = createPlanCheckoutSession(owner, { planCode: "STARTER", billingInterval: "MONTHLY" });
    await waitFor(() => deferred.checkoutCalls.length === 1);

    deferred.rejectNext(new BillingProviderError("Ödeme sağlayıcısı geçici bir hata döndürdü.", "TEMPORARY_PROVIDER"));
    await expect(aPromise).rejects.toBeInstanceOf(BillingProviderError);

    const rowAfterFailure = await db.organizationCheckoutAttempt.findUnique({ where: { organizationId } });
    expect(rowAfterFailure).toBeNull();

    // TTL'i beklemeye GEREK yok — serbest bırakma anındadır, FARKLI bir plan
    // dahi hemen geçebilmelidir.
    const fake = createFakeStripeGateway();
    setStripeGatewayForTests(fake.gateway);
    const result = await createPlanCheckoutSession(owner, { planCode: "PROFESSIONAL", billingInterval: "ANNUAL" });
    expect(result.checkoutUrl).toContain("checkout.stripe");

    const row = await db.organizationCheckoutAttempt.findUnique({ where: { organizationId } });
    expect(row!.planCode).toBe("PROFESSIONAL");
    expect(row!.status).toBe("COMPLETED");
  });

  it("bayat (TTL dolmuş) RESERVED rezervasyon — çökmüş bir sürecin izi — güvenle ve deterministik biçimde devralınır", async () => {
    const { owner, organizationId } = await createOwnerOrg();

    // Rezervasyonu yapıp Stripe yanıtı gelmeden ÇÖKMÜŞ bir süreci simüle eder:
    // satır RESERVED kalmıştır ve reservationExpiresAt ÇOKTAN geçmiştir.
    await db.organizationCheckoutAttempt.create({
      data: {
        organizationId,
        environment: "TEST",
        planCode: "STARTER",
        billingInterval: "MONTHLY",
        status: "RESERVED",
        stripeCustomerId: "cus_fake_crashed",
        idempotencyKey: buildCheckoutIdempotencyKey(organizationId, "TEST", "STARTER", "MONTHLY"),
        attemptCount: 1,
        reservationExpiresAt: new Date(Date.now() - 1000),
      },
    });

    const fake = createFakeStripeGateway();
    setStripeGatewayForTests(fake.gateway);
    const result = await createPlanCheckoutSession(owner, { planCode: "PROFESSIONAL", billingInterval: "ANNUAL" });
    expect(result.checkoutUrl).toContain("checkout.stripe");

    const row = await db.organizationCheckoutAttempt.findUnique({ where: { organizationId } });
    expect(row!.planCode).toBe("PROFESSIONAL");
    expect(row!.billingInterval).toBe("ANNUAL");
    expect(row!.status).toBe("COMPLETED");
    expect(row!.attemptCount).toBe(2);
  });
});
