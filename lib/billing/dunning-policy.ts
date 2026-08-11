import type { Prisma, PrismaClient } from "@prisma/client";
import { forbidden } from "@/server/services/errors";

/**
 * YF-814 — başarısız (recurring) ödeme sonrası ödeme çözüm/erişim
 * politikasının TEK kaynağı.
 *
 * ## Ürün politikası: grace period süresi
 *
 * `GRACE_PERIOD_DURATION_DAYS` — Stripe'ın KENDİ akıllı yeniden deneme
 * (smart retries) takviminden BAĞIMSIZ, YapiFin'in KENDİ ürün politikasıdır
 * (görev talimatı "YapiFin remains authoritative for product policy such as
 * grace duration"). Mevcut bir iş kuralı bulunmadığından makul bir varsayılan
 * seçildi (7 gün) — TEK, açıkça belgelenmiş bir sabit (bkz.
 * `lib/billing/dispute-policy.ts` `DISPUTE_LOST_RESTRICTS_BILLING` İLE AYNI
 * "uydurma bir feature-flag sistemi İCAT EDİLMEZ" ilkesi). Değiştirilmesi
 * gerekirse TEK değişiklik noktası burasıdır.
 *
 * ## Neden mutlak zaman damgaları, neden denormalize bir "durum" alanı YOK
 *
 * `OrganizationStripeSubscription.delinquentSince`/`gracePeriodEndsAt`
 * MUTLAK zaman damgalarıdır (görev talimatı "prefer storing absolute
 * timestamps"). `computePaymentFailureState` bu iki damgayı ÇAĞRI ANINDAKİ
 * saat ile karşılaştırarak durumu HER SEFERİNDE yeniden hesaplar — Stripe'ın
 * o anki gerçeğini yansıtan bir webhook/mutabakat GELMESİNİ BEKLEMEDEN, grace
 * süresi dolduğu ANDA erişim kısıtlaması YÜRÜRLÜĞE girer (bkz.
 * `hasActiveDunningRestriction`). `lib/billing/dispute-policy.ts`in
 * `riskState` ile AYNI ilke: hiçbir yerde önbelleğe alınmış bir "kısıtlı mı"
 * bayrağı İCAT EDİLMEZ.
 *
 * ## Bölüm (episode) yakınsaması
 *
 * `openDunningEpisode`/`clearDunningEpisode` SAF (pure) ve İDEMPOTENTTİR:
 * zaten açık bir bölüm varsa `openDunningEpisode` `gracePeriodEndsAt`'i ASLA
 * ileri TAŞIMAZ (görev talimatı "repeated failures must not keep extending
 * grace forever" / "retries during the same delinquency episode should
 * converge deterministically") — tek uygulama noktası
 * `server/services/billing/webhook-service.ts` `reconcileDunningState`'tir,
 * HER ZAMAN Stripe'tan YENİDEN ÇEKİLEN (refetch-on-write) abonelik
 * durumuna göre çağrılır; hangi webhook OLAYININ (veya mutabakatın)
 * tetiklediği ÖNEMLİ DEĞİLDİR (bkz. o dosyanın dosya başı notuyla AYNI
 * strateji) — bu da sıra-dışı (out-of-order) bir olayın ASLA kurtarılmış bir
 * organizasyonu yanlışlıkla yeniden kısıtlayamamasını (veya tam tersini)
 * garanti eder.
 *
 * ## Neden `lib/entitlements/entitlement-service.ts` içinde DEĞİL
 *
 * `lib/billing/dispute-policy.ts` dosya başı notuYLA AYNI gerekçe:
 * entitlement çekirdeği ödeme sağlayıcısından TAMAMEN BAĞIMSIZDIR. Bu
 * politika, `assertCapability`/`assertWithinLimit*`i SARMALAYAN merkezi
 * kısıtlama kapısına (`lib/billing/billing-restriction-policy.ts`)
 * `hasActiveDisputeRestriction` İLE BİRLİKTE beslenir — çağrı noktaları
 * DEĞİŞMEZ (bkz. o dosyanın dosya başı notu).
 */
export const GRACE_PERIOD_DURATION_DAYS = 7;
const GRACE_PERIOD_DURATION_MS = GRACE_PERIOD_DURATION_DAYS * 24 * 60 * 60 * 1000;

type Tx = Prisma.TransactionClient;
type Client = PrismaClient | Tx;

export type PaymentFailureState = "NONE" | "GRACE_PERIOD" | "RESTRICTED";

