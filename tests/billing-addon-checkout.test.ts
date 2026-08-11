import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { cleanDatabase, createFakeStripeGateway, createOrgUser, createOwnerOrg } from "./helpers";
import { resetEnvCacheForTests } from "@/lib/env";
import { resetStripeConfigCacheForTests } from "@/lib/billing/stripe-config";
import { resetStripeGatewayForTests, setStripeGatewayForTests } from "@/lib/billing/stripe-gateway";
import { BillingConfigError } from "@/lib/billing/errors";
import {
  ADDON_CHECKOUT_IDEMPOTENCY_WINDOW_MS,
  buildAddonCheckoutIdempotencyKey,
  createAddonCheckoutSession,
} from "@/server/services/billing/addon-checkout-service";
import { ServiceError } from "@/server/services/errors";

/**
 * YF-813 — add-on (kullanım/ek-kota top-up) Checkout başlatma servisinin
 * (server/services/billing/addon-checkout-service.ts) yetki, katalog
 * çözümleme (istemciden yalnızca `addonKey`), idempotency ve
 * entitlement-etkisizliği testleri. `tests/billing-checkout.test.ts` (YF-809)
 * ile AYNI kalıp — gerçek Stripe kimlik bilgisi GEREKMEZ.
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
    STRIPE_PRICE_ADDON_AI_CREDITS: "price_FAKEaddonAiCredits001",
    STRIPE_PRICE_ADDON_OCR_DOCS: "price_FAKEaddonOcrDocs001",
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

describe("YF-813 — geçerli istekte add-on Checkout Session oluşturma", () => {
  it("OWNER geçerli addonKey (AI kredi paketi) için Checkout Session oluşturur", async () => {
    const fake = createFakeStripeGateway();
    setStripeGatewayForTests(fake.gateway);
    const { owner } = await createOwnerOrg();

    const result = await createAddonCheckoutSession(owner, { addonKey: "ai_credits_pack" });

    expect(result.checkoutUrl).toContain("checkout.stripe");
    expect(result.addonKey).toBe("ai_credits_pack");
    expect(fake.addonCheckoutCalls).toHaveLength(1);
    expect(fake.addonCheckoutCalls[0].priceId).toBe("price_FAKEaddonAiCredits001");
    expect(fake.addonCheckoutCalls[0].organizationId).toBeTruthy();
  });

  it("OWNER geçerli addonKey (OCR belge paketi) için Checkout Session oluşturur", async () => {
    const fake = createFakeStripeGateway();
    setStripeGatewayForTests(fake.gateway);
    const { owner } = await createOwnerOrg();

    const result = await createAddonCheckoutSession(owner, { addonKey: "ocr_documents_pack" });

    expect(result.checkoutUrl).toContain("checkout.stripe");
    expect(fake.addonCheckoutCalls[0].priceId).toBe("price_FAKEaddonOcrDocs001");
  });

  it("Checkout Session oluşturmak hiçbir kota mutasyonu YAPMAZ", async () => {
    const fake = createFakeStripeGateway();
    setStripeGatewayForTests(fake.gateway);
    const { owner, organizationId } = await createOwnerOrg();

    const before = await db.usageAddonGrant.count({ where: { organizationId } });
    await createAddonCheckoutSession(owner, { addonKey: "ai_credits_pack" });
    const after = await db.usageAddonGrant.count({ where: { organizationId } });

    expect(before).toBe(0);
    expect(after).toBe(0);
  });
});

describe("YF-813 — geçersiz add-on kataloğu / yapılandırma", () => {
  it("bilinmeyen addonKey BillingConfigError ile reddedilir, Stripe'a HİÇ gidilmez", async () => {
    const fake = createFakeStripeGateway();
    setStripeGatewayForTests(fake.gateway);
    const { owner } = await createOwnerOrg();

    await expect(createAddonCheckoutSession(owner, { addonKey: "not_a_real_addon" })).rejects.toThrow(
      BillingConfigError,
    );
    expect(fake.addonCheckoutCalls).toHaveLength(0);
  });

  it("yapılandırılmamış bir paket fiyatı (env eksik) fail-closed reddedilir", async () => {
    setStripeEnv({ STRIPE_PRICE_ADDON_AI_CREDITS: undefined });
    const fake = createFakeStripeGateway();
    setStripeGatewayForTests(fake.gateway);
    const { owner } = await createOwnerOrg();

    await expect(createAddonCheckoutSession(owner, { addonKey: "ai_credits_pack" })).rejects.toThrow(
      BillingConfigError,
    );
    expect(fake.addonCheckoutCalls).toHaveLength(0);
  });

  it("istemciden gelen fazladan alanlar (uydurma priceId/amount/resource) Checkout'u ETKİLEMEZ", async () => {
    const fake = createFakeStripeGateway();
    setStripeGatewayForTests(fake.gateway);
    const { owner } = await createOwnerOrg();

    // Tip sözleşmesini kurcalayan bir çağrı — servis imzası yalnızca
    // `addonKey` alır; ekstra alanlar (gerçek bir saldırganın form/istek
    // gövdesine ekleyebileceği alanlar) sessizce YOK SAYILIR.
    const tampered = {
      addonKey: "ai_credits_pack",
      priceId: "price_ATTACKER_INJECTED",
      amount: 999999,
      resource: "projects.active",
      organizationId: "org_other",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;

    const result = await createAddonCheckoutSession(owner, tampered);
    expect(fake.addonCheckoutCalls[0].priceId).toBe("price_FAKEaddonAiCredits001");
    expect(result.addonKey).toBe("ai_credits_pack");
  });
});

describe("YF-813 — yetki", () => {
  it("OWNER olmayan roller (ADMIN/FINANCE) reddedilir", async () => {
    const fake = createFakeStripeGateway();
    setStripeGatewayForTests(fake.gateway);
    const { organizationId } = await createOwnerOrg();
    const admin = await createOrgUser(organizationId, "ADMIN");
    const finance = await createOrgUser(organizationId, "FINANCE");

    await expect(createAddonCheckoutSession(admin, { addonKey: "ai_credits_pack" })).rejects.toThrow(ServiceError);
    await expect(createAddonCheckoutSession(finance, { addonKey: "ai_credits_pack" })).rejects.toThrow(ServiceError);
    expect(fake.addonCheckoutCalls).toHaveLength(0);
  });
});

describe("YF-813 — idempotency / eşzamanlılık", () => {
  it("aynı pencere içinde AYNI addonKey için tekrar çağrı Stripe'ta İKİNCİ bir Session OLUŞTURMAZ", async () => {
    const fake = createFakeStripeGateway();
    setStripeGatewayForTests(fake.gateway);
    const { owner } = await createOwnerOrg();

    const first = await createAddonCheckoutSession(owner, { addonKey: "ai_credits_pack" });
    const second = await createAddonCheckoutSession(owner, { addonKey: "ai_credits_pack" });

    expect(second.checkoutUrl).toBe(first.checkoutUrl);
    expect(fake.distinctAddonCheckoutSessionCount).toBe(1);
  });

  it("pencere sınırının ÖTESİNDE (farklı bucket) aynı addonKey için istek YENİ bir Session oluşturur — tekrar satın alma engellenmez", async () => {
    const { organizationId } = await createOwnerOrg();
    const t1 = Date.now();
    const t2 = t1 + ADDON_CHECKOUT_IDEMPOTENCY_WINDOW_MS + 1;

    const keyA = buildAddonCheckoutIdempotencyKey(organizationId, "TEST", "ai_credits_pack", t1);
    const keyB = buildAddonCheckoutIdempotencyKey(organizationId, "TEST", "ai_credits_pack", t2);

    expect(keyA).not.toBe(keyB);
  });

  it("FARKLI addonKey'ler için eşzamanlı satın almalar Stripe'ta AYRI Session'lar üretir (add-on'lar YF-809'un tek-açık-deneme kısıtına TABİ DEĞİLDİR)", async () => {
    const fake = createFakeStripeGateway();
    setStripeGatewayForTests(fake.gateway);
    const { owner } = await createOwnerOrg();

    const [ai, ocr] = await Promise.all([
      createAddonCheckoutSession(owner, { addonKey: "ai_credits_pack" }),
      createAddonCheckoutSession(owner, { addonKey: "ocr_documents_pack" }),
    ]);

    expect(ai.checkoutUrl).not.toBe(ocr.checkoutUrl);
    expect(fake.distinctAddonCheckoutSessionCount).toBe(2);
  });
});

describe("YF-813 — tenant izolasyonu", () => {
  it("farklı organizasyonların idempotency anahtarları ÇAKIŞMAZ (ayrı Session'lar)", async () => {
    const fake = createFakeStripeGateway();
    setStripeGatewayForTests(fake.gateway);
    const { owner: ownerA } = await createOwnerOrg();
    const { owner: ownerB } = await createOwnerOrg();

    const a = await createAddonCheckoutSession(ownerA, { addonKey: "ai_credits_pack" });
    const b = await createAddonCheckoutSession(ownerB, { addonKey: "ai_credits_pack" });

    expect(a.checkoutUrl).not.toBe(b.checkoutUrl);
    expect(fake.distinctAddonCheckoutSessionCount).toBe(2);
  });
});
