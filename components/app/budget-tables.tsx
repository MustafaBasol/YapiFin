import { AlertTriangle } from "lucide-react";
import { cn, formatMoney } from "@/lib/utils";
import { BUDGET_STATUS_LABELS } from "@/server/services/budget-report-service";
import type {
  AtRiskProjectRow,
  BudgetStatus,
  CategoryAnalysisRow,
  NoBudgetProjectRow,
  OverBudgetProjectRow,
  ProjectBudgetRow,
  ProjectCategoryRow,
} from "@/server/services/budget-report-service";

const STATUS_TONE: Record<BudgetStatus, string> = {
  NORMAL: "bg-success/12 text-success",
  CRITICAL: "bg-warning/15 text-warning-foreground",
  OVER_BUDGET: "bg-destructive/10 text-destructive",
  NO_BUDGET: "bg-muted text-muted-foreground",
};

function StatusBadge({ status }: { status: BudgetStatus }) {
  return (
    <span className={cn("inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold", STATUS_TONE[status])}>
      {status === "OVER_BUDGET" && <AlertTriangle className="h-3 w-3" />}
      {BUDGET_STATUS_LABELS[status]}
    </span>
  );
}

function percentLabel(value: string | null) {
  return value ? `%${value.replace(".", ",")}` : "—";
}

