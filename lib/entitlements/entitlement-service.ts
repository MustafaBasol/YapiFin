import { Prisma, type PrismaClient } from "@prisma/client";
import { forbidden, conflict, notFound } from "@/server/services/errors";
import {
  isCapabilityId,
  isLimitId,
  type CapabilityId,
  type LimitId,
} from "@/lib/entitlements/capabilities";
import { getCurrentPeriodAiCreditsUsed } from "@/lib/entitlements/ai-quota-usage";
import { getCurrentPeriodOcrExtractionsUsed } from "@/lib/entitlements/ocr-quota-usage";
import { getActiveAddonQuota } from "@/lib/entitlements/usage-addons";

/**
 * YF-802 — Merkezi entitlement (plan yeteneği/kota) servisi.
 *
 * Bu, "bu organizasyon X'i yapabilir mi?" (ikili yetenek) ve "Y kotasının
 * ne kadarı kullanıldı/izin veriliyor?" (nicel limit) sorularının TEK
 * cevap kaynağıdır. Hiçbir domain servisi (`server/services/*`) plan
 * kodunu (`"pro"`, `"starter"` vb.) doğrudan KARŞILAŞTIRMAZ — yalnızca bu
 * modülün dışa açtığı fonksiyonları çağırır (bkz. görev talimatı "Does NOT
 * hardcode pricing anywhere in domain services").
 *
 * Güvenlik tabanı bu modülden GEÇMEZ: kimlik doğrulama/oturum, tenant
 * izolasyonu, audit log, yedekleme/veri bütünlüğü ve finansal Decimal
 * doğruluğu asla bir Plan alanıyla kapatılamaz — bu dosya yalnızca ticari
 * modül/kota sınırlamalarını yanıtlar, hiçbir güvenlik kontrolünün YERİNE
 * geçmez (mevcut `lib/permissions.ts` rol kontrolleri bu servisten önce/
 * bağımsız olarak çalışmaya devam eder).
 *
 * Fail-closed ilkesi (görev talimatı "must return not entitled, never
 * silently allow"):
 *   - `CAPABILITY_IDS`'te olmayan bir capability kimliği HER ZAMAN reddedilir.
 *   - Bir organizasyonun etkin planı yoksa (silinmiş/atanmamış/pasif) HİÇBİR
 *     yetenek/kota izin vermez (limit = 0, capability = false).
 *   - Plan'ın `limits` JSON'unda bir limit kimliği hiç YOKSA (anahtar
 *     tanımsız) 0 kabul edilir — yalnızca AÇIKÇA `null` değeri sınırsız
 *     anlamına gelir. Bozuk/negatif bir değer de 0'a düşer.
 *
 * Yükseltme/düşürme semantiği özel kod GEREKTİRMEZ: her çağrı güncel
 * kullanım (DB COUNT) ile güncel planın limitini karşılaştırır — plan
 * değiştiğinde bir sonraki çağrı otomatik olarak yeni sınırı görür.
 * Düşürmede mevcut kayıtlar asla silinmez/gizlenmez (`isOverLimit` alanı
 * çağırana "zaten limit üstü" durumunu açıkça bildirir), yalnızca YENİ
 * oluşturma bir sonraki `assertWithinLimit*` çağrısında engellenir.
 */

type Tx = Prisma.TransactionClient;
/** Yalnızca okuma amaçlı fonksiyonlar hem işlem dışı `db` hem de bir `tx` ile çağrılabilir. */
type Client = PrismaClient | Tx;

export interface EffectivePlan {
  id: string;
  code: string;
  name: string;
  capabilities: Record<string, unknown>;
  limits: Record<string, unknown>;
}

/** Plan atanmamış/pasif/silinmiş organizasyonlar için fail-closed sentinel. */
const NO_PLAN: EffectivePlan = {
  id: "__no_plan__",
  code: "NONE",
  name: "Plansız",
  capabilities: {},
  limits: {},
};

/** Organizasyonun güncel etkin planını okur. Her zaman DB'den taze okunur — hiçbir yerde önbelleğe alınmaz (plan değişikliği anında yansımalıdır, bkz. yükseltme semantiği). */
export async function getEffectivePlan(client: Client, organizationId: string): Promise<EffectivePlan> {
  const org = await client.organization.findUnique({
    where: { id: organizationId },
    select: { plan: true },
  });
  if (!org || !org.plan || !org.plan.isActive) return NO_PLAN;

  const plan = org.plan;
  return {
    id: plan.id,
    code: plan.code,
    name: plan.name,
    capabilities: (plan.capabilities as Record<string, unknown>) ?? {},
    limits: (plan.limits as Record<string, unknown>) ?? {},
  };
}

