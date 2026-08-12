import { db } from "@/lib/db";
import { forbidden } from "@/server/services/errors";
import { canViewOrganizationSettings } from "@/lib/permissions";
import {
  checkCapability,
  checkLimit,
  computeUsageStatus,
  type UsageWarningState,
} from "@/lib/entitlements/entitlement-service";
import { getAiQuotaPeriodStart, getAiQuotaPeriodEnd } from "@/lib/ai/quota-period";
import type { SessionUser } from "@/lib/auth/session";

/** Geriye dönük uyum için ayrı bir isim — `lib/entitlements/entitlement-service.ts` `UsageWarningState` ile AYNI değer kümesi. */
export type AiUsageWarningState = UsageWarningState;

export interface AiUsageSummary {
  enabled: boolean;
  /** Etkin toplam kota (dahil + ek/top-up) — YF-803. `null` = sınırsız. */
  monthlyQuota: number | null;
  /** Yalnızca plandan gelen dahil kota — bkz. `checkLimit` `includedMax`. */
  includedQuota: number | null;
  /** Geçerli ek/top-up kota (bkz. `UsageAddonGrant`) — YF-813'ün satın alma akışı bunu artıracak, bu görev yalnızca okuma/kompozisyonu kurar. */
  addonQuota: number;
  creditsUsed: number;
  creditsRemaining: number | null;
  /** `null` yalnızca kota sınırsızsa (`monthlyQuota === null`). */
  usagePercentage: string | null;
  warningState: AiUsageWarningState;
  periodStart: Date;
  periodEnd: Date;
}

/**
 * YF-711 — OWNER/ADMIN için salt-okunur AI kullanım özeti. Merkezi
 * entitlement katmanının (bkz. lib/entitlements/entitlement-service.ts)
 * `checkCapability`/`checkLimit`'ini reuse eder — bu ikisi zaten
 * `lib/entitlements/ai-quota-usage.ts` üzerinden aynı, tek "kullanım"
 * tanımını okur (bkz. checkLimit'in `ai.monthly_quota` case'i). YF-803 —
 * `checkLimit` artık `UsageAddonGrant` top-up'larını da otomatik olarak
 * `max`'a dahil eder; bu fonksiyon yalnızca dahil/ek kırılımını (`includedQuota`/
 * `addonQuota`) şeffaflık için ayrıca yüzeye çıkarır. Bu fonksiyon YF-709'un
 * ileride tüketebileceği temiz bir gözlemlenebilirlik kancasıdır — tam bir
 * gösterge panosu BURADA kurulmaz.
 */
async function computeAiUsageSummary(organizationId: string): Promise<AiUsageSummary> {
  const now = new Date();
  const periodStart = getAiQuotaPeriodStart(now);
  const periodEnd = getAiQuotaPeriodEnd(periodStart);

  const [capability, limit] = await Promise.all([
    checkCapability(db, organizationId, "ai.features"),
    checkLimit(db, organizationId, "ai.monthly_quota"),
  ]);

  const { usagePercentage, warningState } = computeUsageStatus(limit.max, limit.used);

  return {
    enabled: capability.allowed,
    monthlyQuota: limit.max,
    includedQuota: limit.includedMax,
    addonQuota: limit.addonMax,
    creditsUsed: limit.used,
    creditsRemaining: limit.remaining,
    usagePercentage,
    warningState,
    periodStart,
    periodEnd,
  };
}

export async function getAiUsageSummary(actor: SessionUser): Promise<AiUsageSummary> {
  if (!canViewOrganizationSettings(actor.role)) throw forbidden();
  return computeAiUsageSummary(actor.organizationId);
}

/**
 * YF-818 — Platform Admin karşılığı: tenant rol kontrolü YOKTUR (çağıran
 * taraf zaten `requirePlatformAdmin()` ile yetkilendirilmiştir), doğrudan
 * `organizationId` alır. AYNI `computeAiUsageSummary`i kullanır — ikinci bir
 * kota hesaplama yolu İCAT EDİLMEZ (bkz. görev talimatı "do not create a
 * second usage ledger").
 */
export async function getAiUsageSummaryById(organizationId: string): Promise<AiUsageSummary> {
  return computeAiUsageSummary(organizationId);
}
