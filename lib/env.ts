import { z } from "zod";

/**
 * Tek yetkili ortam değişkeni doğrulama noktası. `getEnv()` uygulama
 * başlangıcında (`instrumentation.ts`) çağrılır; eksik/güvensiz bir
 * değişken varsa süreç burada, ilk isteği karşılamadan önce çöker.
 * Servis/action/mailer katmanları ham `process.env` yerine bu modülün
 * döndürdüğü donmuş, tipli nesneyi kullanmalıdır.
 */

const LOCAL_HOSTNAMES = new Set(["localhost", "127.0.0.1", "::1"]);

// .env.example'daki ve yaygın placeholder değerler — üretimde bu değerlerin
// herhangi biri AUTH_SECRET olarak kalırsa gerçek bir güvenlik sağlamaz.
const PLACEHOLDER_SECRET_VALUES = new Set([
  "change-me-with-a-long-random-secret",
  "changeme",
  "change-me",
  "secret",
  "password",
  "your-secret-here",
  "test",
]);

function isPlaceholderSecret(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  if (!normalized) return true;
  if (PLACEHOLDER_SECRET_VALUES.has(normalized)) return true;
  return normalized.includes("change-me") || normalized.includes("changeme");
}

function emptyToUndefined(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * YF-808 — `STRIPE_PRICE_*` biçim kontrolü. İzin verilen tek iki biçim:
 * gerçek bir Stripe Price ID (`price_...`) veya kendi kendine satın alınamayan
 * katmanlar için `CONTACT_SALES` sentinel'i. Bu, bir gizli anahtarın (sk_/rk_/
 * whsec_) yanlışlıkla fiyat değişkenine yazılmasını da biçim düzeyinde
 * engeller (bkz. lib/billing/stripe-config.ts).
 */
const STRIPE_PRICE_MESSAGE =
  "STRIPE_PRICE_* değeri bir Stripe Price ID (`price_...`) veya `CONTACT_SALES` sentinel'i olmalıdır";

function isStripePriceValue(value: string | undefined): boolean {
  return value === undefined || value === "CONTACT_SALES" || /^price_[A-Za-z0-9]+$/.test(value);
}