export interface CapabilityCheckResult {
  capability: string;
  allowed: boolean;
  planCode: string;
}

/**
 * İkili modül/özellik erişimi kontrolü. Bilinmeyen bir `capabilityId`
 * (örn. yazım hatası veya henüz tanımlanmamış bir kimlik) HER ZAMAN
 * reddedilir — bu kontrol `CAPABILITY_IDS` listesine karşı yapılır ve
 * Plan verisinden bağımsızdır (fail-closed, bkz. modül başı yorum).
 */
/**
 * Bir `EffectivePlan`in belirli bir yeteneği içerip içermediğini çözer —
 * `checkCapability`'den çıkarılmıştır ki YF-805 plan karşılaştırma ekranı
 * (bkz. server/services/plan-comparison-service.ts), org'un GÜNCEL etkin
 * planından bağımsız olarak kanonik dört planın (Starter/Professional/
 * Business/Enterprise) her biri için AYNI "=== true" fail-closed formülünü
 * kullanabilsin — mantık iki yerde AYRI AYRI tanımlanmaz (bkz. yukarıdaki
 * `resolveLimitMax` için aynı gerekçe).
 */
export function resolveCapabilityValue(plan: EffectivePlan, capabilityId: CapabilityId): boolean {
  return plan.capabilities[capabilityId] === true;
}

export async function checkCapability(
  client: Client,
  organizationId: string,
  capabilityId: string,
): Promise<CapabilityCheckResult> {
  if (!isCapabilityId(capabilityId)) {
    return { capability: capabilityId, allowed: false, planCode: "UNKNOWN" };
  }
  const plan = await getEffectivePlan(client, organizationId);
  const allowed = resolveCapabilityValue(plan, capabilityId);
  return { capability: capabilityId, allowed, planCode: plan.code };
}

export async function canUseCapability(
  client: Client,
  organizationId: string,
  capabilityId: string,
): Promise<boolean> {
  return (await checkCapability(client, organizationId, capabilityId)).allowed;
}

/** Yetenek yoksa Türkçe, kullanıcıya gösterilebilir bir `ServiceError` (`FORBIDDEN`) fırlatır. */
export async function assertCapability(
  client: Client,
  organizationId: string,
  capabilityId: CapabilityId,
  message?: string,
) {
  const result = await checkCapability(client, organizationId, capabilityId);
  if (!result.allowed) {
    throw forbidden(message ?? "Bu özellik mevcut planınızda yer almıyor. Planınızı yükseltmeniz gerekir.");
  }
  return result;
}

export interface LimitCheckResult {
  limit: string;
  /** Etkin toplam üst sınır — `includedMax + addonMax` (YF-803). `null` = sınırsız. Tüm engelleme kararları (`canAddOne`/`isOverLimit`/`remaining`) BUNA göre hesaplanır. */
  max: number | null;
  /** Yalnızca plandan gelen dahil kota — bkz. `resolveLimitMax`. `null` = sınırsız (bu durumda `addonMax` her zaman 0'dır, ek kota anlamsızdır). */
  includedMax: number | null;
  /** Geçerli (süresi dolmamış/henüz başlamamış olmayan) `UsageAddonGrant` toplamı — bkz. `lib/entitlements/usage-addons.ts` `getActiveAddonQuota`. */
  addonMax: number;
  used: number;
  /** `null` = sınırsız. */
  remaining: number | null;
  /** Mevcut kullanım, güncel etkin üst sınırı ZATEN aşıyor mu (ör. plan düşürüldü/bağış süresi doldu). Bilgilendirme amaçlıdır — engelleme kararı `canAddOne`'dadır. */
  isOverLimit: boolean;
  /** Bir kayıt daha eklenebilir mi. */
  canAddOne: boolean;
  planCode: string;
}

/**
 * YF-805 — plan karşılaştırma ekranı (bkz. lib/plan-presentation.ts) da bu
 * TEK etiket kaynağını reuse eder; kimlik başına ikinci bir Türkçe etiket
 * seti tanımlanmaz.
 */
