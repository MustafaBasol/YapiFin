import type { BillingNotificationType } from "@prisma/client";
import { formatDateTime, formatMoney } from "@/lib/utils";
import type { PlatformOrganizationBillingOperations } from "@/server/services/platform/platform-billing-service";
import { BillingReconciliationPanel } from "@/components/platform/billing-reconciliation-panel";
import {
  BillingNotificationStatusBadge,
  DISPUTE_STATUS_LABELS,
  DisputeRiskBadge,
  REFUND_POLICY_LABELS,
  RefundStatusBadge,
  WebhookEventStatusBadge,
} from "@/components/platform/platform-status";

/**
 * YF-820 — Platform Admin organizasyon detayına eklenen faturalama
 * operasyonları bölümü. `getPlatformOrganizationDetail` (YF-818) ZATEN
 * abonelik anlık görüntüsünü/faturalama sağlığını gösteriyor — bu bileşen
 * yalnızca EK olan yaşam döngüsü zaman çizelgesi, webhook teşhisi,
 * iade/uyuşmazlık/bildirim listelerini VE manuel mutabakat panelini
 * (`BillingReconciliationPanel`) render eder. `app/(platform)/platform/
 * organizations/[id]/page.tsx`e YALNIZCA TEK bir import + TEK bir render
 * çağrısı eklenir (bkz. o dosyadaki YF-820 notu) — YF-819'un (plan
 * override kontrolleri) AYNI dosyayı eşzamanlı değiştirme riskini
 * azaltmak için TÜM YF-820 UI mantığı bu ayrı dosyadadır.
 */

export const PAYMENT_FAILURE_LABELS: Record<string, string> = {
  NONE: "Yok",
  GRACE_PERIOD: "Ödeme gecikmesi (grace period)",
  RESTRICTED: "Kısıtlı",
};

const BILLING_LIFECYCLE_ACTION_LABELS: Record<string, string> = {
  "billing.stripe_customer.create": "Stripe müşterisi oluşturuldu/eşlendi",
  "billing.checkout.create": "Checkout oturumu başlatıldı",
  "billing.subscription.entitlement_granted": "Plan hakkı verildi (abonelik aktif)",
  "billing.subscription.entitlement_revoked": "Plan hakkı geri alındı",
  "billing.invoice.payment_succeeded": "Fatura ödemesi başarılı",
  "billing.invoice.payment_failed": "Fatura ödemesi başarısız",
  "billing.dunning.grace_started": "Ödeme çözüm süresi (grace) başladı",
  "billing.dunning.recovered": "Ödeme kurtarıldı",
  "billing.refund.observed": "İade kaydedildi",
  "billing.refund.status_changed": "İade durumu değişti",
  "billing.dispute.opened": "Ödeme itirazı açıldı",
  "billing.dispute.status_changed": "Ödeme itirazı durumu değişti",
  "billing.notification.sent": "Faturalama bildirimi gönderildi",
  "billing.notification.failed": "Faturalama bildirimi başarısız",
  "billing.portal.session_created": "Faturalama portalı oturumu açıldı",
  "billing.addon_checkout.create": "Ek paket satın alma başlatıldı",
  "billing.addon.granted": "Ek paket kotası verildi",
};

const BILLING_NOTIFICATION_TYPE_LABELS: Record<BillingNotificationType, string> = {
  PAYMENT_FAILED_GRACE_STARTED: "Ödeme başarısız — grace başladı",
  GRACE_EXPIRING_REMINDER: "Grace süresi doluyor hatırlatması",
  GRACE_EXPIRED_RESTRICTED: "Grace süresi doldu — kısıtlandı",
  PAYMENT_RECOVERED: "Ödeme kurtarıldı",
};

function EmptyRow({ colSpan, children }: { colSpan: number; children: React.ReactNode }) {
  return (
    <tr>
      <td colSpan={colSpan} className="px-3 py-4 text-center text-sm text-muted-foreground">
        {children}
      </td>
    </tr>
  );
}

interface Props {
  readonly organizationId: string;
  readonly canReconcile: boolean;
  readonly operations: PlatformOrganizationBillingOperations;
}

