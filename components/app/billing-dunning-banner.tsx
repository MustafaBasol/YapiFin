"use client";

import { ManageBillingButton } from "@/components/app/manage-billing-button";
import { formatDateTime } from "@/lib/utils";
import type { OrganizationBillingHealth } from "@/server/services/billing/billing-health-service";

/**
 * YF-814 — görev talimatı madde 8: OWNER/yetkili faturalama kullanıcıları
 * için başarısız ödeme uyarısı, grace period son tarihi ve grace süresi
 * dolmuş/kısıtlı durum için acil kurtarma banner'ı. Stripe iç detayları (ham
 * durum dizeleri, abonelik/fatura ID'leri) KULLANICIYA GÖSTERİLMEZ, yalnızca
 * Türkçe, GG.AA.YYYY SS:DD biçimli mutlak tarihler kullanılır (bkz.
 * lib/utils.ts formatDateTime — Europe/Istanbul).
 *
 * YF-811 — "sağlıklı" temel durum (ve kurtarılma bilgisi) artık daima
 * görünür `components/app/billing-subscription-card.tsx`'in görevidir; bu
 * bileşen bilinçli olarak yalnızca AKTİF bir ödeme sorunu VARKEN bir şey
 * render eder (görev BAĞLAMINDA gereksiz bir ikinci "durum: güncel" kartı
 * İCAT EDİLMEZ). Portal CTA'sı `manage-billing-button.tsx` — AYNI paylaşılan
 * bileşen `billing-subscription-card.tsx` tarafından da kullanılır.
 *
 * Ödeme başarılı OLDUĞU asla webhook/mutabakat ONAYLAMADAN İDDİA EDİLMEZ —
 * bu bileşen yalnızca `getOrganizationBillingHealth` (ZATEN senkronize
 * edilmiş DB durumu) tüketir, HİÇBİR iyimser (optimistic) durum ÜRETMEZ.
 */
interface BillingDunningBannerProps {
  readonly health: OrganizationBillingHealth;
  readonly canManage: boolean;
}

export function BillingDunningBanner({ health, canManage }: BillingDunningBannerProps) {
  const { subscriptionStatus, paymentFailureState, gracePeriodEndsAt, disputeRestricted } = health;

  // Hiç Stripe aboneliği yoksa (ör. deneme/manuel plan) gösterilecek bir
  // faturalama durumu YOKTUR — gereksiz bir "boş" kart İCAT EDİLMEZ.
  if (!subscriptionStatus) return null;

  const isRestricted = paymentFailureState === "RESTRICTED" || disputeRestricted;
  const isGraceActive = paymentFailureState === "GRACE_PERIOD";

  // Sağlıklı durumda (ve zaten kurtarılmış durumda) bu banner HİÇBİR ŞEY
  // render ETMEZ — bkz. yukarıdaki dosya başı not.
  if (!isRestricted && !isGraceActive) return null;

  return (
    <div className="space-y-3">
      {isRestricted && (
        <div className="rounded-xl border border-destructive/20 bg-destructive/5 p-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <p className="text-sm font-semibold text-destructive">
                {paymentFailureState === "RESTRICTED"
                  ? "Ödeme çözüm süreniz sona erdi"
                  : "Faturalama hesabınız kısıtlandı"}
              </p>
              <p className="mt-1 text-sm text-destructive/90">
                {paymentFailureState === "RESTRICTED"
                  ? "Son ödeme deneminiz başarısız oldu ve ödeme çözüm süreniz doldu. Mevcut verileriniz ve raporlarınız etkilenmez; yeni ücretli işlem (proje, davet, belge yükleme, ekstre içe aktarma) yapabilmek için ödeme yönteminizi güncelleyin."
                  : "Çözülmemiş bir ödeme itirazı (chargeback) nedeniyle yeni ücretli özellik kullanımı geçici olarak kısıtlandı. Mevcut verileriniz etkilenmez."}
              </p>
            </div>
            {canManage && <ManageBillingButton variant="primary" label="Ödeme yöntemini güncelle" />}
          </div>
        </div>
      )}

      {!isRestricted && isGraceActive && gracePeriodEndsAt && (
        <div className="rounded-xl border border-warning/30 bg-warning/10 p-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <p className="text-sm font-semibold text-warning-foreground">Son ödeme deneminiz başarısız oldu</p>
              <p className="mt-1 text-sm text-warning-foreground/90">
                Hesabınız şu an tam olarak kullanılabilir durumda. <strong>{formatDateTime(gracePeriodEndsAt)}</strong>{" "}
                tarihine kadar ödeme yönteminizi güncellemezseniz, yeni ücretli işlemler geçici olarak kısıtlanacaktır.
              </p>
            </div>
            {canManage && <ManageBillingButton variant="primary" label="Ödeme yöntemini güncelle" />}
          </div>
        </div>
      )}
    </div>
  );
}
