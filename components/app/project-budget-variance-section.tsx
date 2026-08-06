import { ArrowDownRight, ArrowUpRight, CalendarClock, Gauge, TrendingUp } from "lucide-react";
import { formatMoney } from "@/lib/utils";
import { cn } from "@/lib/utils";
import { StatCard } from "@/components/app/stat-card";
import { ProjectBudgetStatusBadge } from "@/components/app/project-budget-status";
import { FORECAST_UNAVAILABLE_LABELS, type ProjectBudgetVarianceReport } from "@/server/services/project-budget-variance-service";

function percentValue(value: string | null) {
  return value ? `%${value.replace(".", ",")}` : "—";
}

function varianceTone(amount: string): "destructive" | "success" | "neutral" {
  const n = Number(amount);
  if (n > 0) return "destructive";
  if (n < 0) return "success";
  return "neutral";
}

function VarianceAmount({ amount }: { amount: string }) {
  const n = Number(amount);
  const tone = varianceTone(amount);
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 tnum font-semibold",
        tone === "destructive" && "text-destructive",
        tone === "success" && "text-success",
      )}
    >
      {n > 0 && <ArrowUpRight className="h-3.5 w-3.5" />}
      {n < 0 && <ArrowDownRight className="h-3.5 w-3.5" />}
      {formatMoney(amount)}
    </span>
  );
}

export function ProjectBudgetVarianceSection({ report }: { report: ProjectBudgetVarianceReport }) {
  const { items, forecast } = report;

  return (
    <div className="space-y-6">
      <div>
        <h2 className="font-display text-[15px] font-semibold tracking-tight">Bütçe Sapma Analizi</h2>
        <p className="mt-0.5 text-[12.5px] text-muted-foreground">
          Planlanan bütçe ile gerçekleşen gider arasındaki fark ve mevcut harcama hızına göre tamamlanma tahmini.
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <StatCard
          icon={TrendingUp}
          label="Bütçe Sapması"
          value={formatMoney(report.varianceAmount)}
          tone={varianceTone(report.varianceAmount) === "destructive" ? "destructive" : "neutral"}
          hint={Number(report.varianceAmount) > 0 ? "Planlananın üzerinde harcama" : "Planlananın altında harcama"}
        />
        <StatCard icon={Gauge} label="Sapma Yüzdesi" value={percentValue(report.variancePercentage)} />
        <div className="flex items-center gap-2 rounded-2xl border border-border bg-card p-5 shadow-soft">
          <span className="text-[12.5px] font-medium text-muted-foreground">Genel durum</span>
          <ProjectBudgetStatusBadge status={report.status} />
        </div>
      </div>

      <div className="overflow-hidden rounded-2xl border border-border bg-card shadow-soft">
        <div className="border-b border-border p-4">
          <h3 className="font-display text-[14px] font-semibold tracking-tight">Kategori Bazlı Sapma</h3>
        </div>
        {items.length === 0 ? (
          <div className="p-8 text-center">
            <p className="text-[13px] text-muted-foreground">Bu proje için henüz bir bütçe kalemi girilmemiş, sapma hesaplanamıyor.</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left">
                  <th className="label-mono py-2.5 pl-4 font-medium text-muted-foreground">Gider Kategorisi</th>
                  <th className="label-mono py-2.5 text-right font-medium text-muted-foreground">Planlanan</th>
                  <th className="label-mono py-2.5 text-right font-medium text-muted-foreground">Gerçekleşen</th>
                  <th className="label-mono py-2.5 text-right font-medium text-muted-foreground">Kalan</th>
                  <th className="label-mono py-2.5 text-right font-medium text-muted-foreground">Kullanım</th>
                  <th className="label-mono py-2.5 text-right font-medium text-muted-foreground">Sapma</th>
                  <th className="label-mono py-2.5 pr-4 text-right font-medium text-muted-foreground">Durum</th>
                </tr>
              </thead>
              <tbody>
                {items.map((item) => (
                  <tr key={item.id} className="border-b border-border/60 last:border-0">
                    <td className="py-2.5 pl-4">{item.categoryName}</td>
                    <td className="py-2.5 text-right tnum">{formatMoney(item.plannedAmount)}</td>
                    <td className="py-2.5 text-right tnum">{formatMoney(item.realizedExpense)}</td>
                    <td className={cn("py-2.5 text-right tnum", Number(item.remainingAmount) < 0 && "text-destructive")}>
                      {formatMoney(item.remainingAmount)}
                    </td>
                    <td className="py-2.5 text-right tnum">{percentValue(item.usagePercentage)}</td>
                    <td className="py-2.5 text-right">
                      <VarianceAmount amount={item.varianceAmount} />
                    </td>
                    <td className="py-2.5 pr-4 text-right">
                      <ProjectBudgetStatusBadge status={item.status} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="overflow-hidden rounded-2xl border border-border bg-card shadow-soft">
        <div className="border-b border-border p-4">
          <h3 className="font-display text-[14px] font-semibold tracking-tight">Tamamlanma Tahmini</h3>
        </div>
        {!forecast.forecastAvailable ? (
          <div className="p-8 text-center">
            <p className="text-[13px] text-muted-foreground">
              {forecast.unavailableReason ? FORECAST_UNAVAILABLE_LABELS[forecast.unavailableReason] : "Tahmin üretilemiyor."}
            </p>
          </div>
        ) : (
          <div className="grid gap-4 p-4 sm:grid-cols-2 lg:grid-cols-4">
            <StatCard icon={CalendarClock} label="Geçen Süre" value={`${forecast.elapsedDays} gün`} />
            <StatCard icon={Gauge} label="Günlük Ortalama Gider" value={formatMoney(forecast.dailyBurnRate!)} />
            {forecast.projectedTotalExpenseAvailable ? (
              <>
                <StatCard icon={TrendingUp} label="Tahmini Toplam Gider" value={formatMoney(forecast.projectedTotalExpense!)} />
                <StatCard
                  icon={forecast.projectedOverrunOrSavings && Number(forecast.projectedOverrunOrSavings) > 0 ? ArrowUpRight : ArrowDownRight}
                  label="Tahmini Aşım / Tasarruf"
                  value={formatMoney(forecast.projectedOverrunOrSavings!)}
                  tone={
                    forecast.projectedOverrunOrSavings && Number(forecast.projectedOverrunOrSavings) > 0 ? "destructive" : "success"
                  }
                />
              </>
            ) : (
              <div className="rounded-2xl border border-dashed border-border p-5 text-[12.5px] text-muted-foreground sm:col-span-2">
                Projenin planlanan bitiş tarihi girilmediği için tahmini toplam gider hesaplanamıyor; yalnızca mevcut bütçenin kaç gün
                daha yeteceği aşağıda gösteriliyor.
              </div>
            )}
            <StatCard
              icon={CalendarClock}
              label="Bütçenin Yeteceği Süre"
              value={forecast.estimatedDaysRemainingOnBudget === 0 ? "Bütçe tükendi" : `${forecast.estimatedDaysRemainingOnBudget} gün`}
              tone={forecast.estimatedDaysRemainingOnBudget === 0 ? "destructive" : "neutral"}
            />
          </div>
        )}
        <p className="border-t border-border p-3 text-[11px] text-muted-foreground">
          Bu tahmin muhasebesel bir kesin sonuç değildir; mevcut harcama hızının değişmeden devam edeceği varsayımına dayanan
          operasyonel bir projeksiyondur.
        </p>
      </div>
    </div>
  );
}
