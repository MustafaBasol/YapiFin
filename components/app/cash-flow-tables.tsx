import { cn, formatDate, formatMoney } from "@/lib/utils";
import type {
  MaturityBuckets,
  MaturityListSection,
  ProjectCashFlowRow,
} from "@/server/services/cash-flow-report-service";

const BUCKET_COLUMNS: { key: keyof MaturityBuckets; label: string; tone?: "destructive" }[] = [
  { key: "overdue", label: "Vadesi Geçmiş", tone: "destructive" },
  { key: "dueToday", label: "Bugün Vadesi Gelen" },
  { key: "next7Days", label: "Gelecek 7 Gün" },
  { key: "next30Days", label: "Gelecek 30 Gün" },
  { key: "days31to60", label: "31–60 Gün" },
  { key: "days61to90", label: "61–90 Gün" },
  { key: "over90Days", label: "90 Gün Üzeri" },
  { key: "noDueDate", label: "Vade Tarihi Girilmemiş" },
];

export function CashFlowMaturityTable({
  receivables,
  payables,
}: {
  receivables: MaturityBuckets;
  payables: MaturityBuckets;
}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[820px] text-sm">
        <thead>
          <tr className="border-b border-border text-left">
            <th className="label-mono py-2.5 pl-4 font-medium text-muted-foreground">Vade Aralığı</th>
            {BUCKET_COLUMNS.map((col) => (
              <th
                key={col.key}
                className={cn(
                  "label-mono py-2.5 pr-2 text-right font-medium text-muted-foreground",
                  col.tone === "destructive" && "text-destructive",
                )}
              >
                {col.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          <tr className="border-b border-border/60">
            <td className="py-2.5 pl-4 text-[12.5px] font-semibold">Alacaklar</td>
            {BUCKET_COLUMNS.map((col) => (
              <td key={col.key} className="py-2.5 pr-2 text-right text-[12.5px] font-semibold tabular-nums">
                {formatMoney(receivables[col.key])}
              </td>
            ))}
          </tr>
          <tr>
            <td className="py-2.5 pl-4 text-[12.5px] font-semibold">Borçlar</td>
            {BUCKET_COLUMNS.map((col) => (
              <td key={col.key} className="py-2.5 pr-2 text-right text-[12.5px] font-semibold tabular-nums">
                {formatMoney(payables[col.key])}
              </td>
            ))}
          </tr>
        </tbody>
      </table>
    </div>
  );
}

export function CashFlowMaturityList({
  section,
  counterpartLabel,
  emptyLabel,
}: {
  section: MaturityListSection;
  counterpartLabel: string;
  emptyLabel: string;
}) {
  if (section.rows.length === 0) {
    return <p className="py-10 text-center text-[13px] text-muted-foreground">{emptyLabel}</p>;
  }
  return (
    <div className="space-y-2">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border text-left">
              <th className="label-mono py-2.5 pl-4 font-medium text-muted-foreground">{counterpartLabel}</th>
              <th className="label-mono py-2.5 font-medium text-muted-foreground">Proje</th>
              <th className="label-mono py-2.5 text-right font-medium text-muted-foreground">Orijinal</th>
              <th className="label-mono py-2.5 text-right font-medium text-muted-foreground">Kalan</th>
              <th className="label-mono py-2.5 font-medium text-muted-foreground">Vade</th>
              <th className="label-mono py-2.5 pr-4 font-medium text-muted-foreground">Durum</th>
            </tr>
          </thead>
          <tbody>
            {section.rows.map((r) => (
              <tr key={r.id} className="border-b border-border/60 last:border-0">
                <td className="py-2.5 pl-4">
                  <p className="truncate text-[12.5px] font-medium leading-tight">{r.counterpartName ?? "—"}</p>
                  <p className="truncate text-[11px] text-muted-foreground" title={r.description}>
                    {r.description}
                  </p>
                </td>
                <td className="py-2.5 text-[12.5px] text-muted-foreground">{r.projectName ?? "—"}</td>
                <td className="py-2.5 text-right text-[12.5px] tabular-nums text-muted-foreground">
                  {formatMoney(r.originalAmount, r.currency)}
                </td>
                <td className="py-2.5 text-right text-[12.5px] font-semibold tabular-nums">
                  {formatMoney(r.remainingAmount, r.currency)}
                </td>
                <td className="py-2.5 text-[12.5px] text-muted-foreground">{r.dueDate ? formatDate(r.dueDate) : "—"}</td>
                <td className="py-2.5 pr-4">
                  {r.isOverdue ? (
                    <span className="inline-flex items-center gap-1 rounded-full bg-destructive/10 px-2 py-0.5 text-[11px] font-semibold text-destructive">
                      {Math.abs(r.daysOverdueOrRemaining ?? 0)} gün gecikti
                    </span>
                  ) : r.daysOverdueOrRemaining === 0 ? (
                    <span className="inline-flex items-center gap-1 rounded-full bg-warning/15 px-2 py-0.5 text-[11px] font-semibold text-warning-foreground">
                      Bugün
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1 rounded-full bg-info/12 px-2 py-0.5 text-[11px] font-semibold text-info">
                      {r.daysOverdueOrRemaining} gün kaldı
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {section.truncated && (
        <p className="text-[11px] text-muted-foreground">
          {section.rows.length} / {section.totalOpenCount} kayıt gösteriliyor. Tam liste için ilgili gelir/gider ekranını kullanın.
        </p>
      )}
    </div>
  );
}

export function CashFlowProjectComparisonTable({
  rows,
  truncated,
}: {
  rows: ProjectCashFlowRow[];
  truncated: boolean;
}) {
  if (rows.length === 0) {
    return <p className="py-10 text-center text-[13px] text-muted-foreground">Karşılaştırılacak proje verisi yok.</p>;
  }
  return (
    <div className="space-y-2">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border text-left">
              <th className="label-mono py-2.5 pl-4 font-medium text-muted-foreground">Proje</th>
              <th className="label-mono py-2.5 text-right font-medium text-muted-foreground">Planlanan Tahsilat</th>
              <th className="label-mono py-2.5 text-right font-medium text-muted-foreground">Planlanan Ödeme</th>
              <th className="label-mono py-2.5 text-right font-medium text-muted-foreground">Beklenen Net</th>
              <th className="label-mono py-2.5 text-right font-medium text-muted-foreground">Vadesi Geçen Alacak</th>
              <th className="label-mono py-2.5 pr-4 text-right font-medium text-muted-foreground">Vadesi Geçen Borç</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.projectId} className="border-b border-border/60 last:border-0">
                <td className="py-2.5 pl-4 text-[12.5px] font-medium">
                  {r.name} <span className="text-muted-foreground">({r.code})</span>
                </td>
                <td className="py-2.5 text-right text-[12.5px] tabular-nums">{formatMoney(r.scheduledInflow)}</td>
                <td className="py-2.5 text-right text-[12.5px] tabular-nums">{formatMoney(r.scheduledOutflow)}</td>
                <td
                  className={cn(
                    "py-2.5 text-right text-[12.5px] font-semibold tabular-nums",
                    Number(r.projectedNet) >= 0 ? "text-success" : "text-destructive",
                  )}
                >
                  {formatMoney(r.projectedNet)}
                </td>
                <td className="py-2.5 text-right text-[12.5px] tabular-nums text-destructive">
                  {Number(r.overdueReceivable) > 0 ? formatMoney(r.overdueReceivable) : "—"}
                </td>
                <td className="py-2.5 pr-4 text-right text-[12.5px] tabular-nums text-destructive">
                  {Number(r.overduePayable) > 0 ? formatMoney(r.overduePayable) : "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {truncated && (
        <p className="text-[11px] text-muted-foreground">
          En yüksek riskli/hareketli ilk {rows.length} proje gösteriliyor.
        </p>
      )}
    </div>
  );
}
