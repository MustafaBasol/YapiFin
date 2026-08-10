import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getEnv, resetEnvCacheForTests } from "@/lib/env";
import {
  CANONICAL_BILLING_PLAN_CODES,
  CONTACT_SALES_SENTINEL,
  getStripeConfig,
  resetStripeConfigCacheForTests,
  resolveStripePriceForPlan,
} from "@/lib/billing/stripe-config";
import { BillingConfigError, redactBillingSecrets } from "@/lib/billing/errors";
import { DEFAULT_PLANS } from "@/lib/entitlements/plan-defaults";

/**
 * YF-808 — Stripe yapılandırma sınırının saf (DB'siz) testleri.
 *
 * Gerçek bir Stripe kimlik bilgisi GEREKMEZ: tüm anahtarlar biçimsel olarak
 * geçerli ama sahte değerlerdir ve hiçbir ağ çağrısı yapılmaz.
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

const BASE_ENV: Record<string, string> = {
  NODE_ENV: "development",
  DATABASE_URL: "postgresql://user:pass@localhost:5432/db",
  AUTH_SECRET: "a".repeat(32),
  NEXT_PUBLIC_APP_URL: "https://app.example.com",
  TRUSTED_PROXY_COUNT: "1",
};

const STRIPE_KEYS = [
  "STRIPE_SECRET_KEY",
  "STRIPE_ENVIRONMENT",
  "STRIPE_PRICE_STARTER_MONTHLY",
  "STRIPE_PRICE_STARTER_ANNUAL",
  "STRIPE_PRICE_PROFESSIONAL_MONTHLY",
  "STRIPE_PRICE_PROFESSIONAL_ANNUAL",
  "STRIPE_PRICE_BUSINESS_MONTHLY",
  "STRIPE_PRICE_BUSINESS_ANNUAL",
  "STRIPE_PRICE_ENTERPRISE",
];

let originalEnv: Record<string, string | undefined>;

function setEnv(overrides: Record<string, string | undefined>) {
  for (const key of [...Object.keys(BASE_ENV), ...STRIPE_KEYS]) delete process.env[key];
  for (const [key, value] of Object.entries({ ...BASE_ENV, ...overrides })) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  resetEnvCacheForTests();
  resetStripeConfigCacheForTests();
}

beforeEach(() => {
  originalEnv = { ...process.env };
});

afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnv)) delete process.env[key];
  }
  Object.assign(process.env, originalEnv);
  resetEnvCacheForTests();
  resetStripeConfigCacheForTests();
});

describe("YF-808 — Stripe yapılandırması: fail-closed", () => {
  it("STRIPE_SECRET_KEY yoksa uygulama başlangıcı ETKİLENMEZ (getEnv hata vermez)", () => {
    setEnv({});
    // Kritik: eksik Stripe yapılandırması ilgisiz route'ları/boot'u çökertmez.
    expect(() => getEnv()).not.toThrow();
    expect(getEnv().stripe.secretKey).toBeNull();
  });

  it("STRIPE_SECRET_KEY yokken Stripe işlemi çağrılırsa fail-closed hata verir", () => {
    setEnv({});
    expect(() => getStripeConfig()).toThrow(BillingConfigError);
    expect(() => getStripeConfig()).toThrow(/STRIPE_SECRET_KEY yapılandırılmamış/);
  });

  it("fiyat çözümlemesi de gizli anahtar yokken fail-closed reddedilir", () => {
    setEnv({ STRIPE_PRICE_STARTER_MONTHLY: "price_FAKEstarter001" });
    expect(() => resolveStripePriceForPlan("STARTER", "MONTHLY")).toThrow(BillingConfigError);
  });

  it("geçersiz biçimli STRIPE_SECRET_KEY ortam doğrulamasında reddedilir", () => {
    setEnv({ STRIPE_SECRET_KEY: "pk_test_public_key_by_mistake" });
    expect(() => getEnv()).toThrow(/STRIPE_SECRET_KEY/);
  });

  it("STRIPE_PRICE_* alanına gizli anahtar yazılamaz (biçim reddi)", () => {
    setEnv({ STRIPE_SECRET_KEY: TEST_SECRET_KEY, STRIPE_PRICE_STARTER_MONTHLY: TEST_SECRET_KEY });
    expect(() => getEnv()).toThrow(/STRIPE_PRICE/);
  });
});

describe("YF-808 — test/live ortam ayrımı sessizce karışamaz", () => {
  it("ortam gizli anahtarın önekinden türetilir (test)", () => {
    setEnv({ STRIPE_SECRET_KEY: TEST_SECRET_KEY });
    expect(getStripeConfig().environment).toBe("TEST");
  });

  it("ortam gizli anahtarın önekinden türetilir (live)", () => {
    setEnv({ STRIPE_SECRET_KEY: LIVE_SECRET_KEY });
    expect(getStripeConfig().environment).toBe("LIVE");
  });

  it("STRIPE_ENVIRONMENT ile anahtar öneki uyuşmazsa fail-closed reddedilir", () => {
    setEnv({ STRIPE_SECRET_KEY: TEST_SECRET_KEY, STRIPE_ENVIRONMENT: "live" });
    expect(() => getStripeConfig()).toThrow(BillingConfigError);
    expect(() => getStripeConfig()).toThrow(/uyuşmuyor/);
  });

  it("STRIPE_ENVIRONMENT ile anahtar öneki uyuşmazsa (ters yön) da reddedilir", () => {
    setEnv({ STRIPE_SECRET_KEY: LIVE_SECRET_KEY, STRIPE_ENVIRONMENT: "test" });
    expect(() => getStripeConfig()).toThrow(BillingConfigError);
  });

  it("üretimde test anahtarı ancak STRIPE_ENVIRONMENT=test açıkça beyan edilirse kabul edilir", () => {
    setEnv({
      NODE_ENV: "production",
      AUTH_SECRET: "b".repeat(40),
      SMTP_HOST: "smtp.example.com",
      SMTP_PORT: "587",
      SMTP_FROM: "YapiFin <noreply@example.com>",
      REDIS_URL: "rediss://user:pass@redis.example.com:6380",
      STRIPE_SECRET_KEY: TEST_SECRET_KEY,
    });
    expect(() => getStripeConfig()).toThrow(/NODE_ENV=production/);

    setEnv({
      NODE_ENV: "production",
      AUTH_SECRET: "b".repeat(40),
      SMTP_HOST: "smtp.example.com",
      SMTP_PORT: "587",
      SMTP_FROM: "YapiFin <noreply@example.com>",
      REDIS_URL: "rediss://user:pass@redis.example.com:6380",
      STRIPE_SECRET_KEY: TEST_SECRET_KEY,
      STRIPE_ENVIRONMENT: "test",
    });
    expect(getStripeConfig().environment).toBe("TEST");
  });

  it("çözümlenen fiyat her zaman geçerli ortamı taşır (eşleme ortamdan bağımsız kullanılamaz)", () => {
    setEnv({ STRIPE_SECRET_KEY: LIVE_SECRET_KEY, STRIPE_PRICE_BUSINESS_MONTHLY: "price_FAKEbusiness001" });
    const price = resolveStripePriceForPlan("BUSINESS", "MONTHLY");
    expect(price.environment).toBe("LIVE");
  });
});

describe("YF-808 — plan → Stripe Price eşlemesi", () => {
  it("kanonik plan kodları DEFAULT_PLANS ile birebir aynıdır (ikinci bir liste icat edilmez)", () => {
    expect([...CANONICAL_BILLING_PLAN_CODES].sort()).toEqual(DEFAULT_PLANS.map((p) => p.code).sort());
    expect([...CANONICAL_BILLING_PLAN_CODES].sort()).toEqual(
      ["BUSINESS", "ENTERPRISE", "PROFESSIONAL", "STARTER"],
    );
  });

  it("env fiyat haritası her kanonik planı kapsar (sessiz kayma olamaz)", () => {
    setEnv({ STRIPE_SECRET_KEY: TEST_SECRET_KEY });
    // ENTERPRISE aralıktan bağımsızdır (`prices`); STARTER/PROFESSIONAL/BUSINESS
    // aralık bazlıdır (`intervalPrices`) — bkz. lib/env.ts StripeEnvConfig.
    const flatKeys = Object.keys(getEnv().stripe.prices);
    const intervalKeys = Object.keys(getEnv().stripe.intervalPrices);
    expect([...flatKeys, ...intervalKeys].sort()).toEqual([...CANONICAL_BILLING_PLAN_CODES].sort());
    for (const planCode of intervalKeys) {
      expect(Object.keys(getEnv().stripe.intervalPrices[planCode]).sort()).toEqual(["ANNUAL", "MONTHLY"]);
    }
  });

  it("yapılandırılmış bir plan+aralık için Price ID doğru çözümlenir", () => {
    setEnv({ STRIPE_SECRET_KEY: TEST_SECRET_KEY, STRIPE_PRICE_PROFESSIONAL_MONTHLY: "price_FAKEprofessional001" });
    const price = resolveStripePriceForPlan("PROFESSIONAL", "MONTHLY");
    expect(price).toMatchObject({
      planCode: "PROFESSIONAL",
      billingInterval: "MONTHLY",
      environment: "TEST",
      kind: "PRICE",
      priceId: "price_FAKEprofessional001",
    });
  });

  it("aylık ve yıllık aynı plan için BAĞIMSIZ Price ID'lere çözümlenir", () => {
    setEnv({
      STRIPE_SECRET_KEY: TEST_SECRET_KEY,
      STRIPE_PRICE_BUSINESS_MONTHLY: "price_FAKEbusinessM001",
      STRIPE_PRICE_BUSINESS_ANNUAL: "price_FAKEbusinessA001",
    });
    const monthly = resolveStripePriceForPlan("BUSINESS", "MONTHLY");
    const annual = resolveStripePriceForPlan("BUSINESS", "ANNUAL");
    expect(monthly.priceId).toBe("price_FAKEbusinessM001");
    expect(annual.priceId).toBe("price_FAKEbusinessA001");
    expect(monthly.priceId).not.toBe(annual.priceId);
  });

  it("yıllık henüz yapılandırılmamışsa fail-closed reddedilir (aylık fiyattan TÜRETİLMEZ)", () => {
    setEnv({ STRIPE_SECRET_KEY: TEST_SECRET_KEY, STRIPE_PRICE_STARTER_MONTHLY: "price_FAKEstarterM001" });
    expect(resolveStripePriceForPlan("STARTER", "MONTHLY").priceId).toBe("price_FAKEstarterM001");
    expect(() => resolveStripePriceForPlan("STARTER", "ANNUAL")).toThrow(BillingConfigError);
    expect(() => resolveStripePriceForPlan("STARTER", "ANNUAL")).toThrow(/STRIPE_PRICE_STARTER_ANNUAL yapılandırılmamış/);
  });

  it("bilinmeyen/eşlenmemiş plan kodu fail-closed reddedilir", () => {
    setEnv({ STRIPE_SECRET_KEY: TEST_SECRET_KEY, STRIPE_PRICE_STARTER_MONTHLY: "price_FAKEstarter001" });
    expect(() => resolveStripePriceForPlan("PLATINUM", "MONTHLY")).toThrow(BillingConfigError);
    expect(() => resolveStripePriceForPlan("PLATINUM", "MONTHLY")).toThrow(/Bilinmeyen plan kodu/);
    // Kanonik ama yapılandırılmamış plan da sessizce geçilmez.
    expect(() => resolveStripePriceForPlan("BUSINESS", "MONTHLY")).toThrow(/STRIPE_PRICE_BUSINESS_MONTHLY yapılandırılmamış/);
  });

  it("bilinmeyen faturalama aralığı fail-closed reddedilir", () => {
    setEnv({ STRIPE_SECRET_KEY: TEST_SECRET_KEY, STRIPE_PRICE_STARTER_MONTHLY: "price_FAKEstarter001" });
    // Kasıtlı olarak geçersiz bir aralık deneniyor (runtime fail-closed kanıtı) — tip kontrolü bilinçli olarak bypass edilir.
    const invalidInterval = "WEEKLY" as unknown as Parameters<typeof resolveStripePriceForPlan>[1];
    expect(() => resolveStripePriceForPlan("STARTER", invalidInterval)).toThrow(BillingConfigError);
  });

  it("Enterprise contact-sales ise UYDURMA bir Price ID döndürülmez (aralıktan bağımsızdır)", () => {
    setEnv({ STRIPE_SECRET_KEY: TEST_SECRET_KEY, STRIPE_PRICE_ENTERPRISE: CONTACT_SALES_SENTINEL });
    const monthly = resolveStripePriceForPlan("ENTERPRISE", "MONTHLY");
    const annual = resolveStripePriceForPlan("ENTERPRISE", "ANNUAL");
    expect(monthly.kind).toBe("CONTACT_SALES");
    expect(monthly.priceId).toBeNull();
    expect(annual.kind).toBe("CONTACT_SALES");
    expect(annual.priceId).toBeNull();
  });

  it("kaynak kodda hiçbir gerçek/uydurma Stripe Price ID sabit kodlanmamıştır", async () => {
    const { readFile } = await import("node:fs/promises");
    const files = [
      "lib/billing/stripe-config.ts",
      "lib/billing/stripe-gateway.ts",
      "lib/billing/errors.ts",
      "server/services/billing/stripe-customer-service.ts",
      "server/services/billing/checkout-service.ts",
    ];
    for (const file of files) {
      const source = await readFile(new URL(`../${file}`, import.meta.url), "utf8");
      // `price_` yalnızca doğrulama regex'inde geçebilir; gerçek bir kimlik
      // (price_XXXX) sabit kodlanmış olmamalıdır.
      const literals = source.match(/["'`]price_[A-Za-z0-9]+["'`]/g) ?? [];
      expect(literals, `${file} içinde sabit kodlanmış Price ID`).toEqual([]);
      expect(source).not.toMatch(/[sr]k_(test|live)_[A-Za-z0-9]{4,}/);
    }
  });
});

describe("YF-808 — sır redaksiyonu", () => {
  it("gizli anahtar ve webhook sırrı hata mesajlarından temizlenir", () => {
    const raw = `hata: ${TEST_SECRET_KEY} ve whsec_abc123DEF456 sızdı`;
    const redacted = redactBillingSecrets(raw);
    expect(redacted).not.toContain(TEST_SECRET_KEY);
    expect(redacted).not.toContain("whsec_abc123DEF456");
    expect(redacted).toContain("[REDACTED]");
  });

  it("BillingConfigError mesajı sır içermez", () => {
    const err = new BillingConfigError(`kurulum bozuk: ${LIVE_SECRET_KEY}`);
    expect(err.message).not.toContain(LIVE_SECRET_KEY);
    expect(err.message).toContain("[REDACTED]");
  });
});
