export const INTEGRATION_TYPE_META: Record<string, { label: string }> = {
  E_INVOICE: { label: "E-belge (e-Fatura/e-Arşiv/e-İrsaliye)" },
  ACCOUNTING: { label: "Muhasebe" },
};
export const INTEGRATION_TYPE_OPTIONS = ["E_INVOICE", "ACCOUNTING"] as const;

export const INTEGRATION_PROVIDER_META: Record<string, { label: string }> = {
  NILVERA: { label: "Nilvera" },
  UYUMSOFT: { label: "Uyumsoft" },
  IZIBIZ: { label: "İzibiz" },
  SOVOS: { label: "Sovos/Foriba" },
  QNB_ESOLUTIONS: { label: "QNB eSolutions" },
  PARASUT: { label: "Paraşüt" },
  GENERIC: { label: "Genel / henüz belirlenmedi" },
};
export const INTEGRATION_PROVIDER_OPTIONS = [
  "NILVERA",
  "UYUMSOFT",
  "IZIBIZ",
  "SOVOS",
  "QNB_ESOLUTIONS",
  "PARASUT",
  "GENERIC",
] as const;

export const INTEGRATION_ENVIRONMENT_META: Record<string, { label: string }> = {
  SANDBOX: { label: "Test (sandbox)" },
  PRODUCTION: { label: "Üretim" },
};
export const INTEGRATION_ENVIRONMENT_OPTIONS = ["SANDBOX", "PRODUCTION"] as const;

export const INTEGRATION_STATUS_META: Record<string, { label: string; tone: string }> = {
  INACTIVE: { label: "Devre dışı", tone: "bg-muted text-muted-foreground" },
  ACTIVE: { label: "Etkin", tone: "bg-success/12 text-success" },
  SUSPENDED: { label: "Askıya alındı", tone: "bg-destructive/10 text-destructive" },
};