const rawEnvSchema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  DATABASE_URL: z
    .string()
    .min(1, "DATABASE_URL zorunludur")
    .refine((v) => /^postgres(ql)?:\/\/\S+$/.test(v), {
      message: "DATABASE_URL geçerli bir postgres(ql):// bağlantı adresi olmalıdır",
    }),
  AUTH_SECRET: z.string().min(16, "AUTH_SECRET en az 16 karakter olmalıdır"),
  NEXT_PUBLIC_APP_URL: z
    .string()
    .url("NEXT_PUBLIC_APP_URL mutlak bir URL olmalıdır (örn. https://app.example.com)")
    .default("http://localhost:3000"),
  NEXT_PUBLIC_APP_NAME: z.string().default("YapiFin"),
  SMTP_HOST: z.string().optional().transform(emptyToUndefined),
  SMTP_PORT: z.coerce.number().int().positive().optional(),
  SMTP_USER: z.string().optional().transform(emptyToUndefined),
  SMTP_PASSWORD: z.string().optional().transform(emptyToUndefined),
  SMTP_FROM: z.string().optional().transform(emptyToUndefined),
  // Redis tabanlı dağıtık rate limiting (YF-509). Development/test'te boş
  // bırakılabilir — rate limiter bu durumda süreç-içi (per-instance) yedek
  // moda düşer (bkz. lib/rate-limit/policy.ts, fail-open kararı).
  REDIS_URL: z
    .string()
    .optional()
    .transform(emptyToUndefined)
    .refine((v) => v === undefined || /^rediss?:\/\/\S+$/.test(v), {
      message: "REDIS_URL geçerli bir redis:// veya rediss:// bağlantı adresi olmalıdır",
    }),
  // Rate limiter'ın istemci IP'sini X-Forwarded-For'dan güvenle çıkarabilmesi
  // için önündeki güvenilir ters proxy/load balancer sayısı. Üretimde
  // açıkça ayarlanmalıdır (bkz. lib/rate-limit/client-ip.ts).
  TRUSTED_PROXY_COUNT: z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
    z.coerce.number().int().min(0).optional(),
  ),
  // Hata izleme/APM (YF-512) — bilinçli olarak her ortamda opsiyoneldir
  // (production dahil): eksikliği süreci ASLA çökertmemelidir, yalnızca
  // gözlemlenebilirlik kaybına yol açar (bkz. lib/monitoring/index.ts,
  // production'da eksikse tek seferlik uyarı loglar).
  SENTRY_DSN: z
    .string()
    .optional()
    .transform(emptyToUndefined)
    .refine((v) => v === undefined || /^https?:\/\/\S+$/.test(v), {
      message: "SENTRY_DSN geçerli bir http(s):// URL olmalıdır",
    }),
  SENTRY_ENVIRONMENT: z.string().optional().transform(emptyToUndefined),
  SENTRY_TRACES_SAMPLE_RATE: z.coerce.number().min(0).max(1).optional(),
  // YF-605-A — entegrasyon kimlik bilgisi şifreleme anahtarı (bkz.
  // lib/integration-crypto.ts, docs/architecture/YF-605_...md §8).
  // AUTH_SECRET'ten KASITLI olarak ayrıdır (farklı tehdit modeli, farklı
  // rotasyon ihtiyacı — bkz. görev talimatı "never reuse AUTH_SECRET").
  // Bilinçli olarak her ortamda opsiyoneldir: entegrasyon modülü organizasyon
  // bazında opt-in'dir (varsayılan IntegrationConnection.status = INACTIVE,
  // bkz. mimari doküman §15) ve bu anahtar hiç ayarlanmamışsa uygulama
  // başlangıcı ETKİLENMEMELİDİR — yalnızca gerçek bir kimlik bilgisi
  // şifreleme/çözme çağrısı yapıldığında (server/services/integrations/*)
  // fail-closed bir hata fırlatılır. Tanımlıysa biçim her zaman (üretim dahil
  // her ortamda) doğrulanır: `openssl rand -hex 32` ile üretilebilecek,
  // tam 64 karakterlik onaltılık (hex) bir dize (32 bayt, AES-256-GCM anahtarı).
  INTEGRATION_ENCRYPTION_KEY: z
    .string()
    .optional()
    .transform(emptyToUndefined)
    .refine((v) => v === undefined || /^[0-9a-fA-F]{64}$/.test(v), {
      message:
        "INTEGRATION_ENCRYPTION_KEY tam 64 karakterlik onaltılık (hex) bir dize olmalıdır (32 bayt — örn. `openssl rand -hex 32` ile üretin)",
    }),
  // YF-701 — AI temeli. Sağlayıcı-nötr soyutlama (bkz. lib/ai/provider.ts);
  // bu görev kapsamında gerçek/ücretli bir LLM sağlayıcısı EKLENMEZ, yalnızca
  // "disabled" (varsayılan, no-op) ve "fake" (yalnızca testler) desteklenir.
  // Her ortamda opsiyoneldir — hiç ayarlanmazsa AI özellikleri devre dışı
  // kalır, uygulama başlangıcı ETKİLENMEZ.
  AI_PROVIDER: z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
    z.enum(["disabled", "fake"]).optional(),
  ),
  AI_MODEL: z.string().optional().transform(emptyToUndefined),
  AI_REQUEST_TIMEOUT_MS: z.coerce.number().int().positive().optional(),
  // YF-808 — Stripe faturalama temeli (bkz. lib/billing/*). Bu blok
  // `INTEGRATION_ENCRYPTION_KEY` ile TAM AYNI deseni izler: her ortamda
  // (üretim dahil) OPSİYONELDİR — hiç ayarlanmazsa uygulama başlangıcı ve
  // ilgisiz route'lar ETKİLENMEZ; yalnızca gerçek bir Stripe işlemi
  // çağrıldığında `lib/billing/stripe-config.ts` fail-closed bir
  // `BillingConfigError` fırlatır. Tanımlıysa BİÇİM her ortamda doğrulanır
  // (aşağıdaki refine'lar) — böylece bir yazım hatası sessizce üretime
  // gitmez. Ortamlar arası karışmanın (test/live) engellenmesi bu dosyada
  // DEĞİL, `lib/billing/stripe-config.ts`'te çapraz-alan kontrolüyle yapılır
  // (bkz. o dosyanın "ortam ayrımı" bölümü) — çünkü çapraz-alan tutarsızlığı
  // uygulama başlangıcını çökertmemeli, yalnızca faturalama yolunu kapatmalıdır.
  //
  // Gizli anahtar ASLA loglanmaz/serileştirilmez (bkz. lib/billing/errors.ts
  // redactBillingSecrets).
  STRIPE_SECRET_KEY: z
    .string()
    .optional()
    .transform(emptyToUndefined)
    .refine((v) => v === undefined || /^[sr]k_(test|live)_[A-Za-z0-9]+$/.test(v), {
      message:
        "STRIPE_SECRET_KEY geçerli bir Stripe gizli anahtarı olmalıdır (sk_test_/sk_live_/rk_test_/rk_live_ ile başlar)",
    }),
  // Opsiyonel, AÇIK ortam beyanı. Ayarlanmışsa `STRIPE_SECRET_KEY`'in
  // önekinden türetilen ortamla BİREBİR eşleşmelidir; eşleşmezse faturalama
  // yolu fail-closed kapanır (bkz. lib/billing/stripe-config.ts).
  STRIPE_ENVIRONMENT: z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
    z.enum(["test", "live"]).optional(),
  ),
  // Kanonik plan (bkz. lib/entitlements/plan-defaults.ts DEFAULT_PLANS) →
  // Stripe Price ID eşlemesi. Kaynak kodda GERÇEK/UYDURMA bir Price ID
  // bulunmaz; tüm değerler ortamdan gelir. Kendi kendine satın alınamayan
  // (contact-sales) bir katman için sahte bir ID yerine `CONTACT_SALES`
  // sentinel'i yazılır (bkz. lib/billing/stripe-config.ts).
  //
  // YF-809 — kendi kendine satın alınabilen üç plan (STARTER/PROFESSIONAL/
  // BUSINESS) aralık bazlı (`_MONTHLY`/`_ANNUAL`) ayrı Price ID'ler alır;
  // Stripe Checkout tek bir Price'a bağlıdır, "tek fiyat + çarpan" gibi bir
  // türetme YAPILMAZ. Yıllık henüz yapılandırılmamışsa (`null`) checkout
  // fail-closed reddedilir (bkz. resolveStripePriceForPlan) — uydurma bir ID
  // ASLA üretilmez. ENTERPRISE aralıktan BAĞIMSIZDIR (her zaman
  // kendi-kendine-satın-alınamaz contact-sales), bu yüzden TEK bir değişken
  // olarak kalır.
  STRIPE_PRICE_STARTER_MONTHLY: z.string().optional().transform(emptyToUndefined).refine(isStripePriceValue, {
    message: STRIPE_PRICE_MESSAGE,
  }),
  STRIPE_PRICE_STARTER_ANNUAL: z.string().optional().transform(emptyToUndefined).refine(isStripePriceValue, {
    message: STRIPE_PRICE_MESSAGE,
  }),
  STRIPE_PRICE_PROFESSIONAL_MONTHLY: z.string().optional().transform(emptyToUndefined).refine(isStripePriceValue, {
    message: STRIPE_PRICE_MESSAGE,
  }),
  STRIPE_PRICE_PROFESSIONAL_ANNUAL: z.string().optional().transform(emptyToUndefined).refine(isStripePriceValue, {
    message: STRIPE_PRICE_MESSAGE,
  }),
  STRIPE_PRICE_BUSINESS_MONTHLY: z.string().optional().transform(emptyToUndefined).refine(isStripePriceValue, {
    message: STRIPE_PRICE_MESSAGE,
  }),
  STRIPE_PRICE_BUSINESS_ANNUAL: z.string().optional().transform(emptyToUndefined).refine(isStripePriceValue, {
    message: STRIPE_PRICE_MESSAGE,
  }),
  STRIPE_PRICE_ENTERPRISE: z.string().optional().transform(emptyToUndefined).refine(isStripePriceValue, {
    message: STRIPE_PRICE_MESSAGE,
  }),
  // YF-813 — kullanım/ek-kota (add-on/top-up) paketleri için tek seferlik
  // Stripe Price ID'leri. `CONTACT_SALES` sentinel'i buraya ANLAMSIZDIR
  // (add-on'lar her zaman kendi-kendine satın alınabilir) — yine de aynı
  // biçim doğrulayıcı (`isStripePriceValue`) yeniden kullanılır (ikinci bir
  // regex İCAT EDİLMEZ); katalog çözümlemesi (bkz. lib/billing/addon-catalog.ts)
  // `CONTACT_SALES` değerini "yapılandırılmamış" olarak ele alır.
  STRIPE_PRICE_ADDON_AI_CREDITS: z.string().optional().transform(emptyToUndefined).refine(isStripePriceValue, {
    message: STRIPE_PRICE_MESSAGE,
  }),
  STRIPE_PRICE_ADDON_OCR_DOCS: z.string().optional().transform(emptyToUndefined).refine(isStripePriceValue, {
    message: STRIPE_PRICE_MESSAGE,
  }),
  // YF-810 — Stripe webhook uç noktası imza doğrulama sırrı (Stripe
  // panelinden/CLI'dan alınır; `STRIPE_SECRET_KEY` ile AYNI şey DEĞİLDİR).
  // Diğer tüm `STRIPE_*` değişkenleri gibi her ortamda opsiyonel tutulur
  // (yalnızca biçim doğrulanır) — webhook uç noktası, sır tanımlı değilken
  // fail-closed reddeder (bkz. lib/billing/stripe-config.ts
  // getStripeWebhookSecret), uygulama başlangıcı ETKİLENMEZ.
  STRIPE_WEBHOOK_SECRET: z
    .string()
    .optional()
    .transform(emptyToUndefined)
    .refine((v) => v === undefined || /^whsec_[A-Za-z0-9]+$/.test(v), {
      message: "STRIPE_WEBHOOK_SECRET geçerli bir Stripe webhook imza sırrı olmalıdır (whsec_ ile başlar)",
    }),
  // YF-821 — dunning grace-expiry sweep uç noktasını (bkz.
  // app/api/internal/billing/dunning-sweep/route.ts) çağırmak için harici
  // zamanlayıcının (işletim sistemi cron'u, barındırma platformunun kendi
  // zamanlayıcısı, vb. — bu kod tabanında GÖMÜLÜ bir zamanlayıcı YOKTUR,
  // bkz. o route'un dosya başı notu) sunması gereken paylaşımlı sır.
  // `STRIPE_WEBHOOK_SECRET` İLE AYNI opsiyonel + fail-closed felsefesi:
  // uygulama başlangıcı ETKİLENMEZ, yalnızca route çağrıldığında
  // değerlendirilir (bkz. lib/billing/notification-policy.ts
  // getBillingSweepSecret).
  BILLING_SWEEP_SECRET: z
    .string()
    .optional()
    .transform(emptyToUndefined)
    .refine((v) => v === undefined || (v.length >= 24 && !isPlaceholderSecret(v)), {
      message: "BILLING_SWEEP_SECRET en az 24 karakter olmalı ve yer tutucu bir değer OLMAMALIDIR",
    }),
});

