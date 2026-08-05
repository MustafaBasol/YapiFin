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
});

export type RawEnv = z.infer<typeof rawEnvSchema>;

export interface SmtpConfig {
  host: string;
  port: number;
  from: string;
  auth: { user: string; password: string } | null;
}

export interface Env {
  NODE_ENV: RawEnv["NODE_ENV"];
  DATABASE_URL: string;
  AUTH_SECRET: string;
  NEXT_PUBLIC_APP_URL: string;
  NEXT_PUBLIC_APP_NAME: string;
  /** SMTP tam olarak yapılandırılmışsa dolu; aksi halde null (yalnızca development/test'te null olabilir). */
  smtp: SmtpConfig | null;
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

  return Object.freeze({
    NODE_ENV: data.NODE_ENV,
    DATABASE_URL: data.DATABASE_URL,
    AUTH_SECRET: data.AUTH_SECRET,
    NEXT_PUBLIC_APP_URL: data.NEXT_PUBLIC_APP_URL,
    NEXT_PUBLIC_APP_NAME: data.NEXT_PUBLIC_APP_NAME,
    smtp: smtp ? Object.freeze(smtp) : null,
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
