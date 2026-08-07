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
