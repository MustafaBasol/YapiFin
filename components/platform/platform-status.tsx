import type {
  BillingNotificationStatus,
  ProjectStatus,
  StripeDisputeRiskState,
  StripeDisputeStatus,
  StripeRefundPolicyState,
  StripeRefundStatus,
  StripeSubscriptionStatus,
  StripeWebhookEventStatus,
  UserStatus,
} from "@prisma/client";
import { Badge } from "@/components/ui/badge";
import type { PlatformBillingHealthCategory } from "@/server/services/platform/platform-organization-service";

type BadgeTone = "neutral" | "primary" | "success" | "warning" | "destructive" | "info";

/**
 * YF-818 — Platform Admin panelindeki TÜM durum rozetleri bu dosyadaki tek
 * etiket/ton eşlemesinden türetilir (görev talimatı madde 7 — tekilleştirme).
 * `Badge` bileşeni (components/ui/badge.tsx) DIŞINDA hiçbir yeni rozet
 * biçimi İCAT EDİLMEZ.
 */

export const BILLING_HEALTH_LABELS: Record<PlatformBillingHealthCategory, string> = {
  NONE: "Abonelik yok",
  TRIALING: "Deneme",
  HEALTHY: "Sağlıklı",
  GRACE_PERIOD: "Ödeme gecikmesi",
  RESTRICTED: "Kısıtlı",
  SCHEDULED_CANCELLATION: "İptal planlandı",
  CANCELED: "İptal edildi",
};

const BILLING_HEALTH_TONES: Record<PlatformBillingHealthCategory, BadgeTone> = {
  NONE: "neutral",
  TRIALING: "info",
  HEALTHY: "success",
  GRACE_PERIOD: "warning",
  RESTRICTED: "destructive",
  SCHEDULED_CANCELLATION: "warning",
  CANCELED: "neutral",
};

export function BillingHealthBadge({ category }: { category: PlatformBillingHealthCategory }) {
  return <Badge tone={BILLING_HEALTH_TONES[category]}>{BILLING_HEALTH_LABELS[category]}</Badge>;
}

export const SUBSCRIPTION_STATUS_LABELS: Record<StripeSubscriptionStatus, string> = {
  INCOMPLETE: "Eksik",
  INCOMPLETE_EXPIRED: "Süresi doldu (eksik)",
  TRIALING: "Deneme",
  ACTIVE: "Aktif",
  PAST_DUE: "Vadesi geçti",
  CANCELED: "İptal edildi",
  UNPAID: "Ödenmedi",
  PAUSED: "Duraklatıldı",
  UNKNOWN: "Bilinmiyor",
};

const SUBSCRIPTION_STATUS_TONES: Record<StripeSubscriptionStatus, BadgeTone> = {
  INCOMPLETE: "warning",
  INCOMPLETE_EXPIRED: "destructive",
  TRIALING: "info",
  ACTIVE: "success",
  PAST_DUE: "warning",
  CANCELED: "neutral",
  UNPAID: "destructive",
  PAUSED: "neutral",
  UNKNOWN: "neutral",
};

export function SubscriptionStatusBadge({ status }: { status: StripeSubscriptionStatus | null }) {
  if (!status) return <Badge tone="neutral">Abonelik yok</Badge>;
  return <Badge tone={SUBSCRIPTION_STATUS_TONES[status]}>{SUBSCRIPTION_STATUS_LABELS[status]}</Badge>;
}

export const USER_STATUS_LABELS: Record<UserStatus, string> = {
  INVITED: "Davetli",
  ACTIVE: "Aktif",
  SUSPENDED: "Pasif",
};

const USER_STATUS_TONES: Record<UserStatus, BadgeTone> = {
  INVITED: "warning",
  ACTIVE: "success",
  SUSPENDED: "destructive",
};

export function UserStatusBadge({ status }: { status: UserStatus }) {
  return <Badge tone={USER_STATUS_TONES[status]}>{USER_STATUS_LABELS[status]}</Badge>;
}

export const PROJECT_STATUS_LABELS: Record<ProjectStatus, string> = {
  DRAFT: "Taslak",
  ACTIVE: "Aktif",
  ON_HOLD: "Beklemede",
  COMPLETED: "Tamamlandı",
  CANCELLED: "İptal edildi",
};

const PROJECT_STATUS_TONES: Record<ProjectStatus, BadgeTone> = {
  DRAFT: "neutral",
  ACTIVE: "success",
  ON_HOLD: "warning",
  COMPLETED: "info",
  CANCELLED: "destructive",
};

export function ProjectStatusBadge({ status }: { status: ProjectStatus }) {
  return <Badge tone={PROJECT_STATUS_TONES[status]}>{PROJECT_STATUS_LABELS[status]}</Badge>;
}

