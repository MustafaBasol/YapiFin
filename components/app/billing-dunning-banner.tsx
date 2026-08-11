"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";
import { openBillingPortalAction } from "@/app/actions/billing";
import { initialActionState } from "@/lib/action-state";
import { FormAlert } from "@/components/auth/field-error";
import { cn, formatDateTime } from "@/lib/utils";
import type { OrganizationBillingHealth } from "@/server/services/billing/billing-health-service";

/**
 * YF-814 — görev talimatı madde 8: OWNER/yetkili faturalama kullanıcıları
 * için EN AZ şu durumları gösteren minimal üretim-kalitesinde UI: sağlıklı,
 * başarısız ödeme uyarısı, grace period son tarihi, grace süresi
 * dolmuş/kısıtlı durum, kurtarılmış durum. `components/app/billing-operations-view.tsx`
 * (YF-815) İLE AYNI Badge/banner idiomu — Stripe iç detayları (ham durum
 * dizeleri, abonelik/fatura ID'leri) KULLANICIYA GÖSTERİLMEZ, yalnızca
 * Türkçe, GG.AA.YYYY SS:DD biçimli mutlak tarihler kullanılır (bkz.
 * lib/utils.ts formatDateTime — Europe/Istanbul).
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
  const { subscriptionStatus, paymentFailureState, gracePeriodEndsAt, recoveredAt, disputeRestricted } = health;

  // Hiç Stripe aboneliği yoksa (ör. deneme/manuel plan) gösterilecek bir
  // faturalama durumu YOKTUR — gereksiz bir "boş" kart İCAT EDİLMEZ.
  if (!subscriptionStatus) return null;

  const isRestricted = paymentFailureState === "RESTRICTED" || disputeRestricted;
  const isGraceActive = paymentFailureState === "GRACE_PERIOD";
  const isHealthy = !isRestricted && !isGraceActive;

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
            {canManage && <UpdatePaymentMethodButton />}
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
            {canManage && <UpdatePaymentMethodButton />}
          </div>
        </div>
      )}

      {isHealthy && (
        <div className="flex flex-wrap items-center gap-2 rounded-xl border border-border bg-card px-4 py-3">
          <span className={cn("inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[12px] font-semibold", "bg-success/12 text-success")}>
            Faturalama durumu: Güncel
          </span>
          {recoveredAt && (
            <span className="text-xs text-muted-foreground">
              Son ödeme sorunu {formatDateTime(recoveredAt)} tarihinde çözüldü.
            </span>
          )}
        </div>
      )}
    </div>
  );
}

function UpdatePaymentMethodButton() {
  const [state, formAction] = useActionState(openBillingPortalAction, initialActionState);
  return (
    <form action={formAction} className="shrink-0 space-y-1.5">
      <SubmitButton />
      <FormAlert error={state?.error} />
    </form>
  );
}

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="inline-block rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-70"
    >
      {pending ? "Yönlendiriliyor…" : "Ödeme yöntemini güncelle"}
    </button>
  );
}