export interface DunningTimestamps {
  readonly delinquentSince: Date | null;
  readonly gracePeriodEndsAt: Date | null;
}

export interface DunningState extends DunningTimestamps {
  readonly recoveredAt: Date | null;
}

/**
 * Verilen mutlak zaman damgalarını ÇAĞRI ANINDAKİ (`now`) saat ile
 * karşılaştırarak GÜNCEL ödeme başarısızlığı durumunu hesaplar — saf
 * (pure), yan etkisiz, deterministik (bkz. dosya başı "denormalize bir
 * durum alanı YOK" notu). `now` her zaman AÇIKÇA geçilir (saat/saat dilimi
 * davranışının deterministik test edilebilmesi için, görev talimatı
 * "clock/time-zone behavior must be deterministic and tested").
 */
export function computePaymentFailureState(row: DunningTimestamps, now: Date): PaymentFailureState {
  if (!row.delinquentSince || !row.gracePeriodEndsAt) return "NONE";
  return now.getTime() < row.gracePeriodEndsAt.getTime() ? "GRACE_PERIOD" : "RESTRICTED";
}

/**
 * Açık bir gecikme bölümü YOKSA yeni bir bölüm başlatır (`delinquentSince`
 * ve donmuş `gracePeriodEndsAt`). ZATEN açık bir bölüm varsa boş bir
 * yama (`{}`) döner — İDEMPOTENT no-op (bkz. dosya başı "bölüm yakınsaması"
 * notu — tekrarlanan başarısız denemeler grace süresini ASLA UZATMAZ).
 */
export function openDunningEpisode(row: DunningState, now: Date): Partial<DunningState> {
  if (row.delinquentSince) return {};
  return { delinquentSince: now, gracePeriodEndsAt: new Date(now.getTime() + GRACE_PERIOD_DURATION_MS) };
}

/**
 * Açık bir gecikme bölümünü kapatır (`recoveredAt` damgalanır). Açık bir
 * bölüm YOKSA boş bir yama döner — İDEMPOTENT no-op (rutin/zaten-sağlıklı bir
 * yenileme ödemesinde `recoveredAt` GEREKSİZ YERE güncellenmez, bkz.
 * `recoveredAt` alan yorumu).
 */
export function clearDunningEpisode(row: DunningState, now: Date): Partial<DunningState> {
  if (!row.delinquentSince) return {};
  return { delinquentSince: null, gracePeriodEndsAt: null, recoveredAt: now };
}

/**
 * Bir organizasyonun GÜNCEL faturalama kısıtlaması olup olmadığını CANLI
 * sorgular — `lib/billing/dispute-policy.ts` `hasActiveDisputeRestriction`
 * İLE AYNI ilke (her çağrı güncel durumu DB'den taze okur, mutlak zaman
 * damgalarını GÜNCEL saatle karşılaştırır).
 */
export async function hasActiveDunningRestriction(client: Client, organizationId: string): Promise<boolean> {
  const row = await client.organizationStripeSubscription.findUnique({
    where: { organizationId },
    select: { delinquentSince: true, gracePeriodEndsAt: true },
  });
  if (!row) return false;
  return computePaymentFailureState(row, new Date()) === "RESTRICTED";
}

export const DUNNING_RESTRICTION_MESSAGE =
  "Son ödeme deneminiz başarısız oldu ve ödeme çözüm süreniz (grace period) sona erdi. Mevcut verileriniz etkilenmez; bu işlem faturalama bilgileriniz güncellenip ödeme onaylanana kadar geçici olarak kısıtlandı.";

/**
 * Kısıtlıysa Türkçe, kullanıcıya gösterilebilir bir `ServiceError`
 * (`FORBIDDEN`) fırlatır. `lib/billing/dispute-policy.ts`
 * `assertNotBillingRestricted` İLE AYNI kullanım disiplini: yalnızca YENİ
 * ücretli kaynak OLUŞTURAN çağrı noktalarında kullanılmalıdır — bu fonksiyon
 * doğrudan ÇAĞRILMAZ, bunun yerine `lib/billing/billing-restriction-policy.ts`
 * `assertNotBillingRestricted` (dispute + dunning KOMPOZİSYONU) çağrılır.
 */
export async function assertNotDunningRestricted(client: Client, organizationId: string): Promise<void> {
  if (await hasActiveDunningRestriction(client, organizationId)) {
    throw forbidden(DUNNING_RESTRICTION_MESSAGE);
  }
}