/** YF-820 — `StripeWebhookEvent.status` (bkz. prisma/schema.prisma dosya başı notu) için tek rozet eşlemesi. */
export const WEBHOOK_EVENT_STATUS_LABELS: Record<StripeWebhookEventStatus, string> = {
  RECEIVED: "Alındı",
  PROCESSED: "İşlendi",
  FAILED: "Başarısız",
  IGNORED: "Atlandı",
};

const WEBHOOK_EVENT_STATUS_TONES: Record<StripeWebhookEventStatus, BadgeTone> = {
  RECEIVED: "info",
  PROCESSED: "success",
  FAILED: "destructive",
  IGNORED: "neutral",
};

export function WebhookEventStatusBadge({ status }: { status: StripeWebhookEventStatus }) {
  return <Badge tone={WEBHOOK_EVENT_STATUS_TONES[status]}>{WEBHOOK_EVENT_STATUS_LABELS[status]}</Badge>;
}

/** YF-820 — `components/app/billing-operations-view.tsx` (YF-815, OWNER-facing) İLE AYNI Türkçe etiketler — ikinci bir çeviri kaynağı İCAT EDİLMEZ, yalnızca Platform Admin rozet biçimine (Badge tone) taşınır. */
export const REFUND_STATUS_LABELS: Record<StripeRefundStatus, string> = {
  PENDING: "Beklemede",
  REQUIRES_ACTION: "İşlem Gerekiyor",
  SUCCEEDED: "Tamamlandı",
  FAILED: "Başarısız",
  CANCELED: "İptal Edildi",
  UNKNOWN: "Bilinmiyor",
};

const REFUND_STATUS_TONES: Record<StripeRefundStatus, BadgeTone> = {
  PENDING: "warning",
  REQUIRES_ACTION: "warning",
  SUCCEEDED: "success",
  FAILED: "destructive",
  CANCELED: "neutral",
  UNKNOWN: "neutral",
};

export function RefundStatusBadge({ status }: { status: StripeRefundStatus }) {
  return <Badge tone={REFUND_STATUS_TONES[status]}>{REFUND_STATUS_LABELS[status]}</Badge>;
}

export const REFUND_POLICY_LABELS: Record<StripeRefundPolicyState, string> = {
  NOT_APPLICABLE: "Etkisi yok",
  RETAINED: "Kısmi — kota korunuyor",
  GRANT_EXPIRED: "Kota bağışı sonlandırıldı",
  EXPIRED_AFTER_CONSUMPTION: "Sonlandırıldı — inceleme önerilir",
};

export const DISPUTE_STATUS_LABELS: Record<StripeDisputeStatus, string> = {
  WARNING_NEEDS_RESPONSE: "Erken Uyarı — Yanıt Bekleniyor",
  WARNING_UNDER_REVIEW: "Erken Uyarı — İnceleniyor",
  WARNING_CLOSED: "Erken Uyarı — Kapandı",
  NEEDS_RESPONSE: "Yanıt Bekleniyor",
  UNDER_REVIEW: "İnceleniyor",
  WON: "Kazanıldı",
  LOST: "Kaybedildi",
  PREVENTED: "Engellendi",
  UNKNOWN: "Bilinmiyor",
};

export const DISPUTE_RISK_LABELS: Record<StripeDisputeRiskState, string> = {
  FLAGGED: "İşaretlendi",
  RESTRICTED: "Kısıtlandı",
  CLEARED: "Temizlendi",
};

const DISPUTE_RISK_TONES: Record<StripeDisputeRiskState, BadgeTone> = {
  FLAGGED: "warning",
  RESTRICTED: "destructive",
  CLEARED: "success",
};

export function DisputeRiskBadge({ riskState }: { riskState: StripeDisputeRiskState }) {
  return <Badge tone={DISPUTE_RISK_TONES[riskState]}>{DISPUTE_RISK_LABELS[riskState]}</Badge>;
}

export const BILLING_NOTIFICATION_STATUS_LABELS: Record<BillingNotificationStatus, string> = {
  SCHEDULED: "Planlandı",
  SENDING: "Gönderiliyor",
  SENT: "Gönderildi",
  FAILED: "Başarısız",
};

const BILLING_NOTIFICATION_STATUS_TONES: Record<BillingNotificationStatus, BadgeTone> = {
  SCHEDULED: "info",
  SENDING: "info",
  SENT: "success",
  FAILED: "destructive",
};

export function BillingNotificationStatusBadge({ status }: { status: BillingNotificationStatus }) {
  return <Badge tone={BILLING_NOTIFICATION_STATUS_TONES[status]}>{BILLING_NOTIFICATION_STATUS_LABELS[status]}</Badge>;
}