export const LIMIT_LABELS: Record<LimitId, string> = {
  "users.active": "aktif kullanıcı",
  "projects.active": "aktif proje",
  "ai.monthly_quota": "aylık yapay zekâ kullanımı",
  "ocr.monthly_quota": "aylık OCR/belge çıkarım kullanımı",
};

/**
 * Bir kota kimliğinin GÜNCEL kullanımını sayar. Yeni bir limit eklerken
 * yalnızca burada bir `case` eklenir — çağrı noktaları (`createProject`,
 * `acceptInvitation` vb.) DEĞİŞMEZ (bkz. görev talimatı "adding a new
 * quantitative limit later doesn't require touching call sites").
 */
async function countUsage(client: Client, organizationId: string, limitId: LimitId): Promise<number> {
  switch (limitId) {
    case "users.active":
      return client.user.count({ where: { organizationId, status: "ACTIVE" } });
    case "projects.active":
      // "Aktif" = arşivlenmemiş: DRAFT/ACTIVE/ON_HOLD/COMPLETED sayılır,
      // yalnızca CANCELLED (bu kod tabanının "silme yerine iptal" ilkesiyle
      // aynı, bkz. docs/architecture) hariç tutulur — aksi halde bir
      // organizasyon yalnızca DRAFT projeler oluşturarak limiti anlamsız
      // kılabilirdi.
      return client.project.count({ where: { organizationId, status: { not: "CANCELLED" } } });
    case "ai.monthly_quota":
      // YF-711 — gerçek kullanım: geçerli dönemde kesinleşen (COMMITTED) +
      // hâlâ aktif (süresi dolmamış) rezerve edilen kredilerin toplamı,
      // bkz. lib/entitlements/ai-quota-usage.ts (tek kaynak — atomik
      // rezervasyon yolu da aynı fonksiyonu çağırır, bkz.
      // server/services/ai-usage-reporting-service.ts).
      return getCurrentPeriodAiCreditsUsed(client, organizationId);
    case "ocr.monthly_quota":
      // YF-817 — gerçek kullanım: geçerli UTC takvim ayında tamamlanmış
      // (EXTRACTED/FAILED/CONFIRMING/CONFIRMED) TÜM kayıtlar + hâlâ TAZE
      // (terk edilmemiş) PENDING kayıtların sayısı, bkz.
      // lib/entitlements/ocr-quota-usage.ts (tek kaynak). Atomik
      // uygulama noktası `assertWithinLimitAtomic` üzerinden
      // server/services/document-extraction-service.ts
      // `uploadAndExtractDocument`'tadır (createProject/acceptInvitation
      // ile AYNI, kanıtlanmış organizasyon-satır-kilidi deseni).
      return getCurrentPeriodOcrExtractionsUsed(client, organizationId);
    default: {
      const exhaustiveCheck: never = limitId;
      return exhaustiveCheck;
    }
  }
}

/**
 * Bir `EffectivePlan`den tek bir nicel limitin sayısal üst sınırını çözer —
 * `checkLimit`'ten çıkarılmıştır ki YF-711'in atomik rezervasyon işlemi
 * (bkz. server/services/ai-usage-reporting-service.ts) AYNI fail-closed
 * ayrıştırma mantığını, kendi (dışlamalı) kullanım hesaplamasıyla
 * birleştirerek yeniden kullanabilsin — mantık iki yerde AYRI AYRI
 * tanımlanmaz.
 */
export function resolveLimitMax(plan: EffectivePlan, limitId: LimitId): number | null {
  const hasKey = Object.prototype.hasOwnProperty.call(plan.limits, limitId);
  const rawMax = plan.limits[limitId];

  if (!hasKey) {
    // Plan verisinde bu limit için hiç anahtar yok (veya plan yok) -> fail-closed.
    return 0;
  }
  if (rawMax === null) {
    // Açıkça `null` -> sınırsız.
    return null;
  }
  if (typeof rawMax === "number" && Number.isFinite(rawMax) && rawMax >= 0) {
    return rawMax;
  }
  // Bozuk/negatif bir değer -> fail-closed.
  return 0;
}

export interface EffectiveLimitMax {
  /** `includedMax + addonMax` — `includedMax` sınırsızsa (`null`) her zaman `null`. */
  max: number | null;
  includedMax: number | null;
  addonMax: number;
}

