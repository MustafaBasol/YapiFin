import { cn, formatDateTime, formatMoney } from "@/lib/utils";
import type { MovementDirection, MovementType } from "@prisma/client";

const MOVEMENT_TYPE_LABELS: Record<MovementType, string> = {
  OPENING: "Açılış bakiyesi",
  COLLECTION: "Tahsilat",
  PAYMENT: "Ödeme",
  TRANSFER_IN: "Transfer girişi",
  TRANSFER_OUT: "Transfer çıkışı",
  ADJUSTMENT: "Manuel düzeltme",
  REVERSAL: "Ters kayıt (iptal)",
};

interface MovementRow {
  id: string;
  type: MovementType;
  direction: MovementDirection;
  amount: string;
  occurredAt: Date;
  description: string;
}

export function AccountMovements({ movements, currency }: { movements: MovementRow[]; currency: string }) {
  if (movements.length === 0) {
    return <p className="mt-2 text-sm text-muted-foreground">Bu hesapta henüz hareket yok.</p>;
  }

  return (
    <div className="mt-3 overflow-hidden rounded-xl border border-border">
      <div className="max-h-[420px] overflow-y-auto">
        <table className="w-full text-sm">
          <thead className="sticky top-0 bg-card">
            <tr className="border-b border-border text-left">
              <th className="label-mono py-2 pl-3 font-medium text-muted-foreground">Tarih</th>
              <th className="label-mono py-2 font-medium text-muted-foreground">Tür</th>
              <th className="label-mono py-2 font-medium text-muted-foreground">Açıklama</th>
              <th className="label-mono py-2 pr-3 text-right font-medium text-muted-foreground">Tutar</th>
            </tr>
          </thead>
          <tbody>
            {movements.map((m) => (
              <tr key={m.id} className="border-b border-border/60 last:border-0">
                <td className="py-2 pl-3 text-[12px] text-muted-foreground whitespace-nowrap">
                  {formatDateTime(m.occurredAt)}
                </td>
                <td className="py-2 text-[12px]">{MOVEMENT_TYPE_LABELS[m.type]}</td>
                <td className="py-2 max-w-[220px] truncate text-[12px] text-muted-foreground" title={m.description}>
                  {m.description}
                </td>
                <td
                  className={cn(
                    "py-2 pr-3 text-right text-[13px] font-semibold tabular-nums whitespace-nowrap",
                    m.direction === "CREDIT" ? "text-success" : "text-destructive",
                  )}
                >
                  {m.direction === "CREDIT" ? "+" : "−"}
                  {formatMoney(m.amount, currency)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
