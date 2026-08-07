/**
 * YF-512 — Merkezi, fail-safe redaction. Herhangi bir monitoring olayına
 * (hata context'i, breadcrumb, güvenlik olayı metadata'sı) eklenmeden önce
 * bu fonksiyondan geçirilmelidir. Anahtar tabanlı eşleşme büyük/küçük harf
 * duyarsızdır ve iç içe nesneler/dizilerde özyinelemeli çalışır; ayrıca
 * serbest metin içine gömülmüş bağlantı dizeleri/Bearer token'lar için
 * değer tabanlı bir ikinci savunma katmanı içerir (savunma amaçlı — çağıran
 * taraflar zaten ham sır geçirmemelidir, ama bu son bir güvenlik ağıdır).
 */
const SENSITIVE_KEY_PATTERN =
  /pass(word|hash)?|secret|token|authorization|auth[-_]?header|cookie|session|smtp[-_]?(user|pass)|api[-_]?key|database[-_]?url|connection[-_]?string/i;

const CONNECTION_STRING_PATTERN = /\b(postgres(ql)?|rediss?|smtps?):\/\/[^\s"'<>]+/gi;
const BEARER_TOKEN_PATTERN = /\bBearer\s+[A-Za-z0-9\-._~+/]+=*/gi;

const MAX_DEPTH = 6;

function redactString(value: string): string {
  return value.replace(CONNECTION_STRING_PATTERN, "$1://[redacted]").replace(BEARER_TOKEN_PATTERN, "Bearer [redacted]");
}

/** Bilinen hassas alanları ve gömülü bağlantı dizesi/Bearer token örüntülerini `[redacted]` ile değiştirilmiş bir kopya döner. Girdiyi asla mutasyona uğratmaz. */
export function redact<T>(value: T, depth = 0): T {
  if (depth > MAX_DEPTH) return "[redacted:max-depth]" as unknown as T;
  if (value === null || value === undefined) return value;

  if (typeof value === "string") return redactString(value) as unknown as T;
  if (typeof value !== "object") return value;

  if (Array.isArray(value)) {
    return value.map((item) => redact(item, depth + 1)) as unknown as T;
  }

  if (value instanceof Date) return value;

  const out: Record<string, unknown> = {};
  for (const [key, entryValue] of Object.entries(value as Record<string, unknown>)) {
    out[key] = SENSITIVE_KEY_PATTERN.test(key) ? "[redacted]" : redact(entryValue, depth + 1);
  }
  return out as unknown as T;
}