export function OrganizationBillingOperations({ organizationId, canReconcile, operations }: Props) {
  const { lifecycleEvents, webhookEvents, refunds, disputes, notifications } = operations;

  return (
    <div className="space-y-5">
      {canReconcile && <BillingReconciliationPanel organizationId={organizationId} />}

      <div>
        <h3 className="text-[13px] font-semibold text-foreground">Yaşam Döngüsü Zaman Çizelgesi</h3>
        <p className="mt-0.5 text-[11.5px] text-muted-foreground">
          Kayıtlı denetim (audit log) girdilerinden türetilen gözlemlenmiş olaylar — kesin, tam bir geçmiş değil,
          yalnızca YapıFin&apos;in bizzat kaydettiği anlardır.
        </p>
        {lifecycleEvents.length === 0 ? (
          <p className="mt-2 text-sm text-muted-foreground">Kayıtlı bir faturalama olayı yok.</p>
        ) : (
          <div className="mt-2 divide-y divide-border/60 rounded-xl border border-border">
            {lifecycleEvents.map((event) => (
              <div key={event.id} className="flex items-center gap-3 px-3 py-2">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[12.5px] font-medium text-foreground">
                    {BILLING_LIFECYCLE_ACTION_LABELS[event.action] ?? event.action}
                  </p>
                  <p className="truncate text-[11px] text-muted-foreground">{event.actorName ?? "Sistem"}</p>
                </div>
                <span className="shrink-0 text-[11.5px] text-muted-foreground">{formatDateTime(event.createdAt)}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      <div>
        <h3 className="text-[13px] font-semibold text-foreground">Webhook Teşhisi</h3>
        <div className="mt-2 overflow-x-auto rounded-xl border border-border">
          <table className="w-full min-w-[720px] text-sm">
            <thead className="bg-muted/50 text-left text-muted-foreground">
              <tr>
                <th className="px-3 py-2 font-medium">Olay Türü</th>
                <th className="px-3 py-2 font-medium">Durum</th>
                <th className="px-3 py-2 font-medium">Deneme</th>
                <th className="px-3 py-2 font-medium">Stripe Zamanı</th>
                <th className="px-3 py-2 font-medium">İşlenme</th>
                <th className="px-3 py-2 font-medium">Hata</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {webhookEvents.length === 0 ? (
                <EmptyRow colSpan={6}>Kayıtlı webhook olayı yok.</EmptyRow>
              ) : (
                webhookEvents.map((event) => (
                  <tr key={event.id}>
                    <td className="px-3 py-2 font-mono text-[12px] text-foreground">{event.eventType}</td>
                    <td className="px-3 py-2">
                      <WebhookEventStatusBadge status={event.status} />
                    </td>
                    <td className="px-3 py-2 text-muted-foreground">{event.attempts}</td>
                    <td className="px-3 py-2 text-muted-foreground">{formatDateTime(event.stripeCreatedAt)}</td>
                    <td className="px-3 py-2 text-muted-foreground">
                      {event.processedAt ? formatDateTime(event.processedAt) : "—"}
                    </td>
                    <td className="px-3 py-2 text-[12px] text-destructive">{event.errorSummary ?? "—"}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      <div>
        <h3 className="text-[13px] font-semibold text-foreground">İadeler</h3>
        <div className="mt-2 overflow-x-auto rounded-xl border border-border">
          <table className="w-full min-w-[640px] text-sm">
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
              {refunds.length === 0 ? (
                <EmptyRow colSpan={5}>Kayıtlı iade yok.</EmptyRow>
              ) : (
                refunds.map((refund) => (
                  <tr key={refund.id}>
                    <td className="px-3 py-2 text-muted-foreground">{formatDateTime(refund.createdAt)}</td>
                    <td className="px-3 py-2 font-medium">{formatMoney(refund.amount / 100, refund.currency.toUpperCase())}</td>
                    <td className="px-3 py-2">
                      <RefundStatusBadge status={refund.status} />
                    </td>
                    <td className="px-3 py-2 text-[12px] text-muted-foreground">{REFUND_POLICY_LABELS[refund.policyState]}</td>
                    <td className="px-3 py-2 font-mono text-[11.5px] text-muted-foreground">{refund.stripeRefundId}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      <div>
        <h3 className="text-[13px] font-semibold text-foreground">Ödeme İtirazları (Chargeback)</h3>
        <div className="mt-2 overflow-x-auto rounded-xl border border-border">
          <table className="w-full min-w-[640px] text-sm">
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
              {disputes.length === 0 ? (
                <EmptyRow colSpan={5}>Kayıtlı ödeme itirazı yok.</EmptyRow>
              ) : (
                disputes.map((dispute) => (
                  <tr key={dispute.id}>
                    <td className="px-3 py-2 text-muted-foreground">{formatDateTime(dispute.createdAt)}</td>
                    <td className="px-3 py-2 font-medium">{formatMoney(dispute.amount / 100, dispute.currency.toUpperCase())}</td>
                    <td className="px-3 py-2 text-[12px] text-muted-foreground">{DISPUTE_STATUS_LABELS[dispute.status]}</td>
                    <td className="px-3 py-2">
                      <DisputeRiskBadge riskState={dispute.riskState} />
                    </td>
                    <td className="px-3 py-2 font-mono text-[11.5px] text-muted-foreground">{dispute.stripeDisputeId}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      <div>
        <h3 className="text-[13px] font-semibold text-foreground">Faturalama Bildirimleri</h3>
        <div className="mt-2 overflow-x-auto rounded-xl border border-border">
          <table className="w-full min-w-[640px] text-sm">
            <thead className="bg-muted/50 text-left text-muted-foreground">
              <tr>
                <th className="px-3 py-2 font-medium">Tür</th>
                <th className="px-3 py-2 font-medium">Durum</th>
                <th className="px-3 py-2 font-medium">Deneme</th>
                <th className="px-3 py-2 font-medium">Gönderilme</th>
                <th className="px-3 py-2 font-medium">Hata</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {notifications.length === 0 ? (
                <EmptyRow colSpan={5}>Kayıtlı bildirim yok.</EmptyRow>
              ) : (
                notifications.map((n) => (
                  <tr key={n.id}>
                    <td className="px-3 py-2 text-[12.5px] text-foreground">{BILLING_NOTIFICATION_TYPE_LABELS[n.type]}</td>
                    <td className="px-3 py-2">
                      <BillingNotificationStatusBadge status={n.status} />
                    </td>
                    <td className="px-3 py-2 text-muted-foreground">{n.attemptCount}</td>
                    <td className="px-3 py-2 text-muted-foreground">{n.sentAt ? formatDateTime(n.sentAt) : "—"}</td>
                    <td className="px-3 py-2 text-[12px] text-destructive">{n.lastError ?? "—"}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