export function BudgetProjectTable({ rows }: { rows: ProjectBudgetRow[] }) {
  if (rows.length === 0) {
    return <p className="py-10 text-center text-[13px] text-muted-foreground">Karşılaştırılacak proje yok.</p>;
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border text-left">
            <th className="label-mono py-2.5 pl-4 font-medium text-muted-foreground">Proje</th>
            <th className="label-mono py-2.5 text-right font-medium text-muted-foreground">Bütçe</th>
            <th className="label-mono py-2.5 text-right font-medium text-muted-foreground">Gerçekleşen Gider</th>
            <th className="label-mono py-2.5 text-right font-medium text-muted-foreground">Ödenen</th>
            <th className="label-mono py-2.5 text-right font-medium text-muted-foreground">Kalan Bütçe</th>
            <th className="label-mono py-2.5 text-right font-medium text-muted-foreground">Kullanım</th>
            <th className="label-mono py-2.5 pr-4 font-medium text-muted-foreground">Durum</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.projectId} className="border-b border-border/60 last:border-0">
              <td className="py-2.5 pl-4 text-[12.5px] font-medium">
                {r.name} <span className="text-muted-foreground">({r.code})</span>
              </td>
              <td className="py-2.5 text-right text-[12.5px] tabular-nums">{r.status === "NO_BUDGET" ? "Girilmemiş" : formatMoney(r.estimatedBudget)}</td>
              <td className="py-2.5 text-right text-[12.5px] tabular-nums">{formatMoney(r.realizedExpenses)}</td>
              <td className="py-2.5 text-right text-[12.5px] tabular-nums text-muted-foreground">{formatMoney(r.paidExpenses)}</td>
              <td
                className={cn(
                  "py-2.5 text-right text-[12.5px] font-semibold tabular-nums",
                  Number(r.remainingBudget) < 0 && r.status !== "NO_BUDGET" ? "text-destructive" : "",
                )}
              >
                {r.status === "NO_BUDGET" ? "—" : formatMoney(r.remainingBudget)}
              </td>
              <td className="py-2.5 text-right text-[12.5px] tabular-nums">{percentLabel(r.usagePercentage)}</td>
              <td className="py-2.5 pr-4">
                <StatusBadge status={r.status} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function BudgetCategoryTable({ rows }: { rows: CategoryAnalysisRow[] }) {
  if (rows.length === 0) {
    return <p className="py-10 text-center text-[13px] text-muted-foreground">Seçilen aralıkta gider kaydı yok.</p>;
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border text-left">
            <th className="label-mono py-2.5 pl-4 font-medium text-muted-foreground">Kategori</th>
            <th className="label-mono py-2.5 text-right font-medium text-muted-foreground">Kaydedilen Gider</th>
            <th className="label-mono py-2.5 text-right font-medium text-muted-foreground">Ödenen</th>
            <th className="label-mono py-2.5 text-right font-medium text-muted-foreground">Toplam İçindeki Pay</th>
            <th className="label-mono py-2.5 text-right font-medium text-muted-foreground">Proje Sayısı</th>
            <th className="label-mono py-2.5 pr-4 text-right font-medium text-muted-foreground">İşlem Sayısı</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.categoryId} className="border-b border-border/60 last:border-0">
              <td className="py-2.5 pl-4 text-[12.5px] font-medium">{r.name}</td>
              <td className="py-2.5 text-right text-[12.5px] font-semibold tabular-nums">{formatMoney(r.recordedExpense)}</td>
              <td className="py-2.5 text-right text-[12.5px] tabular-nums text-muted-foreground">{formatMoney(r.paidExpense)}</td>
              <td className="py-2.5 text-right text-[12.5px] tabular-nums">{percentLabel(r.shareOfTotal)}</td>
              <td className="py-2.5 text-right text-[12.5px] tabular-nums">{r.projectCount}</td>
              <td className="py-2.5 pr-4 text-right text-[12.5px] tabular-nums">{r.transactionCount}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function BudgetProjectCategoryMatrix({ rows, truncated }: { rows: ProjectCategoryRow[]; truncated: boolean }) {
  if (rows.length === 0) {
    return <p className="py-10 text-center text-[13px] text-muted-foreground">Seçilen aralıkta gider kaydı yok.</p>;
  }
  return (
    <div className="space-y-2">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border text-left">
              <th className="label-mono py-2.5 pl-4 font-medium text-muted-foreground">Proje</th>
              <th className="label-mono py-2.5 font-medium text-muted-foreground">Kategori</th>
              <th className="label-mono py-2.5 text-right font-medium text-muted-foreground">Gerçekleşen Gider</th>
              <th className="label-mono py-2.5 pr-4 text-right font-medium text-muted-foreground">Planlanan (varsa)</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={`${r.projectId}:${r.categoryId}`} className="border-b border-border/60 last:border-0">
                <td className="py-2.5 pl-4 text-[12.5px]">{r.projectName}</td>
                <td className="py-2.5 text-[12.5px] text-muted-foreground">{r.categoryName}</td>
                <td className="py-2.5 text-right text-[12.5px] font-semibold tabular-nums">{formatMoney(r.amount)}</td>
                <td className="py-2.5 pr-4 text-right text-[12.5px] tabular-nums text-muted-foreground">
                  {r.plannedAmount ? formatMoney(r.plannedAmount) : "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {truncated && (
        <p className="text-[11px] text-muted-foreground">En yüksek harcamalı ilk {rows.length} proje×kategori satırı gösteriliyor.</p>
      )}
    </div>
  );
}

export function BudgetOverBudgetList({ rows }: { rows: OverBudgetProjectRow[] }) {
  if (rows.length === 0) {
    return <p className="py-6 text-center text-[13px] text-muted-foreground">Bütçesini aşan aktif proje yok.</p>;
  }
  return (
    <div className="space-y-3">
      {rows.map((r) => (
        <div key={r.projectId} className="rounded-xl border border-destructive/20 bg-destructive/5 p-3.5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-[13px] font-semibold">
              {r.name} <span className="font-normal text-muted-foreground">({r.code})</span>
            </p>
            <span className="text-[12.5px] font-semibold text-destructive">
              +{formatMoney(r.overrunAmount)} (%{r.overrunPercentage.replace(".", ",")})
            </span>
          </div>
          <p className="mt-1 text-[11.5px] text-muted-foreground">
            Bütçe {formatMoney(r.estimatedBudget)} · Gerçekleşen {formatMoney(r.realizedExpenses)}
          </p>
          {r.topCategories.length > 0 && (
            <p className="mt-1.5 text-[11px] text-muted-foreground">
              En büyük kategoriler: {r.topCategories.map((c) => `${c.name} (${formatMoney(c.amount)})`).join(", ")}
            </p>
          )}
        </div>
      ))}
    </div>
  );
}

export function BudgetAtRiskList({ rows }: { rows: AtRiskProjectRow[] }) {
  if (rows.length === 0) {
    return <p className="py-6 text-center text-[13px] text-muted-foreground">Bütçesi kritik seviyeye yaklaşan aktif proje yok.</p>;
  }
  return (
    <div className="space-y-3">
      {rows.map((r) => (
        <div key={r.projectId} className="rounded-xl border border-warning/25 bg-warning/10 p-3.5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-[13px] font-semibold">
              {r.name} <span className="font-normal text-muted-foreground">({r.code})</span>
            </p>
            <span className="text-[12.5px] font-semibold text-warning-foreground">{percentLabel(r.usagePercentage)} kullanıldı</span>
          </div>
          <p className="mt-1 text-[11.5px] text-muted-foreground">
            Kalan bütçe {formatMoney(r.remainingAmount)} · Gerçekleşen {formatMoney(r.realizedExpenses)}
          </p>
          {r.recentTrend.length > 0 && (
            <p className="mt-1.5 text-[11px] text-muted-foreground">
              Son aylar: {r.recentTrend.map((t) => `${t.label} ${formatMoney(t.amount)}`).join(" · ")}
            </p>
          )}
        </div>
      ))}
    </div>
  );
}

export function BudgetNoBudgetList({ rows }: { rows: NoBudgetProjectRow[] }) {
  if (rows.length === 0) {
    return <p className="py-6 text-center text-[13px] text-muted-foreground">Bütçesi girilmemiş aktif proje yok.</p>;
  }
  return (
    <ul className="divide-y divide-border/60">
      {rows.map((r) => (
        <li key={r.projectId} className="flex items-center justify-between gap-2 py-2 text-[12.5px]">
          <span className="font-medium">
            {r.name} <span className="font-normal text-muted-foreground">({r.code})</span>
          </span>
          <span className="text-muted-foreground">Bütçe girilmemiş</span>
        </li>
      ))}
    </ul>
  );
}
