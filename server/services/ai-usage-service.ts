import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { forbidden } from "@/server/services/errors";
import { canViewOrganizationSettings } from "@/lib/permissions";
import { checkCapability, checkLimit } from "@/lib/entitlements/entitlement-service";
import { getAiQuotaPeriodStart, getAiQuotaPeriodEnd } from "@/lib/ai/quota-period";
import type { SessionUser } from "@/lib/auth/session";

const WARNING_THRESHOLD_RATIO = new Prisma.Decimal("0.8");

export type AiUsageWarningState = "NORMAL" | "WARNING" | "EXHAUSTED";

export interface AiUsageSummary {
  enabled: boolean;
  monthlyQuota: number | null;
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
 * tanımını okur (bkz. checkLimit'in `ai.monthly_quota` case'i). Bu fonksiyon
 * YF-709'un ileride tüketebileceği temiz bir gözlemlenebilirlik kancasıdır —
 * tam bir gösterge panosu BURADA kurulmaz.
 */
export async function getAiUsageSummary(actor: SessionUser): Promise<AiUsageSummary> {
  if (!canViewOrganizationSettings(actor.role)) throw forbidden();

  const organizationId = actor.organizationId;
  const now = new Date();
  const periodStart = getAiQuotaPeriodStart(now);
  const periodEnd = getAiQuotaPeriodEnd(periodStart);

  const [capability, limit] = await Promise.all([
    checkCapability(db, organizationId, "ai.features"),
    checkLimit(db, organizationId, "ai.monthly_quota"),
  ]);

  const usagePercentage =
    limit.max === null
      ? null
      : limit.max === 0
        ? new Prisma.Decimal(limit.used > 0 ? 100 : 0).toFixed(2)
        : new Prisma.Decimal(limit.used).div(limit.max).mul(100).toFixed(2);

  const warningState: AiUsageWarningState =
    limit.max === null
      ? "NORMAL"
      : limit.used >= limit.max
        ? "EXHAUSTED"
        : new Prisma.Decimal(limit.used).greaterThanOrEqualTo(new Prisma.Decimal(limit.max).mul(WARNING_THRESHOLD_RATIO))
          ? "WARNING"
          : "NORMAL";

  return {
    enabled: capability.allowed,
    monthlyQuota: limit.max,
    creditsUsed: limit.used,
    creditsRemaining: limit.remaining,
    usagePercentage,
    warningState,
    periodStart,
    periodEnd,
  };
}
