import type { StripeEnvironment, BillingInterval } from "@prisma/client";
import { getEnv } from "@/lib/env";
import { DEFAULT_PLANS } from "@/lib/entitlements/plan-defaults";
import { BillingConfigError } from "@/lib/billing/errors";

/**
 * YF-808 — Stripe yapılandırmasının TEK çözümleme noktası.
 *
 * ## Mimari sözleşme (değiştirilemez)
 *
 * Stripe yalnızca **ödeme/faturalama sağlayıcısıdır**. Uygulama erişimi ve
 * yetenekleri her zaman ve YALNIZCA YapiFin'in kendi `Plan` modeli +
 * `lib/entitlements/entitlement-service.ts` (YF-802) tarafından belirlenir.
 * Bu dosyadaki plan→Price eşlemesi bir **fiyatlandırma yönlendirmesidir**;
 * bir yetki/erişim kaynağı DEĞİLDİR. Stripe Product/Price/Customer metadata'sı
 * hiçbir çalışma zamanı yetkilendirme kararında OKUNMAZ (bkz.
 * tests/billing-stripe-customer.test.ts "entitlement authority" bölümü).
 *
 * ## Fail-closed davranışı
 *
 * `lib/env.ts` `STRIPE_*` değişkenlerini her ortamda opsiyonel tutar (yalnızca
 * biçim doğrular) — bu yüzden Stripe hiç yapılandırılmamışken uygulama
 * başlangıcı ve ilgisiz route'lar ETKİLENMEZ. Buradaki `getStripeConfig()`
 * ise yalnızca gerçek bir faturalama işlemi çağrıldığında çalışır ve eksik/
 * tutarsız yapılandırmada `BillingConfigError` fırlatır — sessizce devam
 * ETMEZ.
 *
 * ## Ortam ayrımı (test ↔ live)
 *
 * 1. Çalışma ortamı (`TEST`/`LIVE`) **gizli anahtarın önekinden türetilir** —
 *    bir dağıtımın yalnızca tek bir Stripe ortamı olabilir.
 * 2. `STRIPE_ENVIRONMENT` açıkça verilmişse önekten türetilenle birebir
 *    eşleşmelidir; eşleşmezse faturalama fail-closed kapanır (sessiz karışma
 *    engellenir).
 * 3. `NODE_ENV=production` altında bir **test** anahtarı ancak
 *    `STRIPE_ENVIRONMENT=test` AÇIKÇA beyan edilirse kabul edilir (staging
 *    senaryosu meşrudur, ama kazara olamaz).
 * 4. Kalıcı eşlemeler (`OrganizationStripeCustomer`) `environment` sütunuyla
 *    tutulur ve tüm okuma/yazmalar `[organizationId, environment]` ile scope
 *    edilir — TEST ortamında oluşmuş bir müşteri LIVE ortamında ASLA yeniden
 *    kullanılmaz (bkz. server/services/billing/stripe-customer-service.ts).
 */

/**
 * Kendi kendine satın alınamayan (contact-sales) katmanlar için sentinel.
 * Uydurma bir Price ID yerine bu değer yazılır — kaynak kodda veya
 * yapılandırmada ASLA sahte bir `price_...` bulunmaz.
 */
export const CONTACT_SALES_SENTINEL = "CONTACT_SALES";

/**
 * Kanonik plan kodları. `lib/entitlements/plan-defaults.ts`'ten TÜRETİLİR —
 * ikinci bir plan kodu listesi İCAT EDİLMEZ (bkz. o dosyanın kendi notu:
 * kanonik kaynak DB'deki `Plan` tablosudur, `DEFAULT_PLANS` ise o tablonun
 * kod/seed karşılığını tek yerden belgeler). Buradan yalnızca **kodlar**
 * okunur; limit/capability verisi ASLA okunmaz — yetki kararı her zaman
 * entitlement servisinindir.
 */
