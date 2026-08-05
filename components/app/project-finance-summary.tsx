import { AlertTriangle, Banknote, TrendingDown, TrendingUp } from "lucide-react";
import { cn, formatDate, formatMoney } from "@/lib/utils";
import { StatCard } from "@/components/app/stat-card";
import type { ProjectFinanceSummary, ProjectSettlementRow } from "@/server/services/project-finance-service";

function Field({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div>
      <dt className="text-[11px] text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 font-medium tabular-nums">{value}</dd>
      {hint && <p className="text-[10.5px] text-muted-foreground">{hint}</p>}
    </div>
  );
}

const UNAVAILABLE = "Veri modeli bu tahmini desteklemiyor";

export function ProjectFinanceHighlights({ summary }: { summary: ProjectFinanceSummary }) {
  return (
    <div className="grid gap-4 sm:grid-cols-3">
      <StatCard
        icon={Banknote}
        label="Nakit Pozisyonu"
        value={formatMoney(summary.cashPosition)}
        hint="Tahsil edilen − Ödenen"
        tone={Number(summary.cashPosition) >= 0 ? "success" : "destructive"}
      />
      <StatCard
        icon={TrendingUp}
        label="Tahakkuk Bazlı Sonuç"
        value={formatMoney(summary.accrualResult)}
        hint="Kaydedilen gelir − Kaydedilen gider"
        tone={Number(summary.accrualResult) >= 0 ? "success" : "destructive"}
      />
      <StatCard
        icon={TrendingDown}
        label="Tahmini Brüt Kâr"
        value={summary.estimatedProfitAvailable ? formatMoney(summary.estimatedGrossProfit ?? "0") : UNAVAILABLE}
        hint={
          summary.estimatedProfitAvailable
            ? `Tahmini kâr marjı: %${(summary.estimatedProfitMargin ?? "0").replace(".", ",")}`
            : "Sözleşme bedeli girilmemiş"
        }
        tone={summary.estimatedProfitAvailable ? (Number(summary.estimatedGrossProfit) >= 0 ? "success" : "destructive") : "neutral"}
      />
    </div>
  );
}

export function ProjectFinanceDetails({ summary }: { summary: ProjectFinanceSummary }) {
  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <div className="rounded-2xl border border-border bg-card p-5 shadow-soft">
        <h2 className="font-display text-[15px] font-semibold tracking-tight">Gelir ve Alacak</h2>
        <dl className="mt-4 grid grid-cols-2 gap-4 text-sm">
          <Field label="Sözleşme Bedeli" value={formatMoney(summary.contractAmount)} />
          <Field label="Beklenen Ek Gelir" value={UNAVAILABLE} />
          <Field label="Toplam Kaydedilen Gelir" value={formatMoney(summary.totalRecordedIncome)} />
          <Field label="Tahsil Edilen" value={formatMoney(summary.totalCollected)} />
          <Field label="Kalan Alacak" value={formatMoney(summary.remainingReceivable)} />
        </dl>
      </div>

      <div className="rounded-2xl border border-border bg-card p-5 shadow-soft">
        <h2 className="font-display text-[15px] font-semibold tracking-tight">Gider ve Borç</h2>
        <dl className="mt-4 grid grid-cols-2 gap-4 text-sm">
          <Field label="Gerçekleşen Gider" value={formatMoney(summary.totalRecordedExpense)} />
          <Field label="Ödenen" value={formatMoney(summary.totalPaid)} />
          <Field label="Kalan Borç" value={formatMoney(summary.remainingPayable)} />
        </dl>
      </div>

      <div className="rounded-2xl border border-border bg-card p-5 shadow-soft lg:col-span-2">
        <div className="flex items-center justify-between">
          <h2 className="font-display text-[15px] font-semibold tracking-tight">Bütçe</h2>
          {summary.budgetAvailable && (
            <span
              className={cn(
                "inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[12px] font-semibold",
                summary.isBudgetOverrun ? "bg-destructive/10 text-destructive" : "bg-success/12 text-success",
              )}
            >
              {summary.isBudgetOverrun ? <AlertTriangle className="h-3.5 w-3.5" /> : null}
              {summary.isBudgetOverrun ? "Bütçe Aşıldı" : "Bütçe Normal"}
            </span>
          )}
        </div>
        <dl className="mt-4 grid grid-cols-2 gap-4 text-sm sm:grid-cols-4">
          <Field label="Proje Bütçesi" value={summary.budgetAvailable ? formatMoney(summary.estimatedBudget) : "Girilmemiş"} />
          <Field label="Bütçe Kullanımı (Gerçekleşen Gider)" value={formatMoney(summary.budgetUsed)} />
          <Field label="Kalan Bütçe" value={formatMoney(summary.remainingBudget)} />
          <Field
            label="Bütçe Kullanım Oranı"
            value={summary.budgetUsedRatio ? `%${summary.budgetUsedRatio.replace(".", ",")}` : UNAVAILABLE}
          />
        </dl>
      </div>
    </div>
  );
}

