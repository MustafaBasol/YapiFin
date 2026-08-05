import { ListChecks } from "lucide-react";
import { cn, formatDateTime, formatMoney } from "@/lib/utils";
import type { RecentMovement } from "@/server/services/dashboard-service";
import type { MovementType } from "@prisma/client";

const MOVEMENT_TYPE_LABELS: Record<MovementType, string> = {
  OPENING: "Açılış",
  COLLECTION: "Tahsilat",
  PAYMENT: "Ödeme",
  TRANSFER_IN: "Transfer girişi",
  TRANSFER_OUT: "Transfer çıkışı",
  ADJUSTMENT: "Manuel düzeltme",
  REVERSAL: "Ters kayıt",
};

export function DashboardRecentMovements({ movements }: { movements: RecentMovement[] }) {
  if (movements.length === 0) {
    return (
      <div className="grid place-items-center py-14 text-center">
        <ListChecks className="h-7 w-7 text-muted-foreground/50" />
        <p className="mt-3 text-sm text-muted-foreground">Henüz bir hesap hareketi kaydedilmemiş.</p>
      </div>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border text-left">
            <th className="label-mono py-2.5 pl-4 font-medium text-muted-foreground">Tarih</th>
            <th className="label-mono py-2.5 font-medium text-muted-foreground">Tür</th>
            <th className="label-mono py-2.5 font-medium text-muted-foreground">Hesap</th>
            <th className="label-mono py-2.5 font-medium text-muted-foreground">Açıklama</th>
            <th className="label-mono py-2.5 pr-4 text-right font-medium text-muted-foreground">Tutar</th>
          </tr>
        </thead>
        <tbody>
          {movements.map((m) => (
            <tr key={m.id} className="border-b border-border/60 last:border-0">
              <td className="whitespace-nowrap py-2.5 pl-4 text-[12.5px] text-muted-foreground">{formatDateTime(m.occurredAt)}</td>
              <td className="py-2.5 text-[12.5px]">{MOVEMENT_TYPE_LABELS[m.type]}</td>
              <td className="py-2.5 text-[12.5px] text-muted-foreground">{m.accountName}</td>
              <td className="max-w-[220px] truncate py-2.5 text-[12.5px] text-muted-foreground" title={m.description}>
                {m.relatedProjectName ? `${m.description} · ${m.relatedProjectName}` : m.description}
              </td>
              <td
                className={cn(
                  "whitespace-nowrap py-2.5 pr-4 text-right text-[12.5px] font-semibold tabular-nums",
                  m.direction === "CREDIT" ? "text-success" : "text-destructive",
                )}
              >
                {m.direction === "CREDIT" ? "+" : "−"}
                {formatMoney(m.amount)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