/**
 * YF-803 — `resolveLimitMax` (plan dahil kotası) ile `UsageAddonGrant`
 * toplamını (bkz. `lib/entitlements/usage-addons.ts` `getActiveAddonQuota`)
 * birleştirir: "available = included allowance + valid add-on allowance -
 * consumed" formülünün "included + add-on" kısmı. Plan sınırsızsa (`null`)
 * ek kota HİÇ sorgulanmaz — sınırsız zaten sınırsızdır, add-on anlamsızdır.
 *
 * Zaten çözümlenmiş bir `plan` varsa (ör. `ai-usage-reporting-service.ts`
 * `checkQuota`, aynı Serializable transaction içinde kilitli organizasyon
 * satırı üzerinden) tekrar `getEffectivePlan` çağrılmasın diye isteğe bağlı
 * `plan` parametresiyle geçirilebilir — bu, add-on okumasının da AYNI
 * transaction/tutarlı anlık görüntü içinde kalmasını sağlar (atomicity
 * bozulmaz).
 */
export async function resolveEffectiveLimitMax(
  client: Client,
  organizationId: string,
  limitId: LimitId,
  plan?: EffectivePlan,
): Promise<EffectiveLimitMax> {
  const effectivePlan = plan ?? (await getEffectivePlan(client, organizationId));
  const includedMax = resolveLimitMax(effectivePlan, limitId);
  if (includedMax === null) {
    return { max: null, includedMax: null, addonMax: 0 };
  }
  const addonMax = await getActiveAddonQuota(client, organizationId, limitId);
  return { max: includedMax + addonMax, includedMax, addonMax };
}

/**
 * Bilinmeyen bir `limitId` için de fail-closed davranır (max=0, canAddOne=false) —
 * `isLimitId` listesine karşı kontrol edilir, Plan verisinden bağımsızdır.
 */
export async function checkLimit(client: Client, organizationId: string, limitId: string): Promise<LimitCheckResult> {
  if (!isLimitId(limitId)) {
    return {
      limit: limitId,
      max: 0,
      includedMax: 0,
      addonMax: 0,
      used: 0,
      remaining: 0,
      isOverLimit: false,
      canAddOne: false,
      planCode: "UNKNOWN",
    };
  }

  const plan = await getEffectivePlan(client, organizationId);
  const { max, includedMax, addonMax } = await resolveEffectiveLimitMax(client, organizationId, limitId, plan);
  const used = await countUsage(client, organizationId, limitId);
  const remaining = max === null ? null : Math.max(max - used, 0);
  const isOverLimit = max !== null && used > max;
  const canAddOne = max === null || used < max;

  return { limit: limitId, max, includedMax, addonMax, used, remaining, isOverLimit, canAddOne, planCode: plan.code };
}

function defaultLimitMessage(limitId: LimitId, result: LimitCheckResult): string {
  const label = LIMIT_LABELS[limitId] ?? limitId;
  if (result.max === 0) {
    return `Mevcut planınız (${result.planCode}) herhangi bir ${label} eklemeye izin vermiyor. Devam etmek için planınızı yükseltin.`;
  }
  return `Planınızın izin verdiği ${label} sayısına (${result.max}) ulaştınız. Yeni eklemek için planınızı yükseltmeniz gerekir.`;
}

/**
 * Kota doluysa Türkçe, kullanıcıya gösterilebilir bir `ServiceError`
 * (`CONFLICT`) fırlatır; doluysa değilse `LimitCheckResult`'ı döner
 * (çağıran `isOverLimit`'i UI'da/loglarda kullanabilir). Eşzamanlılık
 * garantisi İSTEYEN çağrı noktaları bunun yerine `assertWithinLimitAtomic`
 * kullanmalıdır (bkz. aşağıda).
 */
export async function assertWithinLimit(
  client: Client,
  organizationId: string,
  limitId: LimitId,
  message?: string,
): Promise<LimitCheckResult> {
  const result = await checkLimit(client, organizationId, limitId);
  if (!result.canAddOne) {
    throw conflict(message ?? defaultLimitMessage(limitId, result));
  }
  return result;
}

