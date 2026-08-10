import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { forbidden } from "@/server/services/errors";
import { canViewOrganizationSettings } from "@/lib/permissions";
import {
  CAPABILITY_IDS,
  LIMIT_IDS,
  type CapabilityId,
  type LimitId,
} from "@/lib/entitlements/capabilities";
import {
  getEffectivePlan,
  getOrganizationLimitSummary,
  resolveLimitMax,
  resolveCapabilityValue,
  computeUsageStatus,
  type EffectivePlan,
  type UsageWarningState,
} from "@/lib/entitlements/entitlement-service";
import type { SessionUser } from "@/lib/auth/session";

/**
 * YF-805 — Plan/fiyatlandırma karşılaştırma ekranının TEK veri kaynağı.
 *
 * Bilinçli tasarım kararı: `lib/entitlements/plan-defaults.ts`'teki
 * `DEFAULT_PLANS` dizisi BURADA DA import edilmez/okunmaz — o dosyanın kendi
 * belgelediği gibi yalnızca migration/seed türetimi içindir, kod çalışma
 * zamanında planı asla o diziden okumaz. Bu servis de aynı ilkeye uyar: dört
 * kanonik plan (Starter/Professional/Business/Enterprise) her zaman DB'deki
 * `Plan` satırlarından okunur ve limit/yetenek değerleri
 * `lib/entitlements/entitlement-service.ts`'in (YF-802) fail-closed
 * `resolveLimitMax`/`resolveCapabilityValue` fonksiyonlarıyla çözümlenir —
 * ikinci bir yetenek/limit matrisi İCAT EDİLMEZ.
 *
 * Fiyatlandırma: `Plan` modelinde bir fiyat alanı YOK (bkz. prisma/schema.prisma).
 * Bu nedenle `priceMonthlyTl` her zaman `null` döner — arayüz bunu asla bir
 * sayı uydurarak doldurmaz, nötr "iletişime geçin" mesajı gösterir.
 */

const CANONICAL_PLAN_CODE_ORDER = ["STARTER", "PROFESSIONAL", "BUSINESS", "ENTERPRISE"] as const;

export interface PlanLimitInfo {
  /** `null` = sınırsız. */
  max: number | null;
}

export interface PlanComparisonEntry {
  id: string;
  code: string;
  name: string;
  /** Bu, çağıran organizasyonun şu anki etkin planı mı. */
  isCurrent: boolean;
  /**
   * Kanonik plan verisinde (Plan tablosu) bir fiyat alanı olmadığı için
   * her zaman `null` — asla uydurulmuş bir sayı DEĞİLDİR. Arayüz `null`
   * durumunda nötr bir "iletişime geçin" mesajı gösterir.
   */
  priceMonthlyTl: null;
  limits: Record<LimitId, PlanLimitInfo>;
  capabilities: Record<CapabilityId, boolean>;
}

/** `lib/entitlements/entitlement-service.ts` `UsageWarningState` re-export'u — bu ekranın mevcut tüketicileri (bkz. components/app/plan-comparison-view.tsx) buradan import etmeye devam eder. */
export type { UsageWarningState };

export interface CurrentUsageEntry {
  max: number | null;
  used: number;
  remaining: number | null;
  isOverLimit: boolean;
  warningState: UsageWarningState;
}

export interface PlanComparisonResult {
  /** Org'un planı yoksa/pasifse `"NONE"` (bkz. entitlement-service.ts NO_PLAN sentinel). */
  currentPlanCode: string;
  plans: PlanComparisonEntry[];
  currentUsage: Record<LimitId, CurrentUsageEntry>;
}

function toEffectivePlan(row: {
  id: string;
  code: string;
  name: string;
  limits: Prisma.JsonValue;
  capabilities: Prisma.JsonValue;
}): EffectivePlan {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    limits: (row.limits as Record<string, unknown>) ?? {},
    capabilities: (row.capabilities as Record<string, unknown>) ?? {},
  };
}

/**
 * OWNER/ADMIN için: kanonik dört planın limit/yetenek karşılaştırması +
 * çağıranın organizasyonunun güncel planı ve GERÇEK kullanım sayıları
 * (`getOrganizationLimitSummary` — YF-802'de tam bu ekran için hazırlanmış
 * hook). Yetki kontrolü `getAiUsageSummary` (YF-711) ile AYNI role
 * kısıtını kullanır — bu, mevcut "Ayarlar" alanının rol kuralıyla tutarlıdır.
 */
export async function getPlanComparison(actor: SessionUser): Promise<PlanComparisonResult> {
  if (!canViewOrganizationSettings(actor.role)) throw forbidden();

  const organizationId = actor.organizationId;

  const [dbPlans, effectivePlan, limitSummary] = await Promise.all([
    db.plan.findMany({
      where: { code: { in: [...CANONICAL_PLAN_CODE_ORDER] }, isActive: true },
    }),
    getEffectivePlan(db, organizationId),
    getOrganizationLimitSummary(db, organizationId),
  ]);

  const byCode = new Map(dbPlans.map((row) => [row.code, row]));

  const plans: PlanComparisonEntry[] = CANONICAL_PLAN_CODE_ORDER.filter((code) => byCode.has(code)).map((code) => {
    const row = byCode.get(code)!;
    const effective = toEffectivePlan(row);

    const limits = Object.fromEntries(
      LIMIT_IDS.map((limitId) => [limitId, { max: resolveLimitMax(effective, limitId) }]),
    ) as Record<LimitId, PlanLimitInfo>;

    const capabilities = Object.fromEntries(
      CAPABILITY_IDS.map((capabilityId) => [capabilityId, resolveCapabilityValue(effective, capabilityId)]),
    ) as Record<CapabilityId, boolean>;

    return {
      id: row.id,
      code: row.code,
      name: row.name,
      isCurrent: row.id === effectivePlan.id,
      priceMonthlyTl: null,
      limits,
      capabilities,
    };
  });

  const currentUsage = Object.fromEntries(
    LIMIT_IDS.map((limitId) => {
      const result = limitSummary[limitId];
      return [
        limitId,
        {
          max: result.max,
          used: result.used,
          remaining: result.remaining,
          isOverLimit: result.isOverLimit,
          warningState: computeUsageStatus(result.max, result.used).warningState,
        },
      ];
    }),
  ) as Record<LimitId, CurrentUsageEntry>;

  return { currentPlanCode: effectivePlan.code, plans, currentUsage };
}
