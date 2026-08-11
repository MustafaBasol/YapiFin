import Link from "next/link";
import { requireRole } from "@/lib/auth/guard";
import { getPlanComparison } from "@/server/services/plan-comparison-service";
import { PlanComparisonView } from "@/components/app/plan-comparison-view";

export default async function PlanComparisonPage() {
  const actor = await requireRole(["OWNER", "ADMIN"]);
  const comparison = await getPlanComparison(actor);

  return (
    <div className="mx-auto max-w-[1200px] animate-fade-in space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="font-display text-2xl font-bold tracking-tight">Plan ve Fiyatlandırma</h1>
          <p className="mt-0.5 text-sm text-muted-foreground">
            Mevcut planınızı ve organizasyonunuzun kullanım durumunu görüntüleyin, plan seçeneklerini karşılaştırın.
          </p>
        </div>
        {/* YF-813 — dahil kota yetmediğinde ek kullanım paketi (add-on/top-up) satın alma akışına giriş noktası. */}
        <Link
          href="/settings/plan/addons"
          className="inline-block shrink-0 rounded-lg border border-border bg-card px-4 py-2 text-sm font-semibold text-foreground transition-colors hover:bg-muted"
        >
          Ek kullanım paketleri
        </Link>
      </div>
      <PlanComparisonView data={comparison} />
    </div>
  );
}