/**
 * Bir transaction içinde organizasyon satırını kilitler (`SELECT ... FOR
 * UPDATE`) — bu kod tabanındaki mevcut satır-kilidi deseniyle AYNIDIR
 * (bkz. server/services/ledger.ts lockAccount/lockBankImportRow). İki
 * eşzamanlı istek aynı organizasyon için "son boş koltuğu" yarışırken,
 * ikinci istek birincinin commit/rollback'i tamamlanana kadar burada
 * bloklanır; böylece `checkLimit`'in okuduğu COUNT asla aynı anda iki kez
 * "boş" görmez (plain `db.$transaction` + count-then-insert TEK BAŞINA bu
 * garantiyi READ COMMITTED altında VERMEZ).
 */
export async function lockOrganizationForEntitlement(tx: Tx, organizationId: string): Promise<void> {
  const rows = await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM "Organization" WHERE id = ${organizationId} FOR UPDATE
  `;
  if (rows.length === 0) throw notFound("Organizasyon bulunamadı");
}

/**
 * `assertWithinLimit`'in eşzamanlılığa karşı güvenli sürümü. Çağıran
 * BUNU `db.$transaction(async (tx) => { ... })` İÇİNDEN, sayılan kaydı
 * (User/Project) oluşturmadan HEMEN ÖNCE çağırmalıdır — bkz.
 * server/services/project-service.ts createProject,
 * server/services/invitation-service.ts acceptInvitation.
 */
export async function assertWithinLimitAtomic(
  tx: Tx,
  organizationId: string,
  limitId: LimitId,
  message?: string,
): Promise<LimitCheckResult> {
  await lockOrganizationForEntitlement(tx, organizationId);
  return assertWithinLimit(tx, organizationId, limitId, message);
}

/** Testler/gelecekteki bir "plan ve kullanım" ekranı için: tüm bilinen limitlerin güncel durumunu döner. */
export async function getOrganizationLimitSummary(
  client: Client,
  organizationId: string,
): Promise<Record<LimitId, LimitCheckResult>> {
  const [users, projects, ai, ocr] = await Promise.all([
    checkLimit(client, organizationId, "users.active"),
    checkLimit(client, organizationId, "projects.active"),
    checkLimit(client, organizationId, "ai.monthly_quota"),
    checkLimit(client, organizationId, "ocr.monthly_quota"),
  ]);
  return {
    "users.active": users,
    "projects.active": projects,
    "ai.monthly_quota": ai,
    "ocr.monthly_quota": ocr,
  };
}

/**
 * YF-711/YF-805/YF-803 — nicel kota kullanımı için TEK, paylaşılan uyarı
 * eşiği. `server/services/ai-usage-service.ts` (AI kullanım özeti) ve
 * `server/services/plan-comparison-service.ts` (plan karşılaştırma ekranı)
 * AYNI %80 eşiğini BURADAN reuse eder — ikinci bir tanım İCAT EDİLMEZ.
 */
export const WARNING_THRESHOLD_RATIO = new Prisma.Decimal("0.8");

export type UsageWarningState = "NORMAL" | "WARNING" | "EXHAUSTED";

export interface UsageStatus {
  /** `null` yalnızca kota sınırsızsa (`max === null`). */
  usagePercentage: string | null;
  warningState: UsageWarningState;
}

/**
 * Bir limitin (`max`/`used` çifti — bkz. `LimitCheckResult`) yeniden
 * kullanılabilir uyarı/tükenme durumunu üretir (görev talimatı "reusable
 * status information for normal/warning(~%80)/exhausted"). Kontrolsüz aşım
 * (overage) davranışı KASITLI OLARAK burada YOKTUR — `used`, `max`'ı aşsa
 * bile bu fonksiyon yalnızca "EXHAUSTED" bildirir, hiçbir ek tüketime izin
 * VERMEZ/ÖNERMEZ (görev talimatı "Default behavior for uncontrolled overage
 * must remain OFF").
 */
export function computeUsageStatus(max: number | null, used: number): UsageStatus {
  if (max === null) {
    return { usagePercentage: null, warningState: "NORMAL" };
  }

  const usagePercentage =
    max === 0
      ? new Prisma.Decimal(used > 0 ? 100 : 0).toFixed(2)
      : new Prisma.Decimal(used).div(max).mul(100).toFixed(2);

  const warningState: UsageWarningState =
    used >= max
      ? "EXHAUSTED"
      : new Prisma.Decimal(used).greaterThanOrEqualTo(new Prisma.Decimal(max).mul(WARNING_THRESHOLD_RATIO))
        ? "WARNING"
        : "NORMAL";

  return { usagePercentage, warningState };
}
