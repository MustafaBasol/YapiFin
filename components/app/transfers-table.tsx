import Link from "next/link";
import { cn, formatDate, formatMoney } from "@/lib/utils";
import type { TransferStatus } from "@prisma/client";

interface Row {
  id: string;
  fromAccount: { name: string };
  toAccount: { name: string };
  amount: string;
  transferDate: Date;
  status: TransferStatus;
}

export function TransfersTable({ transfers }: { transfers: Row[] }) {
  if (transfers.length === 0) {
    return <p className="mt-2 text-sm text-muted-foreground">Henüz transfer kaydı yok.</p>;
  }

  return (
    <div className="mt-3 overflow-hidden rounded-xl border border-border">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border text-left">
            <th className="label-mono py-2 pl-3 font-medium text-muted-foreground">Tarih</th>
            <th className="label-mono py-2 font-medium text-muted-foreground">Kaynak</th>
            <th className="label-mono py-2 font-medium text-muted-foreground">Hedef</th>
            <th className="label-mono py-2 font-medium text-muted-foreground">Tutar</th>
            <th className="label-mono py-2 pr-3 font-medium text-muted-foreground">Durum</th>
          </tr>
        </thead>
        <tbody>
          {transfers.map((t) => (
            <tr key={t.id} className="border-b border-border/60 transition-colors last:border-0 hover:bg-muted/50">
              <td className="py-2 pl-3 text-[12px] text-muted-foreground">
                <Link href={`/accounts/transfers/${t.id}`} className="block">
                  {formatDate(t.transferDate)}
                </Link>
              </td>
              <td className="py-2 text-[13px]">{t.fromAccount.name}</td>
              <td className="py-2 text-[13px]">{t.toAccount.name}</td>
              <td className="py-2 text-[13px] font-semibold tabular-nums">{formatMoney(t.amount)}</td>
              <td className="py-2 pr-3">
                <span
                  className={cn(
                    "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold",
                    t.status === "ACTIVE" ? "bg-success/12 text-success" : "bg-muted text-muted-foreground",
                  )}
                >
                  {t.status === "ACTIVE" ? "Aktif" : "İptal"}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