export const CANONICAL_BILLING_PLAN_CODES: readonly string[] = Object.freeze(
  DEFAULT_PLANS.map((plan) => plan.code),
);

export interface ResolvedStripeConfig {
  /** ASLA loglanmaz/serileştirilmez (bkz. lib/billing/errors.ts redactBillingSecrets). */
  readonly secretKey: string;
  readonly environment: StripeEnvironment;
}

export type StripePlanPriceKind = "PRICE" | "CONTACT_SALES";

/**
 * YF-809 — Stripe Checkout'ta seçilebilen faturalama aralığı.
 * `@prisma/client`'tan TÜRETİLİR (prisma/schema.prisma'daki `BillingInterval`
 * enum'u) — `StripeEnvironment` ile AYNI desen, ikinci bir tip İCAT EDİLMEZ.
 */
export type { BillingInterval };

export const BILLING_INTERVALS: readonly BillingInterval[] = Object.freeze(["MONTHLY", "ANNUAL"]);

/**
 * ENTERPRISE aralıktan bağımsızdır (her zaman contact-sales) — tek bir
 * `STRIPE_PRICE_ENTERPRISE` değişkeni kullanır (bkz. lib/env.ts). Diğer üç
 * kanonik plan aralık bazlı (`_MONTHLY`/`_ANNUAL`) ayrı değişken kullanır.
 */
const INTERVAL_INDEPENDENT_PLAN_CODES: readonly string[] = Object.freeze(["ENTERPRISE"]);

export interface ResolvedPlanPrice {
  readonly planCode: string;
  readonly billingInterval: BillingInterval;
  readonly environment: StripeEnvironment;
  readonly kind: StripePlanPriceKind;
  /** `kind === "CONTACT_SALES"` olduğunda her zaman `null` — uydurulmuş bir ID ASLA döndürülmez. */
  readonly priceId: string | null;
}

function deriveEnvironmentFromSecretKey(secretKey: string): StripeEnvironment {
  if (/^[sr]k_test_/.test(secretKey)) return "TEST";
  if (/^[sr]k_live_/.test(secretKey)) return "LIVE";
  // lib/env.ts biçimi zaten doğrular; bu yalnızca savunma amaçlı ikinci bir
  // kontroldür (ör. testlerde doğrudan enjekte edilen bozuk bir değer).
  throw new BillingConfigError(
    "STRIPE_SECRET_KEY tanınmayan bir önek taşıyor — Stripe ortamı (test/live) belirlenemedi.",
  );
}

let cached: ResolvedStripeConfig | null = null;

/**
 * Kullanıma hazır Stripe yapılandırmasını çözer. Eksik/tutarsız her durumda
 * `BillingConfigError` fırlatır (fail-closed) — hiçbir koşulda "varsayılan"
 * bir ortama veya anahtara düşmez.
 */
export function getStripeConfig(): ResolvedStripeConfig {
  if (cached) return cached;

  const env = getEnv();
  const secretKey = env.stripe.secretKey;
  if (!secretKey) {
    throw new BillingConfigError(
      "STRIPE_SECRET_KEY yapılandırılmamış — Stripe faturalama işlemleri kullanılamaz.",
    );
  }

  const environment = deriveEnvironmentFromSecretKey(secretKey);
  const declared = env.stripe.declaredEnvironment;

  if (declared && declared.toUpperCase() !== environment) {
    throw new BillingConfigError(
      `STRIPE_ENVIRONMENT ("${declared}") ile STRIPE_SECRET_KEY önekinden türetilen ortam ("${environment.toLowerCase()}") uyuşmuyor — test/live yapılandırması karışmış olabilir.`,
    );
  }

  if (env.NODE_ENV === "production" && environment === "TEST" && declared !== "test") {
    throw new BillingConfigError(
      "Üretim ortamında (NODE_ENV=production) Stripe test anahtarı yalnızca STRIPE_ENVIRONMENT=test açıkça beyan edildiğinde kullanılabilir.",
    );
  }

  cached = Object.freeze({ secretKey, environment });
  return cached;
}

