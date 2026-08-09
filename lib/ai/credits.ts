import { Prisma } from "@prisma/client";
import type { AiMessage, AiUsage } from "@/lib/ai/types";

/**
 * YF-711 — Tek, merkezi AI kredi/rezervasyon politikası. Sağlayıcı/kullanım
 * token sayımından müşteriye yansıyan "AI kredisi" birimine dönüşüm TEK bu
 * dosyada yapılır — hiçbir servis kendi dönüşüm formülünü türetmez (bkz.
 * server/services/ai-usage-reporting-service.ts, yalnızca bu modülü çağırır).
 *
 * `Prisma.Decimal` yalnızca değer tipi olarak kullanılır (bkz.
 * server/services/ledger.ts toDecimal ile aynı desen) — bu dosya `@/lib/db`
 * veya `PrismaClient` içermez, canlı bir veritabanı bağımlılığı YOKTUR;
 * `lib/ai/service.ts`/`runAiCompletion` hâlâ Prisma'dan tamamen bağımsızdır.
 */
export const AI_CREDIT_POLICY = {
  /** 1 AI kredisi kaç token'a karşılık gelir. */
  tokensPerCredit: 100,
  /** Bir çağrı için asgari ücretlendirme — kullanım bilinmese/çok küçük olsa bile. */
  minCreditsPerCall: 1,
  /** Çağıran `maxOutputTokens` belirtmezse rezervasyon için varsayılan, tutucu (conservative) çıktı tavanı. */
  assumedMaxOutputTokensWhenUnbounded: 4096,
  /** Girdi token tahmininde kullanılan tutucu karakter/token oranı — düşük tutulur (=daha fazla tahmini token) ki rezervasyon her zaman bir ÜST sınır olsun. */
  charsPerTokenConservative: 3,
  /** Dahili kredi-maliyet yaklaşıklaması — GERÇEK bir sağlayıcı fiyatlandırması DEĞİLDİR (bkz. AiUsageLedger.estimatedCostUsd doküman notu). */
  usdPerCredit: new Prisma.Decimal("0.01"),
  /** Bir rezervasyonun bayat (stale) sayılmadan önce ne kadar açık kalabileceği — 15sn varsayılan AI zaman aşımına göre bolca pay bırakır (bkz. lib/ai/service.ts DEFAULT_TIMEOUT_MS). */
  reservationTtlMs: 5 * 60 * 1000,
} as const;

function estimateInputTokens(messages: AiMessage[]): number {
  const totalChars = messages.reduce((sum, m) => sum + m.content.length, 0);
  return Math.ceil(totalChars / AI_CREDIT_POLICY.charsPerTokenConservative);
}

/**
 * Sağlayıcı çağrısından ÖNCE, rezervasyon için TUTUCU bir üst sınır üretir.
 * `messages` içeriğini yalnızca karakter UZUNLUĞU için bellek-içi okur —
 * hiçbir yere loglamaz/yazmaz (bkz. görev talimatı "Do not log prompts").
 * `maxOutputTokens` sağlayıcıya olduğu gibi iletildiğinden (bkz.
 * lib/ai/service.ts → lib/ai/types.ts AiCompletionRequest), belirtilmişse
 * gerçek bir üst sınırdır; belirtilmemişse tutucu bir varsayılan kullanılır.
 */
export function estimateReservationCredits(input: { messages: AiMessage[]; maxOutputTokens?: number }): number {
  const inputTokens = estimateInputTokens(input.messages);
  const outputTokensUpperBound = input.maxOutputTokens ?? AI_CREDIT_POLICY.assumedMaxOutputTokensWhenUnbounded;
  const totalTokenUpperBound = inputTokens + outputTokensUpperBound;
  return Math.max(AI_CREDIT_POLICY.minCreditsPerCall, Math.ceil(totalTokenUpperBound / AI_CREDIT_POLICY.tokensPerCredit));
}

/** Gerçek (uncapped) sağlayıcı kullanımından kredi hesaplar — finalize sırasında `reservedCredits` ile sınırlanır (bkz. çağıran kod), bu fonksiyonun kendisi asla sınırlamaz. */
export function tokensToCredits(usage: AiUsage): number {
  const totalTokens = usage.totalTokens ?? 0;
  return Math.max(AI_CREDIT_POLICY.minCreditsPerCall, Math.ceil(totalTokens / AI_CREDIT_POLICY.tokensPerCredit));
}

/** Dahili kredi-maliyet yaklaşıklaması — Decimal, kayan nokta YOK. */
export function creditsToEstimatedCostUsd(credits: number): Prisma.Decimal {
  return AI_CREDIT_POLICY.usdPerCredit.mul(credits);
}
