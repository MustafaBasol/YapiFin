import Link from "next/link";
import { notFound } from "next/navigation";
import { requirePlatformAdmin } from "@/lib/auth/platform-guard";
import { getPlatformOrganizationDetail } from "@/server/services/platform/platform-organization-service";
import { listActiveCanonicalPlans, NO_PLAN_CODE } from "@/server/services/platform/platform-plan-override-service";
import { ServiceError } from "@/server/services/errors";
import type { LimitCheckResult } from "@/lib/entitlements/entitlement-service";
import { ROLE_LABELS } from "@/lib/permissions";
import { cn, formatDate, formatDateTime, formatNumber } from "@/lib/utils";
import {
  BillingHealthBadge,
  ProjectStatusBadge,
  SubscriptionStatusBadge,
  UserStatusBadge,
} from "@/components/platform/platform-status";
import { PlanOverridePanel } from "@/components/platform/plan-override-panel";

const PAYMENT_FAILURE_LABELS: Record<string, string> = {
  NONE: "Yok",
  GRACE_PERIOD: "Ödeme gecikmesi (grace period)",
  RESTRICTED: "Kısıtlı",
};

const BILLING_INTERVAL_LABELS: Record<string, string> = {
  MONTHLY: "Aylık",
  ANNUAL: "Yıllık",
};

function DateField({ label, value }: { label: string; value: Date | null }) {
  return (
    <div>
      <p className="text-[11.5px] text-muted-foreground">{label}</p>
      <p className="text-[13px] font-medium text-foreground">{value ? formatDate(value) : "—"}</p>
    </div>
  );
}

function TextField({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <p className="text-[11.5px] text-muted-foreground">{label}</p>
      <div className="text-[13px] font-medium text-foreground">{value}</div>
    </div>
  );
}

function SectionCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-2xl border border-border bg-card p-5 shadow-soft">
      <h2 className="font-display text-[15px] font-semibold tracking-tight">{title}</h2>
      <div className="mt-4">{children}</div>
    </section>
  );
}

function UsageMeter({ label, result }: { label: string; result: LimitCheckResult }) {
  const maxLabel = result.max === null ? "Sınırsız" : formatNumber(result.max);
  return (
    <div className="rounded-xl border border-border p-3.5">
      <div className="flex items-center justify-between gap-2">
        <p className="text-[12.5px] font-medium text-muted-foreground">{label}</p>
        {result.isOverLimit && (
          <span className="rounded-full bg-destructive/10 px-2 py-0.5 text-[11px] font-semibold text-destructive">
            Limit aşıldı
          </span>
        )}
      </div>
      <p className="tnum mt-1.5 text-[20px] font-bold leading-none">
        {formatNumber(result.used)} <span className="text-[13px] font-normal text-muted-foreground">/ {maxLabel}</span>
      </p>
      <p className="mt-1.5 text-[11.5px] text-muted-foreground">
        Dahil: {result.includedMax === null ? "Sınırsız" : formatNumber(result.includedMax)} · Ek paket:{" "}
        {formatNumber(result.addonMax)}
      </p>
    </div>
  );
}

