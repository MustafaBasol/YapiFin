import type { TransactionType } from "@prisma/client";

export const CATEGORY_TYPE_META: Record<TransactionType, { label: string; tone: string }> = {
  INCOME: { label: "Gelir", tone: "bg-success/12 text-success" },
  EXPENSE: { label: "Gider", tone: "bg-destructive/10 text-destructive" },
};

export const CATEGORY_TYPE_OPTIONS: TransactionType[] = ["INCOME", "EXPENSE"];
