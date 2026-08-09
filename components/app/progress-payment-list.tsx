import Link from "next/link";
import { formatMoney, formatDate } from "@/lib/utils";
import { ProgressPaymentStatusBadge } from "@/components/app/progress-payment-status";
import type { ProgressPaymentStatus } from "@prisma/client";

interface ProgressPaymentRow {
  id: string;
  sequenceNo: number;
  periodStartDate: Date;
  periodEndDate: Date;
  grossAmount: unknown;
  deductionAmount: unknown;
  netAmount: unknown;
  status: ProgressPaymentStatus;
  categoryName: string;
}

export function ProgressPaymentList({ projectId, records }: { projectId: string; records: ProgressPaymentRow[] }) {
  if (records.length === 0) {
    return (
      <div className="p-8 text-center">
        <p className="text-[13px] text-muted-foreground">Bu proje için henüz bir hakediş oluşturulmamış.</p>
      </div>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border text-left">
            <th className="label-mono py-2.5 pl-4 font-medium text-muted-foreground">No</th>
            <th className="label-mono py-2.5 font-medium text-muted-foreground">Dönem</th>
            <th className="label-mono py-2.5 font-medium text-muted-foreground">Kategori</th>
            <th className="label-mono py-2.5 text-right font-medium text-muted-foreground">Brüt</th>
            <th className="label-mono py-2.5 text-right font-medium text-muted-foreground">Kesinti</th>
            <th className="label-mono py-2.5 text-right font-medium text-muted-foreground">Net</th>
            <th className="label-mono py-2.5 pr-4 text-right font-medium text-muted-foreground">Durum</th>
          </tr>
        </thead>
        <tbody>
          {records.map((r) => (
            <tr key={r.id} className="border-b border-border/60 last:border-0 hover:bg-muted/30">
              <td className="py-2.5 pl-4 text-[12.5px] font-medium">
                <Link href={`/projects/${projectId}/progress-payments/${r.id}`} className="text-primary hover:underline">
                  Hakediş {r.sequenceNo}
                </Link>
              </td>
              <td className="py-2.5 text-[12.5px] text-muted-foreground">
                {formatDate(r.periodStartDate)} – {formatDate(r.periodEndDate)}
              </td>
              <td className="py-2.5 text-[12.5px]">{r.categoryName}</td>
              <td className="py-2.5 text-right text-[12.5px] tabular-nums">{formatMoney(r.grossAmount as string)}</td>
              <td className="py-2.5 text-right text-[12.5px] tabular-nums text-muted-foreground">
                {formatMoney(r.deductionAmount as string)}
              </td>
              <td className="py-2.5 text-right text-[12.5px] font-semibold tabular-nums">{formatMoney(r.netAmount as string)}</td>
              <td className="py-2.5 pr-4 text-right">
                <ProgressPaymentStatusBadge status={r.status} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