export default async function PlatformOrganizationDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await requirePlatformAdmin();
  const { id } = await params;

  let detail;
  try {
    detail = await getPlatformOrganizationDetail(id);
  } catch (err) {
    if (err instanceof ServiceError && err.code === "NOT_FOUND") notFound();
    throw err;
  }
  const canonicalPlans = await listActiveCanonicalPlans();

  return (
    <div className="mx-auto max-w-[1400px] animate-fade-in space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <Link href="/platform/organizations" className="text-[12.5px] font-medium text-primary hover:underline">
            ← Organizasyonlara dön
          </Link>
          <h1 className="mt-1 font-display text-2xl font-bold tracking-tight">{detail.name}</h1>
          {detail.tradeName && <p className="mt-0.5 text-sm text-muted-foreground">{detail.tradeName}</p>}
        </div>
        <div className="flex items-center gap-2">
          <BillingHealthBadge category={detail.billingHealthCategory} />
          <SubscriptionStatusBadge status={detail.subscriptionStatus} />
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <SectionCard title="Kimlik">
          <div className="grid grid-cols-2 gap-4">
            <TextField label="Organizasyon Kimliği" value={<span className="font-mono text-[12px]">{detail.id}</span>} />
            <DateField label="Oluşturulma" value={detail.createdAt} />
            <TextField
              label="Sahip"
              value={
                detail.owner ? (
                  <div>
                    <p>{detail.owner.name}</p>
                    <p className="text-[12px] font-normal text-muted-foreground">{detail.owner.email}</p>
                  </div>
                ) : (
                  "—"
                )
              }
            />
            <TextField label="Kullanıcı / Proje" value={`${formatNumber(detail.userCount)} kullanıcı · ${formatNumber(detail.projectCount)} proje`} />
          </div>
        </SectionCard>

        <SectionCard title="Abonelik">
          <div className="grid grid-cols-2 gap-4">
            <TextField label="Plan" value={detail.plan ? `${detail.plan.name} (${detail.plan.code})` : "Plansız"} />
            <TextField
              label="Faturalama Aralığı"
              value={detail.billingInterval ? BILLING_INTERVAL_LABELS[detail.billingInterval] ?? detail.billingInterval : "—"}
            />
            <TextField label="Stripe Müşteri Kimliği" value={<span className="font-mono text-[12px]">{detail.stripeCustomerIdMasked ?? "—"}</span>} />
            <TextField
              label="Dönem Sonunda İptal"
              value={
                detail.cancelAtPeriodEnd ? (
                  <span className="text-warning-foreground">Evet</span>
                ) : (
                  "Hayır"
                )
              }
            />
            <DateField label="Geçerli Dönem Başlangıcı" value={detail.currentPeriodStart} />
            <DateField label="Geçerli Dönem Bitişi" value={detail.currentPeriodEnd} />
            <DateField label="Deneme Başlangıcı" value={detail.trialStart} />
            <DateField label="Deneme Bitişi" value={detail.trialEnd} />
            <TextField label="Ödeme Gecikmesi Durumu" value={PAYMENT_FAILURE_LABELS[detail.paymentFailureState] ?? detail.paymentFailureState} />
            <DateField label="Gecikme Başlangıcı" value={detail.delinquentSince} />
            <DateField label="Grace Period Bitişi" value={detail.gracePeriodEndsAt} />
            <DateField label="Kurtarma Tarihi" value={detail.recoveredAt} />
            <TextField
              label="Ödeme İtirazı Kısıtlaması"
              value={
                detail.disputeRestricted ? (
                  <span className="text-destructive">Aktif</span>
                ) : (
                  "Yok"
                )
              }
            />
          </div>
        </SectionCard>
      </div>

      <SectionCard title="Plan Yönetimi (Platform Admin)">
        <PlanOverridePanel
          organizationId={detail.id}
          currentPlanCode={detail.plan?.code ?? NO_PLAN_CODE}
          currentPlanName={detail.plan?.name ?? "Plansız"}
          billingSource={detail.planBillingSource}
          activeOverride={detail.activePlanOverride}
          plans={canonicalPlans}
        />
      </SectionCard>

      <SectionCard title="Kullanım">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <UsageMeter label="Aktif kullanıcı" result={detail.usage.users} />
          <UsageMeter label="Aktif proje" result={detail.usage.projects} />
          <UsageMeter label="Aylık yapay zekâ kullanımı" result={detail.usage.ai} />
          <UsageMeter label="Aylık OCR kullanımı" result={detail.usage.ocr} />
        </div>
        <div className="mt-4 flex flex-wrap gap-4 text-[12.5px] text-muted-foreground">
          <span>
            Yapay zekâ özellikleri:{" "}
            <span className={cn("font-semibold", detail.aiFeatureEnabled ? "text-success" : "text-muted-foreground")}>
              {detail.aiFeatureEnabled ? "Açık" : "Kapalı"}
            </span>
          </span>
          <span>
            OCR özellikleri:{" "}
            <span className={cn("font-semibold", detail.ocrFeatureEnabled ? "text-success" : "text-muted-foreground")}>
              {detail.ocrFeatureEnabled ? "Açık" : "Kapalı"}
            </span>
          </span>
        </div>
      </SectionCard>

      <SectionCard title="Kullanıcılar">
        {detail.users.length === 0 ? (
          <p className="text-sm text-muted-foreground">Bu organizasyonda henüz kullanıcı yok.</p>
        ) : (
          <div className="overflow-x-auto rounded-xl border border-border">
            <table className="w-full min-w-[640px] text-sm">
              <thead className="bg-muted/50 text-left text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 font-medium">Ad Soyad</th>
                  <th className="px-3 py-2 font-medium">E-posta</th>
                  <th className="px-3 py-2 font-medium">Rol</th>
                  <th className="px-3 py-2 font-medium">Durum</th>
                  <th className="px-3 py-2 font-medium">Katılım</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {detail.users.map((u) => (
                  <tr key={u.id}>
                    <td className="px-3 py-2 font-medium text-foreground">{u.name}</td>
                    <td className="px-3 py-2 text-muted-foreground">{u.email}</td>
                    <td className="px-3 py-2 text-foreground">{ROLE_LABELS[u.role]}</td>
                    <td className="px-3 py-2">
                      <UserStatusBadge status={u.status} />
                    </td>
                    <td className="px-3 py-2 text-muted-foreground">{formatDate(u.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </SectionCard>

      <SectionCard title="Projeler">
        {detail.projects.length === 0 ? (
          <p className="text-sm text-muted-foreground">Bu organizasyonda henüz proje yok.</p>
        ) : (
          <div className="overflow-x-auto rounded-xl border border-border">
            <table className="w-full min-w-[640px] text-sm">
              <thead className="bg-muted/50 text-left text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 font-medium">Kod</th>
                  <th className="px-3 py-2 font-medium">Ad</th>
                  <th className="px-3 py-2 font-medium">Durum</th>
                  <th className="px-3 py-2 font-medium">Oluşturulma</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {detail.projects.map((p) => (
                  <tr key={p.id}>
                    <td className="px-3 py-2 font-mono text-[12.5px] text-foreground">{p.code}</td>
                    <td className="px-3 py-2 font-medium text-foreground">{p.name}</td>
                    <td className="px-3 py-2">
                      <ProjectStatusBadge status={p.status} />
                    </td>
                    <td className="px-3 py-2 text-muted-foreground">{formatDate(p.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </SectionCard>

      <SectionCard title="Son Aktivite">
        {detail.recentAuditEntries.length === 0 ? (
          <p className="text-sm text-muted-foreground">Kayıtlı denetim (audit log) girdisi yok.</p>
        ) : (
          <div className="divide-y divide-border/60">
            {detail.recentAuditEntries.map((entry) => (
              <div key={entry.id} className="flex items-center gap-3 py-2.5">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[13px] font-medium text-foreground">
                    {entry.action} · {entry.entityType}
                  </p>
                  <p className="truncate text-[11.5px] text-muted-foreground">{entry.actorName ?? "Sistem"}</p>
                </div>
                <span className="shrink-0 text-[12px] text-muted-foreground">{formatDateTime(entry.createdAt)}</span>
              </div>
            ))}
          </div>
        )}
      </SectionCard>
    </div>
  );
}