const envSchema = rawEnvSchema.superRefine((data, ctx) => {
  // SMTP kimlik doğrulaması ya tam olmalı ya da hiç olmamalı (güvenilir
  // relay senaryosunda ikisi de boş bırakılabilir); yarım bırakılamaz.
  if (Boolean(data.SMTP_USER) !== Boolean(data.SMTP_PASSWORD)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["SMTP_USER"],
      message: "SMTP_USER ve SMTP_PASSWORD birlikte tanımlanmalı veya ikisi de boş bırakılmalıdır",
    });
  }

  if (data.NODE_ENV !== "production") return;

  if (isPlaceholderSecret(data.AUTH_SECRET)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["AUTH_SECRET"],
      message: "AUTH_SECRET üretimde varsayılan/placeholder bir değer olamaz",
    });
  }
  if (data.AUTH_SECRET.length < 32) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["AUTH_SECRET"],
      message: "AUTH_SECRET üretimde en az 32 karakter olmalıdır",
    });
  }

  if (data.DATABASE_URL.includes("yapifin_dev_password")) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["DATABASE_URL"],
      message: "DATABASE_URL üretimde geliştirme parolasıyla (yapifin_dev_password) kullanılamaz",
    });
  }

  let parsedUrl: URL | null = null;
  try {
    parsedUrl = new URL(data.NEXT_PUBLIC_APP_URL);
  } catch {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["NEXT_PUBLIC_APP_URL"],
      message: "NEXT_PUBLIC_APP_URL geçersiz",
    });
  }
  if (parsedUrl && parsedUrl.protocol !== "https:" && !LOCAL_HOSTNAMES.has(parsedUrl.hostname)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["NEXT_PUBLIC_APP_URL"],
      message: "NEXT_PUBLIC_APP_URL üretimde https:// olmalıdır (yalnızca localhost/127.0.0.1 istisnadır)",
    });
  }

  if (!data.SMTP_HOST) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["SMTP_HOST"],
      message: "SMTP_HOST üretimde zorunludur — e-posta gönderimi olmadan üretime çıkılamaz",
    });
  }
  if (!data.SMTP_PORT) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["SMTP_PORT"],
      message: "SMTP_PORT üretimde zorunludur",
    });
  }
  if (!data.SMTP_FROM) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["SMTP_FROM"],
      message: "SMTP_FROM üretimde zorunludur",
    });
  }

  if (!data.REDIS_URL) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["REDIS_URL"],
      message: "REDIS_URL üretimde zorunludur — rate limiting tüm instance'lar arasında paylaşılmalıdır",
    });
  } else {
    let redisUrl: URL | null = null;
    try {
      redisUrl = new URL(data.REDIS_URL);
    } catch {
      // Biçim zaten yukarıdaki şema refine'ında yakalanır.
    }
    if (redisUrl && redisUrl.protocol !== "rediss:" && !LOCAL_HOSTNAMES.has(redisUrl.hostname)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["REDIS_URL"],
        message: "REDIS_URL üretimde TLS (rediss://) kullanmalıdır (yalnızca localhost/127.0.0.1 istisnadır)",
      });
    }
  }

  if (data.TRUSTED_PROXY_COUNT === undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["TRUSTED_PROXY_COUNT"],
      message: "TRUSTED_PROXY_COUNT üretimde açıkça ayarlanmalıdır (önündeki güvenilir ters proxy/load balancer sayısı, örn. 1)",
    });
  }

  // "fake" sağlayıcı yalnızca testler içindir (bkz. lib/ai/providers/fake-provider.ts,
  // deterministik/uydurma yanıtlar döner) — üretimde asla seçilemez.
  if (data.AI_PROVIDER === "fake") {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["AI_PROVIDER"],
      message: "AI_PROVIDER üretimde 'fake' olamaz — bu sağlayıcı yalnızca testler içindir",
    });
  }
});

