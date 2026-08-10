"use client";

import { useActionState, useState } from "react";
import { useFormStatus } from "react-dom";
import { CheckCircle2, MinusCircle, Sparkles } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { cn, formatNumber } from "@/lib/utils";
import { CAPABILITY_IDS, LIMIT_IDS } from "@/lib/entitlements/capabilities";
import { LIMIT_LABELS } from "@/lib/entitlements/entitlement-service";
import { startCheckoutAction } from "@/app/actions/billing";
import { initialActionState } from "@/lib/action-state";
import { FormAlert } from "@/components/auth/field-error";
import type { BillingInterval } from "@/lib/billing/stripe-config";
import type {
  CurrentUsageEntry,
  PlanComparisonEntry,
  PlanComparisonResult,
  UsageWarningState,
} from "@/server/services/plan-comparison-service";
import {
  CAPABILITY_DISPLAY_LABELS,
  PLAN_CTA_LABELS,
  PLAN_TAGLINES,
  PRICE_PLACEHOLDER_TEXT,
  formatLimitMax,
  isRecommendedPlan,
  resolveFeatureCellState,
  resolvePlanCtaKind,
} from "@/lib/plan-presentation";

/**
 * YF-805/YF-809 — Plan/fiyatlandırma karşılaştırma ekranı. Sunum kararları
 * (etiket, rozet, CTA türü) `lib/plan-presentation.ts`'ten gelir; limit/
 * yetenek verisi `server/services/plan-comparison-service.ts`'ten (kanonik
 * Plan tablosu + YF-802 entitlement servisi). Bu bileşen ikinci bir plan/
 * özellik matrisi TANIMLAMAZ.
 *
 * YF-809 — kendi kendine satın alınabilen planlar artık gerçek bir Stripe
 * Checkout akışına bağlıdır (`app/actions/billing.ts` → `startCheckoutAction`
 * → `server/services/billing/checkout-service.ts`). Bu bileşen yalnızca ince
 * bir form/CTA tüketicisidir — fiyat/plan/yetki kararı burada VERİLMEZ.
 */
export function PlanComparisonView({ data }: { data: PlanComparisonResult }) {
  const [billingInterval, setBillingInterval] = useState<BillingInterval>("MONTHLY");

  return (
    <div className="space-y-8">
      <IntervalToggle value={billingInterval} onChange={setBillingInterval} />

      <section aria-label="Plan kartları" className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {data.plans.map((plan) => (
          <PlanCard key={plan.id} plan={plan} billingInterval={billingInterval} />
        ))}
      </section>

      <UsageSection usage={data.currentUsage} />

      <FeatureTable plans={data.plans} />
    </div>
  );
}

const INTERVAL_LABELS: Record<BillingInterval, string> = {
  MONTHLY: "Aylık",
  ANNUAL: "Yıllık",
};

