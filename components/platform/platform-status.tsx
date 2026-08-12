import type { ProjectStatus, StripeSubscriptionStatus, UserStatus } from "@prisma/client";
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