export type RawEnv = z.infer<typeof rawEnvSchema>;

export interface SmtpConfig {
  host: string;
  port: number;
  from: string;
  auth: { user: string; password: string } | null;
}

export interface RedisConfig {
  url: string;
  tls: boolean;
}

export interface MonitoringConfig {
  /** `null` ise hata izleme devre dışıdır (yalnızca no-op adapter kullanılır) — bkz. lib/monitoring/index.ts. */
  dsn: string | null;
  environment: string;
  /** [0,1] aralığında; belirtilmemişse 0 (izleme yapılandırılmışsa bile agresif olmayan varsayılan). */
  tracesSampleRate: number;
}

export interface AiConfig {
  /** "disabled" (varsayılan, no-op) veya "fake" (yalnızca test) — bkz. lib/ai/config.ts. */
  provider: "disabled" | "fake";
  model: string | null;
  requestTimeoutMs: number;
}

/**
 * YF-808 — Stripe faturalama ham yapılandırması. Bu nesne bir "kullanıma hazır
 * yapılandırma" DEĞİLDİR: yalnızca biçimi doğrulanmış ham değerleri taşır.
 * Kullanılabilirlik/tutarlılık kararı (eksik anahtar, test/live karışması)
 * `lib/billing/stripe-config.ts` içinde, yalnızca gerçek bir Stripe işlemi
 * çağrıldığında verilir.
 */