export function ProjectCashMovementSummary({ summary }: { summary: ProjectFinanceSummary }) {
  return (
    <div className="rounded-2xl border border-border bg-card p-5 shadow-soft">
      <h2 className="font-display text-[15px] font-semibold tracking-tight">Proje Nakit Hareketi Özeti</h2>
      <p className="mt-1 text-[12.5px] text-muted-foreground">Hangi kasa/banka hesabı kullanıldığından bağımsız, projeye ait toplam nakit hareketi.</p>
      <dl className="mt-4 grid grid-cols-3 gap-4 text-sm">
        <Field label="Toplam Tahsilat" value={formatMoney(summary.totalCollected)} />
        <Field label="Toplam Ödeme" value={formatMoney(summary.totalPaid)} />
        <Field label="Net" value={formatMoney(summary.cashPosition)} />
      </dl>
    </div>
  );
}

const SETTLEMENT_TYPE_LABEL: Record<ProjectSettlementRow["type"], string> = {
  COLLECTION: "Tahsilat",
  PAYMENT: "Ödeme",
};

export function ProjectSettlementsTable({ settlements }: { settlements: ProjectSettlementRow[] }) {
  if (settlements.length === 0) {
    return <p className="py-10 text-center text-[13px] text-muted-foreground">Henüz tahsilat veya ödeme kaydı yok.</p>;
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border text-left">
            <th className="label-mono py-2.5 pl-4 font-medium text-muted-foreground">Tarih</th>
            <th className="label-mono py-2.5 font-medium text-muted-foreground">Tür</th>
            <th className="label-mono py-2.5 font-medium text-muted-foreground">Hesap</th>
            <th className="label-mono py-2.5 font-medium text-muted-foreground">İlgili kayıt</th>
            <th className="label-mono py-2.5 pr-4 text-right font-medium text-muted-foreground">Tutar</th>
          </tr>
        </thead>
        <tbody>
          {settlements.map((s) => (
            <tr key={s.id} className="border-b border-border/60 last:border-0">
              <td className="whitespace-nowrap py-2.5 pl-4 text-[12.5px] text-muted-foreground">{formatDate(s.settlementDate)}</td>
              <td className="py-2.5 text-[12.5px]">
                <span
                  className={cn(
                    "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold",
                    s.type === "COLLECTION" ? "bg-success/12 text-success" : "bg-warning/15 text-warning-foreground",
                  )}
                >
                  {SETTLEMENT_TYPE_LABEL[s.type]}
                </span>
              </td>
              <td className="py-2.5 text-[12.5px] text-muted-foreground">{s.accountName}</td>
              <td className="max-w-[220px] truncate py-2.5 text-[12.5px] text-muted-foreground" title={s.relatedDescription}>
                {s.relatedDescription}
              </td>
              <td className="whitespace-nowrap py-2.5 pr-4 text-right text-[12.5px] font-semibold tabular-nums">{formatMoney(s.amount)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
