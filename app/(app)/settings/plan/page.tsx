import { requireRole } from "@/lib/auth/guard";
import { getPlanComparison } from "@/server/services/plan-comparison-service";
import { PlanComparisonView } from "@/components/app/plan-comparison-view";

export default async function PlanComparisonPage() {
  const actor = await requireRole(["OWNER", "ADMIN"]);
  const comparison = await getPlanComparison(actor);

  return (
    <div className="mx-auto max-w-[1200px] animate-fade-in space-y-6">
      <div>
        <h1 className="font-display text-2xl font-bold tracking-tight">Plan ve Fiyatlandırma</h1>
        <p className="mt-0.5 text-sm text-muted-foreground">
          Mevcut planınızı ve organizasyonunuzun kullanım durumunu görüntüleyin, plan seçeneklerini karşılaştırın.
        </p>
      </div>
      <PlanComparisonView data={comparison} />
    </div>
  );
}