function IntervalToggle({
  value,
  onChange,
}: {
  value: BillingInterval;
  onChange: (interval: BillingInterval) => void;
}) {
  return (
    <div
      role="radiogroup"
      aria-label="Faturalama aralığı"
      className="inline-flex items-center gap-1 rounded-lg border border-border bg-muted/40 p-1"
    >
      {(Object.keys(INTERVAL_LABELS) as BillingInterval[]).map((interval) => (
        <button
          key={interval}
          type="button"
          role="radio"
          aria-checked={value === interval}
          onClick={() => onChange(interval)}
          className={cn(
            "rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
            value === interval
              ? "bg-card text-foreground shadow-soft"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          {INTERVAL_LABELS[interval]}
        </button>
      ))}
    </div>
  );
}

function PlanCard({ plan, billingInterval }: { plan: PlanComparisonEntry; billingInterval: BillingInterval }) {
  const recommended = isRecommendedPlan(plan.code);
  const ctaKind = resolvePlanCtaKind(plan.code, plan.isCurrent);
  const aiAllowed = plan.capabilities["ai.features"];
  const ocrAllowed = plan.capabilities.ocr;

  return (
    <div
      className={cn(
        "flex flex-col rounded-2xl border bg-card p-5 shadow-soft",
        plan.isCurrent ? "border-primary ring-2 ring-primary/25" : recommended ? "border-accent" : "border-border",
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <h2 className="font-display text-lg font-bold tracking-tight">{plan.name}</h2>
        {recommended && (
          <Badge tone="primary" aria-label="Önerilen plan" className="shrink-0">
            <Sparkles className="h-3 w-3" aria-hidden="true" />
            Önerilen
          </Badge>
        )}
      </div>

      {plan.isCurrent && (
        <Badge tone="success" aria-label="Bu sizin mevcut planınız" className="mt-2 w-fit">
          Mevcut Planınız
        </Badge>
      )}

      <p className="mt-2 min-h-10 text-sm text-muted-foreground">{PLAN_TAGLINES[plan.code]}</p>

      <p className="mt-4 text-sm font-semibold text-foreground">{PRICE_PLACEHOLDER_TEXT}</p>

      <dl className="mt-4 space-y-2.5 text-sm">
        <div className="flex items-center justify-between gap-2">
          <dt className="text-muted-foreground">{LIMIT_LABELS["users.active"]} limiti</dt>
          <dd className="font-medium">{formatLimitMax(plan.limits["users.active"].max)}</dd>
        </div>
        <div className="flex items-center justify-between gap-2">
          <dt className="text-muted-foreground">{LIMIT_LABELS["projects.active"]} limiti</dt>
          <dd className="font-medium">{formatLimitMax(plan.limits["projects.active"].max)}</dd>
        </div>
        <div className="flex items-center justify-between gap-2">
          <dt className="text-muted-foreground">Yapay zekâ</dt>
          <dd className={cn("text-right font-medium", !aiAllowed && "text-muted-foreground line-through")}>
            {aiAllowed
              ? `Dahil · aylık ${formatLimitMax(plan.limits["ai.monthly_quota"].max)} kullanım`
              : "Bu planda yer almıyor"}
          </dd>
        </div>
        <div className="flex items-center justify-between gap-2">
          <dt className="text-muted-foreground">OCR (belge/fiş okuma)</dt>
          <dd className={cn("text-right font-medium", !ocrAllowed && "text-muted-foreground line-through")}>
            {ocrAllowed
              ? `Dahil · aylık ${formatLimitMax(plan.limits["ocr.monthly_quota"].max)} belge`
              : "Bu planda yer almıyor"}
          </dd>
        </div>
      </dl>

      <div className="mt-auto pt-5">
        <PlanCta kind={ctaKind} planCode={plan.code} billingInterval={billingInterval} />
      </div>
    </div>
  );
}

function PlanCta({
  kind,
  planCode,
  billingInterval,
}: {
  kind: ReturnType<typeof resolvePlanCtaKind>;
  planCode: string;
  billingInterval: BillingInterval;
}) {
  const label = PLAN_CTA_LABELS[kind];

  if (kind === "current") {
    return (
      <span className="block rounded-lg bg-muted px-3 py-2 text-center text-sm font-semibold text-muted-foreground">
        {label}
      </span>
    );
  }

  if (kind === "contact") {
    return (
      <div>
        {/* Enterprise her zaman kendi-kendine satın alınamaz (bkz. lib/billing/stripe-config.ts CONTACT_SALES_SENTINEL) — burada bilinçli olarak hiçbir Checkout akışı tetiklenmez. */}
        <span
          aria-label={`${label} — satış ekibiyle iletişime geçin`}
          className="block rounded-lg bg-primary/40 px-3 py-2 text-center text-sm font-semibold text-primary-foreground/80"
        >
          {label}
        </span>
        <p className="mt-1.5 text-center text-[11px] leading-tight text-muted-foreground">
          Kurumsal fiyatlandırma için satış ekibimizle görüşün.
        </p>
      </div>
    );
  }

  return <CheckoutForm planCode={planCode} billingInterval={billingInterval} label={label} />;
}

function CheckoutForm({
  planCode,
  billingInterval,
  label,
}: {
  planCode: string;
  billingInterval: BillingInterval;
  label: string;
}) {
  const [state, formAction] = useActionState(startCheckoutAction, initialActionState);

  return (
    <form action={formAction} className="space-y-1.5">
      <input type="hidden" name="planCode" value={planCode} />
      <input type="hidden" name="billingInterval" value={billingInterval} />
      <FormAlert error={state?.error} />
      <CheckoutSubmitButton label={label} />
    </form>
  );
}

function CheckoutSubmitButton({ label }: { label: string }) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="w-full rounded-lg bg-primary px-3 py-2 text-sm font-semibold text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-70"
    >
      {pending ? "Yönlendiriliyor…" : label}
    </button>
  );
}

function UsageSection({ usage }: { usage: Record<(typeof LIMIT_IDS)[number], CurrentUsageEntry> }) {
  return (
    <section aria-labelledby="usage-heading" className="rounded-2xl border border-border bg-card p-5 shadow-soft">
      <h2 id="usage-heading" className="font-display text-base font-bold tracking-tight">
        Mevcut Kullanımınız
      </h2>
      <p className="mt-0.5 text-sm text-muted-foreground">
        Organizasyonunuzun güncel plana göre gerçek kullanım durumu.
      </p>
      <div className="mt-4 space-y-4">
        {LIMIT_IDS.map((limitId) => (
          <UsageRow key={limitId} label={LIMIT_LABELS[limitId]} entry={usage[limitId]} />
        ))}
      </div>
    </section>
  );
}

const WARNING_TONE: Record<UsageWarningState, string> = {
  NORMAL: "bg-success",
  WARNING: "bg-warning",
  EXHAUSTED: "bg-destructive",
};

const WARNING_BADGE_TONE: Record<UsageWarningState, "success" | "warning" | "destructive"> = {
  NORMAL: "success",
  WARNING: "warning",
  EXHAUSTED: "destructive",
};

const WARNING_TEXT: Record<UsageWarningState, string> = {
  NORMAL: "Normal",
  WARNING: "Limite Yaklaşıyor",
  EXHAUSTED: "Limit Doldu",
};

function UsageRow({ label, entry }: { label: string; entry: CurrentUsageEntry }) {
  const max = entry.max;
  const unlimited = max === null;
  const percentage = max === null ? 0 : max === 0 ? (entry.used > 0 ? 100 : 0) : Math.min((entry.used / max) * 100, 100);

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
        <span className="font-medium">{label}</span>
        <span className="flex items-center gap-2">
          <span className="text-muted-foreground">
            {max === null ? `${formatNumber(entry.used)} · Sınırsız` : `${formatNumber(entry.used)} / ${formatNumber(max)}`}
          </span>
          {!unlimited && (
            <Badge tone={WARNING_BADGE_TONE[entry.warningState]} aria-label={`Kullanım durumu: ${WARNING_TEXT[entry.warningState]}`}>
              {WARNING_TEXT[entry.warningState]}
            </Badge>
          )}
        </span>
      </div>
      {max !== null && (
        <div
          role="progressbar"
          aria-label={`${label} kullanımı`}
          aria-valuenow={entry.used}
          aria-valuemin={0}
          aria-valuemax={max}
          className="mt-1.5 h-2 w-full overflow-hidden rounded-full bg-muted"
        >
          <div
            className={cn("h-full rounded-full transition-[width]", WARNING_TONE[entry.warningState])}
            style={{ width: `${percentage}%` }}
          />
        </div>
      )}
    </div>
  );
}

function FeatureTable({ plans }: { plans: PlanComparisonEntry[] }) {
  return (
    <section aria-labelledby="feature-table-heading" className="rounded-2xl border border-border bg-card p-5 shadow-soft">
      <h2 id="feature-table-heading" className="font-display text-base font-bold tracking-tight">
        Özellik Karşılaştırması
      </h2>
      <div className="mt-4 overflow-x-auto">
        <table className="w-full min-w-[640px] border-collapse text-sm">
          <caption className="sr-only">Planlara göre limit ve özellik karşılaştırma tablosu</caption>
          <thead>
            <tr className="border-b border-border">
              <th scope="col" className="px-3 py-2 text-left font-semibold">
                Özellik
              </th>
              {plans.map((plan) => (
                <th key={plan.id} scope="col" className="px-3 py-2 text-center font-semibold">
                  {plan.name}
                  {plan.isCurrent && <span className="sr-only"> (mevcut planınız)</span>}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {LIMIT_IDS.map((limitId) => (
              <tr key={limitId} className="border-b border-border/60">
                <th scope="row" className="px-3 py-2 text-left font-normal text-muted-foreground">
                  {LIMIT_LABELS[limitId]}
                </th>
                {plans.map((plan) => (
                  <td key={plan.id} className="px-3 py-2 text-center font-medium">
                    {formatLimitMax(plan.limits[limitId].max)}
                  </td>
                ))}
              </tr>
            ))}
            {CAPABILITY_IDS.map((capabilityId) => (
              <tr key={capabilityId} className="border-b border-border/60">
                <th scope="row" className="px-3 py-2 text-left font-normal text-muted-foreground">
                  {CAPABILITY_DISPLAY_LABELS[capabilityId]}
                </th>
                {plans.map((plan) => {
                  const state = resolveFeatureCellState(plan.capabilities[capabilityId]);
                  return (
                    <td key={plan.id} className="px-3 py-2 text-center">
                      {state === "available" ? (
                        <CheckCircle2 className="mx-auto h-4 w-4 text-success" aria-label="Mevcut" />
                      ) : (
                        <MinusCircle className="mx-auto h-4 w-4 text-muted-foreground" aria-label="Mevcut değil" />
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