export interface StripeEnvConfig {
  /** `null` ise Stripe hiç yapılandırılmamıştır — faturalama yolu fail-closed kapalıdır, uygulama başlangıcı etkilenmez. */
  secretKey: string | null;
  /** YF-810 — `null` ise webhook uç noktası fail-closed kapalıdır (bkz. lib/billing/stripe-config.ts getStripeWebhookSecret). */
  webhookSecret: string | null;
  /** Açık ortam beyanı; `null` ise ortam yalnızca gizli anahtar önekinden türetilir. */
  declaredEnvironment: "test" | "live" | null;
  /** Aralıktan bağımsız planlar (bugün yalnızca ENTERPRISE/contact-sales) → ham `STRIPE_PRICE_*` değeri; tanımsızsa `null`. */
  prices: Readonly<Record<string, string | null>>;
  /** YF-809 — kendi kendine satın alınabilen planlar (STARTER/PROFESSIONAL/BUSINESS) → aralık → ham `STRIPE_PRICE_*_{MONTHLY,ANNUAL}` değeri; tanımsızsa `null`. */
  intervalPrices: Readonly<Record<string, Readonly<Record<"MONTHLY" | "ANNUAL", string | null>>>>;
  /**
   * YF-813 — kullanım/ek-kota (add-on/top-up) paketleri → ham
   * `STRIPE_PRICE_ADDON_*` değeri; tanımsızsa `null`. `prices`'tan BİLİNÇLİ
   * OLARAK AYRIDIR: `prices`, `tests/billing-stripe-config.test.ts`
   * "env fiyat haritası her kanonik PLANI kapsar" değişmezinin kapsadığı bir
   * sözleşmedir (yalnızca `CANONICAL_BILLING_PLAN_CODES`) — add-on'lar plan
   * DEĞİLDİR, bu yüzden AYRI bir alan olarak tutulur (bkz.
   * lib/billing/addon-catalog.ts `resolveAddonPrice`).
   */
  addonPrices: Readonly<Record<string, string | null>>;
}

