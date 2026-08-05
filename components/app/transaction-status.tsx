import type { TransactionStatus } from "@prisma/client";

/** Durum rozeti renkleri — docs/UX_UI.md §8. */
export const TRANSACTION_STATUS_META: Record<TransactionStatus, { label: string; tone: string }> = {
  OPEN: { label: "Açık", tone: "bg-info/12 text-info" },
  PARTIALLY_PAID: { label: "Kısmen Tahsil/Ödendi", tone: "bg-warning/15 text-warning-foreground" },
  PAID: { label: "Tamamlandı", tone: "bg-success/12 text-success" },
  OVERDUE: { label: "Vadesi Geçti", tone: "bg-destructive/10 text-destructive" },
  CANCELLED: { label: "İptal", tone: "bg-muted text-muted-foreground line-through" },
};

export function transactionStatusLabel(status: TransactionStatus, type: "INCOME" | "EXPENSE") {
  if (status === "PARTIALLY_PAID") return type === "INCOME" ? "Kısmen Tahsil Edildi" : "Kısmen Ödendi";
  if (status === "PAID") return type === "INCOME" ? "Tahsil Edildi" : "Ödendi";
  return TRANSACTION_STATUS_META[status].label;
}
