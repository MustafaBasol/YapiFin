export const SUPPLIER_TYPE_META: Record<string, { label: string; tone: string }> = {
  SUPPLIER: { label: "Tedarikçi", tone: "bg-info/12 text-info" },
  SUBCONTRACTOR: { label: "Taşeron", tone: "bg-warning/15 text-warning-foreground" },
  BOTH: { label: "Her ikisi", tone: "bg-primary/10 text-primary" },
};

export const SUPPLIER_TYPE_OPTIONS = ["SUPPLIER", "SUBCONTRACTOR", "BOTH"] as const;