export interface Env {
  NODE_ENV: RawEnv["NODE_ENV"];
  DATABASE_URL: string;
  AUTH_SECRET: string;
  NEXT_PUBLIC_APP_URL: string;
  NEXT_PUBLIC_APP_NAME: string;
  /** SMTP tam olarak yapılandırılmışsa dolu; aksi halde null (yalnızca development/test'te null olabilir). */
  smtp: SmtpConfig | null;
  /** Redis tabanlı dağıtık rate limiting için bağlantı bilgisi; yapılandırılmamışsa null (yalnızca development/test'te null olabilir — bkz. lib/rate-limit/policy.ts, fail-open yedek modu). */
  redis: RedisConfig | null;
  /** X-Forwarded-For çözümlemesinde güvenilecek ters proxy/load balancer sayısı (bkz. lib/rate-limit/client-ip.ts). */
  trustedProxyCount: number;
  monitoring: MonitoringConfig;
  /** `null` ise entegrasyon kimlik bilgisi şifreleme/çözme devre dışıdır — bkz. lib/integration-crypto.ts (fail-closed yalnızca gerçek kullanımda). */
  integrationEncryptionKey: string | null;
  ai: AiConfig;
  /** YF-808 — bkz. StripeEnvConfig; ham/doğrulanmamış-çapraz değerlerdir, doğrudan kullanılmaz (lib/billing/stripe-config.ts üzerinden çözülür). */
  stripe: StripeEnvConfig;
  /** YF-821 — `null` ise dunning sweep uç noktası fail-closed kapalıdır (bkz. lib/billing/notification-policy.ts getBillingSweepSecret). */
  billingSweepSecret: string | null;
}