/** Bir plan kodu için hangi `STRIPE_PRICE_*` değişkeninden okunacağını ve ham değerini döner. */
function readRawPrice(planCode: string, interval: BillingInterval): { envVarName: string; raw: string | null } {
  if (INTERVAL_INDEPENDENT_PLAN_CODES.includes(planCode)) {
    return { envVarName: `STRIPE_PRICE_${planCode}`, raw: getEnv().stripe.prices[planCode] ?? null };
  }
  return {
    envVarName: `STRIPE_PRICE_${planCode}_${interval}`,
    raw: getEnv().stripe.intervalPrices[planCode]?.[interval] ?? null,
  };
}

/**
 * Kanonik bir uygulama planı + faturalama aralığı için yapılandırılmış
 * Stripe fiyatını çözer.
 *
 * **Bu bir yetki kontrolü DEĞİLDİR.** Dönen değer yalnızca hangi Stripe
 * Price'ının faturalanacağını söyler; bir organizasyonun neye erişebileceğini
 * ASLA belirlemez (bunun tek kaynağı YF-802 entitlement servisidir).
 *
 * Fail-closed: bilinmeyen bir plan kodu, bilinmeyen bir aralık veya
 * yapılandırılmamış bir fiyat `BillingConfigError` ile reddedilir — sessizce
 * atlanmaz, varsayılan bir fiyata veya aralığa düşülmez (ör. yıllık henüz
 * yapılandırılmamışsa aylık fiyata SESSİZCE geri dönülmez).
 */
export function resolveStripePriceForPlan(planCode: string, interval: BillingInterval): ResolvedPlanPrice {
  // Ortam çözümlemesi ÖNCE yapılır: yapılandırılmamış/tutarsız bir Stripe
  // kurulumunda bir fiyat kimliği döndürmek, test/live karışmasına açık kapı
  // bırakırdı.
  const config = getStripeConfig();

  if (!CANONICAL_BILLING_PLAN_CODES.includes(planCode)) {
    throw new BillingConfigError(
      `Bilinmeyen plan kodu için Stripe fiyatı çözümlenemez: "${planCode}". Kanonik planlar: ${CANONICAL_BILLING_PLAN_CODES.join(", ")}.`,
    );
  }
  if (!BILLING_INTERVALS.includes(interval)) {
    throw new BillingConfigError(
      `Bilinmeyen faturalama aralığı için Stripe fiyatı çözümlenemez: "${interval}". Geçerli aralıklar: ${BILLING_INTERVALS.join(", ")}.`,
    );
  }

  const { envVarName, raw } = readRawPrice(planCode, interval);
  if (!raw) {
    throw new BillingConfigError(
      `${envVarName} yapılandırılmamış — "${planCode}" planı (${interval}) için Stripe fiyatı çözümlenemez.`,
    );
  }

  if (raw === CONTACT_SALES_SENTINEL) {
    return Object.freeze({
      planCode,
      billingInterval: interval,
      environment: config.environment,
      kind: "CONTACT_SALES" as const,
      priceId: null,
    });
  }

  if (!/^price_[A-Za-z0-9]+$/.test(raw)) {
    // lib/env.ts biçimi zaten doğrular; savunma amaçlı ikinci kontrol.
    throw new BillingConfigError(`${envVarName} geçerli bir Stripe Price ID değil.`);
  }

  return Object.freeze({
    planCode,
    billingInterval: interval,
    environment: config.environment,
    kind: "PRICE" as const,
    priceId: raw,
  });
}

/**
 * YALNIZCA testler içindir — `process.env` değiştirildikten sonra memoize
 * edilmiş yapılandırmayı temizler (bkz. lib/env.ts resetEnvCacheForTests aynı
 * desen). Uygulama kod yolunun hiçbir yerinden çağrılmaz.
 */
export function resetStripeConfigCacheForTests(): void {
  cached = null;
}
