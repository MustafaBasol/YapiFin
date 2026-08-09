import type { ProgressPaymentStatus } from "@prisma/client";
import { cn } from "@/lib/utils";

export const PROGRESS_PAYMENT_STATUS_LABELS: Record<ProgressPaymentStatus, string> = {
  DRAFT: "Taslak",
  SUBMITTED: "Onaya Gönderildi",
  APPROVED: "Onaylandı",
  REJECTED: "Reddedildi",
  CANCELLED: "İptal Edildi",
};

const STATUS_TONE: Record<ProgressPaymentStatus, string> = {
  DRAFT: "bg-muted text-muted-foreground",
  SUBMITTED: "bg-warning/15 text-warning-foreground",
  APPROVED: "bg-success/12 text-success",
  REJECTED: "bg-destructive/10 text-destructive",
  CANCELLED: "bg-destructive/10 text-destructive",
};

export function ProgressPaymentStatusBadge({ status, className }: { status: ProgressPaymentStatus; className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[12px] font-semibold",
        STATUS_TONE[status],
        className,
      )}
    >
      {PROGRESS_PAYMENT_STATUS_LABELS[status]}
    </span>
  );
}
