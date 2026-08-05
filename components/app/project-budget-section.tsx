import { Wallet, TrendingDown, PiggyBank, Percent } from "lucide-react";
import { formatMoney } from "@/lib/utils";
import { StatCard } from "@/components/app/stat-card";
import { ProjectBudgetStatusBadge } from "@/components/app/project-budget-status";
import { ProjectBudgetItemRow } from "@/components/app/project-budget-item-row";
import { ProjectBudgetCreateForm } from "@/components/app/project-budget-create-form";
import type { ProjectBudgetPlanning } from "@/server/services/project-budget-service";

interface CategoryOption {
  id: string;
  name: string;
}

function percentValue(value: string | null) {
  return value ? `%${value.replace(".", ",")}` : "—";
}

export function ProjectBudgetSection({
  planning,
  activeCategoryOptions,
}: {
  planning: ProjectBudgetPlanning;
  activeCategoryOptions: CategoryOption[];
}) {
  const { items, canManage } = planning;

  return (
    <div className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard icon={Wallet} label="Planlanan Bütçe" value={formatMoney(planning.totalPlannedBudget)} />
        <StatCard icon={TrendingDown} label="Gerçekleşen Gider" value={formatMoney(planning.totalRealizedExpense)} />
        <StatCard
          icon={PiggyBank}
          label="Kalan Bütçe"
          value={formatMoney(planning.totalRemainingBudget)}
          tone={Number(planning.totalRemainingBudget) < 0 ? "destructive" : "neutral"}
        />
        <StatCard icon={Percent} label="Kullanım Oranı" value={percentValue(planning.totalUsagePercentage)} />
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[12.5px] font-medium text-muted-foreground">Genel bütçe durumu</span>
        <ProjectBudgetStatusBadge status={planning.status} />
      </div>

      <div className="overflow-hidden rounded-2xl border border-border bg-card shadow-soft">
        <div className="border-b border-border p-4">
          <h2 className="font-display text-[15px] font-semibold tracking-tight">Bütçe Kalemleri</h2>
          {!canManage && (
            <p className="mt-1 text-[12px] text-muted-foreground">
              Yalnızca atandığınız projenin bütçe bilgilerini görüntüleyebilirsiniz; ekleme/düzenleme/silme yetkiniz yok.
            </p>
          )}
        </div>

        {items.length === 0 ? (
          <div className="p-8 text-center">
            <p className="text-[13px] text-muted-foreground">Bu proje için henüz bir bütçe kalemi girilmemiş.</p>
            {!canManage && <p className="mt-1 text-[12px] text-muted-foreground">Bütçe planlaması yetkili bir kullanıcı tarafından yapılmalıdır.</p>}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left">
                  <th className="label-mono py-2.5 pl-4 font-medium text-muted-foreground">Gider Kategorisi</th>
                  <th className="label-mono py-2.5 text-right font-medium text-muted-foreground">Planlanan Tutar</th>
                  <th className="label-mono py-2.5 text-right font-medium text-muted-foreground">Gerçekleşen</th>
                  <th className="label-mono py-2.5 text-right font-medium text-muted-foreground">Kalan</th>
                  <th className="label-mono py-2.5 text-right font-medium text-muted-foreground">Kullanım Oranı</th>
                  <th className="label-mono py-2.5 pr-4 text-right font-medium text-muted-foreground">Durum / İşlemler</th>
                </tr>
              </thead>
              <tbody>
                {items.map((item) => (
                  <ProjectBudgetItemRow key={item.id} item={item} categoryOptions={activeCategoryOptions} canManage={canManage} />
                ))}
              </tbody>
            </table>
          </div>
        )}

        {canManage && (
          <div className="p-4">
            {items.length === 0 && activeCategoryOptions.length > 0 && (
              <p className="mb-3 text-[12.5px] font-medium text-primary">İlk bütçe kalemini ekle</p>
            )}
            <ProjectBudgetCreateForm projectId={planning.project.id} categoryOptions={activeCategoryOptions} />
          </div>
        )}
      </div>
    </div>
  );
}
