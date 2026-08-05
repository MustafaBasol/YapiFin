export const CUSTOMER_TYPE_META: Record<string, { label: string; tone: string }> = {
  INDIVIDUAL: { label: "Bireysel", tone: "bg-muted text-muted-foreground" },
  COMPANY: { label: "Kurumsal", tone: "bg-info/12 text-info" },
};

export const CUSTOMER_TYPE_OPTIONS = ["INDIVIDUAL", "COMPANY"] as const;
