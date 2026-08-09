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

/** YF-605-D-UI — provider-nötr hata sınıflandırması için güvenli, Türkçe kullanıcı mesajları (bkz. `IntegrationErrorCategory`). */
export const INTEGRATION_ERROR_CATEGORY_META: Record<string, { label: string; tone: "warning" | "destructive" | "neutral" }> = {
  AUTH_CONFIG: { label: "Kimlik doğrulama/yapılandırma hatası", tone: "destructive" },
  VALIDATION: { label: "Geçersiz sorgu", tone: "warning" },
  TEMPORARY_PROVIDER: { label: "Sağlayıcı geçici olarak yanıt vermiyor", tone: "warning" },
  RATE_LIMIT: { label: "İstek sınırına ulaşıldı, kısa süre sonra tekrar deneyin", tone: "warning" },
  TIMEOUT_NETWORK: { label: "Bağlantı zaman aşımına uğradı", tone: "warning" },
  PERMANENT_REJECTION: { label: "Sağlayıcı isteği kalıcı olarak reddetti", tone: "destructive" },
  UNKNOWN: { label: "Beklenmeyen bir hata oluştu", tone: "destructive" },
};

/** YF-605-D-UI — normalize edilmiş belge durumu rozetleri (bkz. `NormalizedDocumentStatus`). */
export const NORMALIZED_DOCUMENT_STATUS_META: Record<string, { label: string; tone: "neutral" | "success" | "warning" | "destructive" | "info" }> = {
  PENDING: { label: "Beklemede", tone: "info" },
  ACCEPTED: { label: "Kabul edildi", tone: "success" },
  REJECTED: { label: "Reddedildi", tone: "destructive" },
  ERROR: { label: "Hata", tone: "destructive" },
  UNKNOWN: { label: "Bilinmiyor", tone: "neutral" },
};
