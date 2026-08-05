import type { FinancialAccountType } from "@prisma/client";

export const FINANCIAL_ACCOUNT_TYPE_META: Record<FinancialAccountType, { label: string; tone: string }> = {
  CASH: { label: "Nakit", tone: "bg-success/12 text-success" },
  BANK: { label: "Banka", tone: "bg-info/12 text-info" },
  CREDIT_CARD: { label: "Kredi Kartı", tone: "bg-warning/15 text-warning-foreground" },
  PARTNER_ACCOUNT: { label: "Ortak Hesabı", tone: "bg-muted text-muted-foreground" },
  OTHER: { label: "Diğer", tone: "bg-muted text-muted-foreground" },
};

export const FINANCIAL_ACCOUNT_TYPE_OPTIONS: FinancialAccountType[] = [
  "CASH",
  "BANK",
  "CREDIT_CARD",
  "PARTNER_ACCOUNT",
  "OTHER",
];
