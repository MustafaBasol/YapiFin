"use client";

import { useActionState, useState } from "react";
import { useFormStatus } from "react-dom";
import {
  reconcilePlatformOrganizationBillingAction,
  initialPlatformBillingReconciliationState,
} from "@/app/actions/platform-billing";
import { FormAlert } from "@/components/auth/field-error";
import { formatDateTime } from "@/lib/utils";

/** `app/(platform)/platform/organizations/[id]/page.tsx` VE `organization-billing-operations.tsx` İLE AYNI etiketler — kasıtlı olarak BURADA da (küçük, 3 girdilik) tekrarlanır: bu dosya bir "use client" bileşenidir, `organization-billing-operations.tsx`yi (o dosya BU paneli render ettiği için) İTHAL ETMEK dairesel bir modül bağımlılığı OLUŞTURURDU. */
const PAYMENT_FAILURE_LABELS: Record<string, string> = {
  NONE: "Yok",
  GRACE_PERIOD: "Ödeme gecikmesi (grace period)",
  RESTRICTED: "Kısıtlı",
};

/**
 * YF-820 — Platform Admin-only manuel mutabakat butonu. `getPlatformOrganizationDetail`
 * (YF-818) sayfası zaten mevcut abonelik durumunu gösteriyor — bu panel yalnızca
 * eylemi (açık onay adımı ARDINDAN) ve SONUCUNU (önce/sonra/değişti mi/uyarılar)
 * gösterir; sayfa yenilenmeden önce ikinci bir "canlı" durum tahmini İCAT ETMEZ
 * (server action `revalidatePath` ile sayfayı zaten güncel duruma taşır).
 */
function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="inline-flex items-center rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-70"
    >
      {pending ? "Mutabakat sağlanıyor…" : "Mutabakatı onayla ve çalıştır"}
    </button>
  );
}

function SnapshotRow({ label, before, after }: { label: string; before: string; after: string }) {
  const changed = before !== after;
  return (
    <div className="flex items-center justify-between gap-3 border-b border-border/60 py-1.5 text-[12.5px] last:border-0">
      <span className="text-muted-foreground">{label}</span>
      <span className={changed ? "font-semibold text-primary" : "text-foreground"}>
        {before} {changed ? `→ ${after}` : ""}
      </span>
    </div>
  );
}

export function BillingReconciliationPanel({ organizationId }: { organizationId: string }) {
  const [state, formAction] = useActionState(
    reconcilePlatformOrganizationBillingAction,
    initialPlatformBillingReconciliationState,
  );
  const [confirming, setConfirming] = useState(false);
  const result = state.result;

  return (
    <div className="space-y-3 rounded-xl border border-border bg-muted/20 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-[13px] font-semibold text-foreground">Stripe ile mutabakat sağla</p>
          <p className="mt-0.5 text-[12px] text-muted-foreground">
            Yerel abonelik durumunu Stripe&apos;ın güncel gerçeğiyle yeniden hizalar. Yalnızca ZATEN doğru olan
            durumu yakınsatır — yeni bir plan/ücret oluşturmaz.
          </p>
        </div>
        {!confirming && (
          <button
            type="button"
            onClick={() => setConfirming(true)}
            className="inline-flex items-center rounded-lg border border-border bg-card px-4 py-2 text-sm font-semibold text-foreground transition-colors hover:bg-muted"
          >
            Mutabakat başlat
          </button>
        )}
      </div>

      {confirming && (
        <form
          action={formAction}
          className="space-y-3 rounded-lg border border-warning/30 bg-warning/5 p-3"
          onSubmit={() => setConfirming(false)}
        >
          <input type="hidden" name="organizationId" value={organizationId} />
          <p className="text-[12.5px] text-warning-foreground">
            Bu işlem, bu organizasyonun Stripe abonelik durumunu şimdi yeniden çekip yerel kayda yazacak. Devam
            etmek istediğinizden emin misiniz?
          </p>
          <label className="block text-[12px] font-medium text-muted-foreground">
            Neden (opsiyonel — destek bileti/ops notu)
            <textarea
              name="reason"
              maxLength={500}
              rows={2}
              className="mt-1 w-full rounded-lg border border-border bg-card px-2.5 py-1.5 text-[12.5px] text-foreground"
              placeholder="Örn. destek talebi #1234 kapsamında manuel doğrulama"
            />
          </label>
          <div className="flex gap-2">
            <SubmitButton />
            <button
              type="button"
              onClick={() => setConfirming(false)}
              className="rounded-lg border border-border bg-card px-4 py-2 text-sm font-medium text-muted-foreground hover:bg-muted"
            >
              Vazgeç
            </button>
          </div>
        </form>
      )}

      <FormAlert error={state.error} success={state.success} />

      {result && (
        <div className="rounded-lg border border-border bg-card p-3">
          <p className="text-[12px] font-semibold text-foreground">
            Son mutabakat sonucu — {formatDateTime(result.lastSyncAt)}
          </p>
          <div className="mt-2">
            <SnapshotRow label="Abonelik durumu" before={result.before.status ?? "—"} after={result.after.status ?? "—"} />
            <SnapshotRow label="Plan kodu" before={result.before.planCode ?? "—"} after={result.after.planCode ?? "—"} />
            <SnapshotRow
              label="Ödeme gecikmesi durumu"
              before={PAYMENT_FAILURE_LABELS[result.before.billingHealth.paymentFailureState] ?? result.before.billingHealth.paymentFailureState}
              after={PAYMENT_FAILURE_LABELS[result.after.billingHealth.paymentFailureState] ?? result.after.billingHealth.paymentFailureState}
            />
            <SnapshotRow
              label="Ödeme itirazı kısıtlaması"
              before={result.before.billingHealth.disputeRestricted ? "Aktif" : "Yok"}
              after={result.after.billingHealth.disputeRestricted ? "Aktif" : "Yok"}
            />
          </div>
          <p className="mt-2 text-[12px] text-muted-foreground">
            {result.changed ? "Durum değişti." : "Değişiklik yoktu — zaten güncel."}
          </p>
          {result.warnings.length > 0 && (
            <ul className="mt-1.5 list-inside list-disc text-[12px] text-warning-foreground">
              {result.warnings.map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