function buildEnv(data: RawEnv): Env {
  const smtp: SmtpConfig | null = data.SMTP_HOST
    ? {
        host: data.SMTP_HOST,
        port: data.SMTP_PORT ?? 587,
        from: data.SMTP_FROM ?? "YapiFin <noreply@yapifin.com>",
        auth: data.SMTP_USER && data.SMTP_PASSWORD ? { user: data.SMTP_USER, password: data.SMTP_PASSWORD } : null,
      }
    : null;

  const redis: RedisConfig | null = data.REDIS_URL
    ? { url: data.REDIS_URL, tls: data.REDIS_URL.startsWith("rediss://") }
    : null;

  return Object.freeze({
    NODE_ENV: data.NODE_ENV,
    DATABASE_URL: data.DATABASE_URL,
    AUTH_SECRET: data.AUTH_SECRET,
    NEXT_PUBLIC_APP_URL: data.NEXT_PUBLIC_APP_URL,
    NEXT_PUBLIC_APP_NAME: data.NEXT_PUBLIC_APP_NAME,
    smtp: smtp ? Object.freeze(smtp) : null,
    redis: redis ? Object.freeze(redis) : null,
    trustedProxyCount: data.TRUSTED_PROXY_COUNT ?? 0,
    monitoring: Object.freeze({
      dsn: data.SENTRY_DSN ?? null,
      environment: data.SENTRY_ENVIRONMENT ?? data.NODE_ENV,
      tracesSampleRate: data.SENTRY_TRACES_SAMPLE_RATE ?? 0,
    }),
    integrationEncryptionKey: data.INTEGRATION_ENCRYPTION_KEY ?? null,
    ai: Object.freeze({
      provider: data.AI_PROVIDER ?? "disabled",
      model: data.AI_MODEL ?? null,
      requestTimeoutMs: data.AI_REQUEST_TIMEOUT_MS ?? 15000,
    }),
    stripe: Object.freeze({
      secretKey: data.STRIPE_SECRET_KEY ?? null,
      webhookSecret: data.STRIPE_WEBHOOK_SECRET ?? null,
      declaredEnvironment: data.STRIPE_ENVIRONMENT ?? null,
      prices: Object.freeze({
        ENTERPRISE: data.STRIPE_PRICE_ENTERPRISE ?? null,
      }),
      addonPrices: Object.freeze({
        ADDON_AI_CREDITS: data.STRIPE_PRICE_ADDON_AI_CREDITS ?? null,
        ADDON_OCR_DOCS: data.STRIPE_PRICE_ADDON_OCR_DOCS ?? null,
      }),
      intervalPrices: Object.freeze({
        STARTER: Object.freeze({
          MONTHLY: data.STRIPE_PRICE_STARTER_MONTHLY ?? null,
          ANNUAL: data.STRIPE_PRICE_STARTER_ANNUAL ?? null,
        }),
        PROFESSIONAL: Object.freeze({
          MONTHLY: data.STRIPE_PRICE_PROFESSIONAL_MONTHLY ?? null,
          ANNUAL: data.STRIPE_PRICE_PROFESSIONAL_ANNUAL ?? null,
        }),
        BUSINESS: Object.freeze({
          MONTHLY: data.STRIPE_PRICE_BUSINESS_MONTHLY ?? null,
          ANNUAL: data.STRIPE_PRICE_BUSINESS_ANNUAL ?? null,
        }),
      }),
    }),
    billingSweepSecret: data.BILLING_SWEEP_SECRET ?? null,
  });
}

let cached: Env | null = null;

/** Ortam değişkenlerini doğrular; eksik/yanlış olduğunda hata fırlatır (uygulama başlangıcında `instrumentation.ts` tarafından çağrılır). */
export function getEnv(): Env {
  if (cached) return cached;
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Ortam değişkenleri geçersiz: ${issues}`);
  }
  cached = buildEnv(parsed.data);
  return cached;
}

/**
 * Yalnızca testlerde: process.env'i değiştirdikten sonra memoize edilmiş
 * önbelleği temizler (testler NODE_ENV=production senaryolarını da
 * simüle ettiğinden burada NODE_ENV'e bakan bir korumaya kasıtlı olarak
 * yer verilmemiştir). Uygulama kodunun hiçbir yerinden çağrılmaz.
 */
export function resetEnvCacheForTests(): void {
  cached = null;
}
