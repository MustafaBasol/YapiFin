import type { StripeSubscriptionStatus } from "@prisma/client";
import { Badge } from "@/components/ui/badge";
import { ManageBillingButton } from "@/components/app/manage-billing-button";
import { formatDate, formatDateTime } from "@/lib/utils";
import type { OrganizationBillingHealth } from "@/server/services/billing/billing-health-service";

/**
 * YF-811 — `/settings/plan` üzerinde daima görünür faturalama
 * kendi-kendine-hizmet özeti: mevcut plan, abonelik durumu, planlanmış iptal
 * (varsa) ve Stripe barındırmalı Faturalama Portalına giden TEK genel CTA
 * (bkz. `manage-billing-button.tsx` dosya başı notu — `billing-dunning-banner.tsx`
 * İLE AYNI paylaşılan bileşen).
 *
 * Hiç Stripe aboneliği YOKSA (deneme/manuel/ücretsiz plan — henüz hiç
 * Checkout'tan geçmemiş organizasyon) bu kart HİÇBİR ŞEY render ETMEZ —
 * `billing-dunning-banner.tsx` İLE AYNI "gereksiz boş kart İCAT EDİLMEZ"
 * kuralı. `OrganizationStripeSubscription` satırı OLUŞTUĞUNDA (ilk Checkout
 * webhook'u/mutabakatı) kart OTOMATİK olarak görünür hâle gelir.
 *
 * Ham Stripe durum dizeleri KULLANICIYA GÖSTERİLMEZ (bkz. görev talimatı
 * "Do not expose raw Stripe status unnecessarily") — yalnızca aşağıdaki
 * Türkçe etiket eşlemesi kullanılır. Portal'da yapılan bir değişiklik
 * (iptal, plan değişikliği, ödeme yöntemi) burada ASLA iyimser (optimistic)
 * biçimde YANSITILMAZ — bu bileşen yalnızca `getOrganizationBillingHealth`
 * (ZATEN YF-810 webhook/mutabakat ile senkronize edilmiş DB durumu) tüketir.
 */
interface BillingSubscriptionCardProps {
  readonly health: OrganizationBillingHealth;
  readonly planName: string | null;
  readonly canManage: boolean;
}

const STATUS_LABELS: Record<StripeSubscriptionStatus, string> = {
  ACTIVE: "Aktif",
  TRIALING: "Deneme sürümünde",
  PAST_DUE: "Ödeme gecikmiş",
  CANCELED: "İptal edildi",
  UNPAID: "Ödenmedi",
  PAUSED: "Duraklatıldı",
  INCOMPLETE: "Tamamlanmadı",
  INCOMPLETE_EXPIRED: "Süresi doldu",
  UNKNOWN: "Bilinmiyor",
};

const STATUS_TONE: Record<StripeSubscriptionStatus, "success" | "warning" | "destructive" | "neutral"> = {
  ACTIVE: "success",
  TRIALING: "success",
  PAST_DUE: "warning",
  CANCELED: "neutral",
  UNPAID: "destructive",
  PAUSED: "neutral",
  INCOMPLETE: "neutral",
  INCOMPLETE_EXPIRED: "neutral",
  UNKNOWN: "neutral",
};

export function BillingSubscriptionCard({ health, planName, canManage }: BillingSubscriptionCardProps) {
  const { subscriptionStatus, cancelAtPeriodEnd, currentPeriodEnd, recoveredAt, paymentFailureState } = health;

  if (!subscriptionStatus) return null;

  return (
    <section
      aria-labelledby="billing-subscription-heading"
      className="rounded-2xl border border-border bg-card p-5 shadow-soft"
    >
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 id="billing-subscription-heading" className="font-display text-base font-bold tracking-tight">
            Faturalama
          </h2>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            {planName && <span className="text-sm font-semibold text-foreground">{planName}</span>}
            <Badge tone={STATUS_TONE[subscriptionStatus]} aria-label={`Abonelik durumu: ${STATUS_LABELS[subscriptionStatus]}`}>
              {STATUS_LABELS[subscriptionStatus]}
            </Badge>
          </div>

          {cancelAtPeriodEnd && currentPeriodEnd && (
            <p className="mt-2 text-sm text-warning-foreground">
              Aboneliğiniz <strong>{formatDate(currentPeriodEnd)}</strong> tarihinde sona erecek şekilde iptal
              planlandı. O tarihe kadar mevcut planınızı tam olarak kullanmaya devam edersiniz.
            </p>
          )}

          {!cancelAtPeriodEnd && paymentFailureState === "NONE" && recoveredAt && (
            <p className="mt-2 text-xs text-muted-foreground">
              Son ödeme sorunu {formatDateTime(recoveredAt)} tarihinde çözüldü.
            </p>
          )}

          <p className="mt-2 text-xs text-muted-foreground">
            Ödeme yönteminizi güncellemek, fatura geçmişinizi görüntülemek veya aboneliğinizi yönetmek için
            Stripe&apos;ın güvenli faturalama portalını kullanın.
          </p>
        </div>

        {canManage && <ManageBillingButton label="Faturalamayı yönet" variant="outline" />}
      </div>
    </section>
  );
}
