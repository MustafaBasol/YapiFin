import Link from "next/link";
import { requireRole } from "@/lib/auth/guard";
import { getPlanComparison } from "@/server/services/plan-comparison-service";
import { getOrganizationBillingHealth } from "@/server/services/billing/billing-health-service";
import { PlanComparisonView } from "@/components/app/plan-comparison-view";
import { BillingDunningBanner } from "@/components/app/billing-dunning-banner";
import { BillingSubscriptionCard } from "@/components/app/billing-subscription-card";

export default async function PlanComparisonPage() {
  const actor = await requireRole(["OWNER", "ADMIN"]);
  const [comparison, billingHealth] = await Promise.all([
    getPlanComparison(actor),
    getOrganizationBillingHealth(actor),
  ]);
  const currentPlanName = comparison.plans.find((plan) => plan.isCurrent)?.name ?? null;

  return (
    <div className="mx-auto max-w-[1200px] animate-fade-in space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="font-display text-2xl font-bold tracking-tight">Plan ve Fiyatlandırma</h1>
          <p className="mt-0.5 text-sm text-muted-foreground">
            Mevcut planınızı ve organizasyonunuzun kullanım durumunu görüntüleyin, plan seçeneklerini karşılaştırın.
          </p>
        </div>
        <div className="flex shrink-0 flex-wrap gap-2">
          {/* YF-813 — dahil kota yetmediğinde ek kullanım paketi (add-on/top-up) satın alma akışına giriş noktası. */}
          <Link
            href="/settings/plan/addons"
            className="inline-block rounded-lg border border-border bg-card px-4 py-2 text-sm font-semibold text-foreground transition-colors hover:bg-muted"
          >
            Ek kullanım paketleri
          </Link>
          {/* YF-815 — iade/ödeme itirazı (chargeback) operasyonel görünürlüğüne giriş noktası. */}
          <Link
            href="/settings/plan/billing-operations"
            className="inline-block rounded-lg border border-border bg-card px-4 py-2 text-sm font-semibold text-foreground transition-colors hover:bg-muted"
          >
            İade ve itirazlar
          </Link>
        </div>
      </div>
      {/* YF-814 — ödeme gecikmesi (dunning) / grace period durumu + acil kurtarma CTA'sı (yalnızca aktif bir sorun varken görünür). */}
      <BillingDunningBanner health={billingHealth} canManage={actor.role === "OWNER"} />
      {/* YF-811 — daima görünür faturalama kendi-kendine-hizmet özeti + Stripe Faturalama Portalı CTA'sı. */}
      <BillingSubscriptionCard health={billingHealth} planName={currentPlanName} canManage={actor.role === "OWNER"} />
      <PlanComparisonView data={comparison} />
    </div>
  );
}
