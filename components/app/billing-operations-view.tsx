import type { StripeDispute, StripeDisputeRiskState, StripeDisputeStatus, StripeRefund, StripeRefundPolicyState, StripeRefundStatus } from "@prisma/client";
import { cn, formatDateTime, formatMoney } from "@/lib/utils";
import { ReconcileBillingOperationsButton } from "@/components/app/reconcile-billing-operations-button";

const REFUND_STATUS_LABELS: Record<StripeRefundStatus, string> = {
  PENDING: "Beklemede",
  REQUIRES_ACTION: "İşlem Gerekiyor",
  SUCCEEDED: "Tamamlandı",
  FAILED: "Başarısız",
  CANCELED: "İptal Edildi",
  UNKNOWN: "Bilinmiyor",
};

const REFUND_STATUS_TONE: Record<StripeRefundStatus, string> = {
  PENDING: "bg-warning/15 text-warning-foreground",
  REQUIRES_ACTION: "bg-warning/15 text-warning-foreground",
  SUCCEEDED: "bg-success/12 text-success",
  FAILED: "bg-destructive/10 text-destructive",
  CANCELED: "bg-muted text-muted-foreground",
  UNKNOWN: "bg-muted text-muted-foreground",
};

const REFUND_POLICY_LABELS: Record<StripeRefundPolicyState, string> = {
  NOT_APPLICABLE: "Etkisi yok",
  RETAINED: "Kısmi — kota korunuyor",
  GRANT_EXPIRED: "Kota bağışı sonlandırıldı",
  EXPIRED_AFTER_CONSUMPTION: "Sonlandırıldı — inceleme önerilir",
};

const REFUND_POLICY_TONE: Record<StripeRefundPolicyState, string> = {
  NOT_APPLICABLE: "bg-muted text-muted-foreground",
  RETAINED: "bg-muted text-muted-foreground",
  GRANT_EXPIRED: "bg-success/12 text-success",
  EXPIRED_AFTER_CONSUMPTION: "bg-warning/15 text-warning-foreground",
};

const DISPUTE_STATUS_LABELS: Record<StripeDisputeStatus, string> = {
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

const DISPUTE_RISK_LABELS: Record<StripeDisputeRiskState, string> = {
  FLAGGED: "İşaretlendi",
  RESTRICTED: "Kısıtlandı",
  CLEARED: "Temizlendi",
};

const DISPUTE_RISK_TONE: Record<StripeDisputeRiskState, string> = {
  FLAGGED: "bg-warning/15 text-warning-foreground",
  RESTRICTED: "bg-destructive/10 text-destructive",
  CLEARED: "bg-success/12 text-success",
};

function Badge({ tone, children }: { tone: string; children: React.ReactNode }) {
  return (
    <span className={cn("inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[12px] font-semibold", tone)}>
      {children}
    </span>
  );
}

interface BillingOperationsViewProps {
  readonly refunds: readonly StripeRefund[];
  readonly disputes: readonly StripeDispute[];
  readonly canReconcile: boolean;
}

/**
 * YF-815 — destek/operatör görünürlüğü (görev talimatı madde 9). Yalnızca
 * çağıranın KENDİ organizasyonuna ait satırları gösterir (bkz.
 * server/services/billing/billing-operations-service.ts
 * `listOrganizationBillingOperations` — tenant izolasyonu servis
 * katmanındadır, bu bileşen yalnızca ZATEN scope'lanmış veriyi render eder).
 */
export function BillingOperationsView({ refunds, disputes, canReconcile }: BillingOperationsViewProps) {
  return (
    <div className="space-y-6">
      {canReconcile && (
        <div className="rounded-xl border border-border bg-card p-4">
          <ReconcileBillingOperationsButton />
        </div>
      )}

      <section className="space-y-3">
        <h2 className="font-display text-lg font-semibold">İadeler</h2>
        {refunds.length === 0 ? (
          <p className="text-sm text-muted-foreground">Henüz kaydedilmiş bir iade yok.</p>
        ) : (
          <div className="overflow-x-auto rounded-xl border border-border">
            <table className="w-full min-w-[720px] text-sm">
              <thead className="bg-muted/50 text-left text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 font-medium">Tarih</th>
                  <th className="px-3 py-2 font-medium">Tutar</th>
                  <th className="px-3 py-2 font-medium">Durum</th>
                  <th className="px-3 py-2 font-medium">Kota etkisi</th>
                  <th className="px-3 py-2 font-medium">Referans</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {refunds.map((refund) => (
                  <tr key={refund.id}>
                    <td className="px-3 py-2 text-muted-foreground">{formatDateTime(refund.createdAt)}</td>
                    <td className="px-3 py-2 font-medium">{formatMoney(refund.amount / 100, refund.currency.toUpperCase())}</td>
                    <td className="px-3 py-2">
                      <Badge tone={REFUND_STATUS_TONE[refund.status]}>{REFUND_STATUS_LABELS[refund.status]}</Badge>
                    </td>
                    <td className="px-3 py-2">
                      <Badge tone={REFUND_POLICY_TONE[refund.policyState]}>{REFUND_POLICY_LABELS[refund.policyState]}</Badge>
                    </td>
                    <td className="px-3 py-2 font-mono text-xs text-muted-foreground">{refund.stripeRefundId}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="space-y-3">
        <h2 className="font-display text-lg font-semibold">Ödeme İtirazları (Chargeback)</h2>
        {disputes.length === 0 ? (
          <p className="text-sm text-muted-foreground">Henüz kaydedilmiş bir ödeme itirazı yok.</p>
        ) : (
          <div className="overflow-x-auto rounded-xl border border-border">
            <table className="w-full min-w-[720px] text-sm">
              <thead className="bg-muted/50 text-left text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 font-medium">Tarih</th>
                  <th className="px-3 py-2 font-medium">Tutar</th>
                  <th className="px-3 py-2 font-medium">Durum</th>
                  <th className="px-3 py-2 font-medium">Hesap durumu</th>
                  <th className="px-3 py-2 font-medium">Referans</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {disputes.map((dispute) => (
                  <tr key={dispute.id}>
                    <td className="px-3 py-2 text-muted-foreground">{formatDateTime(dispute.createdAt)}</td>
                    <td className="px-3 py-2 font-medium">{formatMoney(dispute.amount / 100, dispute.currency.toUpperCase())}</td>
                    <td className="px-3 py-2">{DISPUTE_STATUS_LABELS[dispute.status]}</td>
                    <td className="px-3 py-2">
                      <Badge tone={DISPUTE_RISK_TONE[dispute.riskState]}>{DISPUTE_RISK_LABELS[dispute.riskState]}</Badge>
                    </td>
                    <td className="px-3 py-2 font-mono text-xs text-muted-foreground">{dispute.stripeDisputeId}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {disputes.some((d) => d.riskState === "RESTRICTED") && (
          <p className="rounded-lg border border-destructive/20 bg-destructive/5 px-3 py-2 text-sm text-destructive">
            Kaybedilmiş bir ödeme itirazı nedeniyle yeni ücretli özellik kullanımı geçici olarak kısıtlandı. Mevcut
            verileriniz ve raporlarınız etkilenmez. Destek ekibiyle iletişime geçin.
          </p>
        )}
      </section>
    </div>
  );
}
