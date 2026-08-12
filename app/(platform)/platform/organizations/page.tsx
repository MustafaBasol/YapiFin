import Link from "next/link";
import type { StripeSubscriptionStatus } from "@prisma/client";
import { requirePlatformAdmin } from "@/lib/auth/platform-guard";
import {
  isPlatformBillingHealthCategory,
  listPlatformOrganizations,
  PLATFORM_BILLING_HEALTH_CATEGORIES,
  type PlatformOrganizationListParams,
  type PlatformOrganizationSortField,
} from "@/server/services/platform/platform-organization-service";
import { DEFAULT_PLANS } from "@/lib/entitlements/plan-defaults";
import { formatDate, formatNumber } from "@/lib/utils";
import {
  BILLING_HEALTH_LABELS,
  BillingHealthBadge,
  SUBSCRIPTION_STATUS_LABELS,
  SubscriptionStatusBadge,
} from "@/components/platform/platform-status";

const SUBSCRIPTION_STATUSES: readonly StripeSubscriptionStatus[] = [
  "INCOMPLETE",
  "INCOMPLETE_EXPIRED",
  "TRIALING",
  "ACTIVE",
  "PAST_DUE",
  "CANCELED",
  "UNPAID",
  "PAUSED",
  "UNKNOWN",
];

const SORT_FIELDS: readonly PlatformOrganizationSortField[] = ["name", "createdAt", "userCount", "projectCount"];

const SORT_FIELD_LABELS: Record<PlatformOrganizationSortField, string> = {
  name: "Organizasyon",
  createdAt: "Oluşturulma",
  userCount: "Kullanıcı",
  projectCount: "Proje",
};

function isSubscriptionStatus(value: string): value is StripeSubscriptionStatus {
  return (SUBSCRIPTION_STATUSES as readonly string[]).includes(value);
}

function isSortField(value: string): value is PlatformOrganizationSortField {
  return (SORT_FIELDS as readonly string[]).includes(value);
}

function firstParam(value: string | string[] | undefined): string | undefined {
  const v = Array.isArray(value) ? value[0] : value;
  const trimmed = v?.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * YF-818 — Organizasyon listesi. Filtreler basit bir `GET` formu ile
 * (istemci JS gerektirmeden) query string'e yazılır — kiracı panelindeki
 * karmaşık istemci-taraflı filtre bileşenleri yerine, bu salt-okunur izleme
 * yüzeyi için en basit sunucu-taraflı desen tercih edilir.
 */
export default async function PlatformOrganizationsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requirePlatformAdmin();
  const raw = await searchParams;

  const search = firstParam(raw.search);
  const planCode = firstParam(raw.planCode);
  const subscriptionStatusRaw = firstParam(raw.subscriptionStatus);
  const subscriptionStatus = subscriptionStatusRaw && isSubscriptionStatus(subscriptionStatusRaw) ? subscriptionStatusRaw : undefined;
  const billingHealthRaw = firstParam(raw.billingHealth);
  const billingHealth = billingHealthRaw && isPlatformBillingHealthCategory(billingHealthRaw) ? billingHealthRaw : undefined;
  const sortByRaw = firstParam(raw.sortBy);
  const sortBy = sortByRaw && isSortField(sortByRaw) ? sortByRaw : undefined;
  const sortDirRaw = firstParam(raw.sortDir);
  const sortDir = sortDirRaw === "asc" || sortDirRaw === "desc" ? sortDirRaw : undefined;
  const pageRaw = Number(firstParam(raw.page));
  const page = Number.isFinite(pageRaw) && pageRaw > 0 ? Math.floor(pageRaw) : 1;

  const params: PlatformOrganizationListParams = {
    page,
    search,
    planCode,
    subscriptionStatus,
    billingHealth,
    sortBy,
    sortDir,
  };

  const result = await listPlatformOrganizations(params);
  const totalPages = Math.max(1, Math.ceil(result.total / result.pageSize));

  function withQuery(overrides: Record<string, string | number | undefined>) {
    const qs = new URLSearchParams();
    const merged = {
      search,
      planCode,
      subscriptionStatus,
      billingHealth,
      sortBy,
      sortDir,
      page: result.page,
      ...overrides,
    };
    for (const [key, value] of Object.entries(merged)) {
      if (value !== undefined && value !== "") qs.set(key, String(value));
    }
    const qsString = qs.toString();
    return qsString ? `/platform/organizations?${qsString}` : "/platform/organizations";
  }

  function sortHref(field: PlatformOrganizationSortField) {
    const nextDir = sortBy === field && sortDir === "asc" ? "desc" : "asc";
    return withQuery({ sortBy: field, sortDir: nextDir, page: 1 });
  }

  return (
    <div className="mx-auto max-w-[1400px] animate-fade-in space-y-6">
      <div>
        <h1 className="font-display text-2xl font-bold tracking-tight">Organizasyonlar</h1>
        <p className="mt-0.5 text-sm text-muted-foreground">
          Platformdaki tüm organizasyonlar, planları ve faturalama sağlığı durumu.
        </p>
      </div>

      <form
        method="GET"
        className="grid gap-3 rounded-2xl border border-border bg-card p-4 shadow-soft sm:grid-cols-2 lg:grid-cols-5"
      >
        <div className="space-y-1.5 lg:col-span-2">
          <label htmlFor="search" className="text-sm font-medium text-foreground">
            Ara
          </label>
          <input
            id="search"
            name="search"
            defaultValue={search ?? ""}
            placeholder="Organizasyon veya ticari unvan"
            className="flex h-10 w-full rounded-lg border border-input bg-card px-3 text-sm text-foreground placeholder:text-muted-foreground/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:border-ring"
          />
        </div>
        <div className="space-y-1.5">
          <label htmlFor="planCode" className="text-sm font-medium text-foreground">
            Plan
          </label>
          <select
            id="planCode"
            name="planCode"
            defaultValue={planCode ?? ""}
            className="h-10 w-full rounded-lg border border-input bg-card px-3 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <option value="">Tümü</option>
            {DEFAULT_PLANS.map((plan) => (
              <option key={plan.code} value={plan.code}>
                {plan.name}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-1.5">
          <label htmlFor="subscriptionStatus" className="text-sm font-medium text-foreground">
            Abonelik Durumu
          </label>
          <select
            id="subscriptionStatus"
            name="subscriptionStatus"
            defaultValue={subscriptionStatus ?? ""}
            className="h-10 w-full rounded-lg border border-input bg-card px-3 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <option value="">Tümü</option>
            {SUBSCRIPTION_STATUSES.map((s) => (
              <option key={s} value={s}>
                {SUBSCRIPTION_STATUS_LABELS[s]}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-1.5">
          <label htmlFor="billingHealth" className="text-sm font-medium text-foreground">
            Faturalama Sağlığı
          </label>
          <select
            id="billingHealth"
            name="billingHealth"
            defaultValue={billingHealth ?? ""}
            className="h-10 w-full rounded-lg border border-input bg-card px-3 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <option value="">Tümü</option>
            {PLATFORM_BILLING_HEALTH_CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {BILLING_HEALTH_LABELS[c]}
              </option>
            ))}
          </select>
        </div>
        <div className="flex items-end gap-2 lg:col-span-5">
          <button
            type="submit"
            className="inline-flex h-10 cursor-pointer items-center justify-center rounded-lg bg-primary px-4 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90"
          >
            Filtrele
          </button>
          <Link
            href="/platform/organizations"
            className="inline-flex h-10 items-center justify-center rounded-lg border border-border bg-card px-4 text-sm font-medium text-foreground transition-colors hover:bg-muted"
          >
            Temizle
          </Link>
        </div>
      </form>

      <div className="overflow-hidden rounded-2xl border border-border bg-card shadow-soft">
        {result.items.length === 0 ? (
          <div className="grid place-items-center py-16 text-center">
            <p className="text-sm text-muted-foreground">Filtrelere uyan organizasyon bulunamadı.</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[1040px] text-sm">
              <thead className="bg-muted/50 text-left text-muted-foreground">
                <tr>
                  <th className="px-4 py-2.5 font-medium">
                    <Link href={sortHref("name")} className="hover:text-foreground">
                      {SORT_FIELD_LABELS.name}
                    </Link>
                  </th>
                  <th className="px-4 py-2.5 font-medium">Sahip</th>
                  <th className="px-4 py-2.5 font-medium">Plan</th>
                  <th className="px-4 py-2.5 font-medium">Abonelik Durumu</th>
                  <th className="px-4 py-2.5 font-medium">Faturalama Sağlığı</th>
                  <th className="px-4 py-2.5 text-right font-medium">
                    <Link href={sortHref("userCount")} className="hover:text-foreground">
                      {SORT_FIELD_LABELS.userCount}
                    </Link>
                  </th>
                  <th className="px-4 py-2.5 text-right font-medium">
                    <Link href={sortHref("projectCount")} className="hover:text-foreground">
                      {SORT_FIELD_LABELS.projectCount}
                    </Link>
                  </th>
                  <th className="px-4 py-2.5 font-medium">Son Giriş</th>
                  <th className="px-4 py-2.5 font-medium">
                    <Link href={sortHref("createdAt")} className="hover:text-foreground">
                      {SORT_FIELD_LABELS.createdAt}
                    </Link>
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {result.items.map((org) => (
                  <tr key={org.id} className="hover:bg-muted/40">
                    <td className="px-4 py-3">
                      <Link href={`/platform/organizations/${org.id}`} className="font-medium text-foreground hover:underline">
                        {org.name}
                      </Link>
                      {org.tradeName && <p className="text-[12px] text-muted-foreground">{org.tradeName}</p>}
                    </td>
                    <td className="px-4 py-3">
                      {org.ownerName ? (
                        <>
                          <p className="text-foreground">{org.ownerName}</p>
                          <p className="text-[12px] text-muted-foreground">{org.ownerEmail}</p>
                        </>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-foreground">{org.planName ?? "Plansız"}</td>
                    <td className="px-4 py-3">
                      <SubscriptionStatusBadge status={org.subscriptionStatus} />
                    </td>
                    <td className="px-4 py-3">
                      <BillingHealthBadge category={org.billingHealth} />
                    </td>
                    <td className="tnum px-4 py-3 text-right text-foreground">{formatNumber(org.userCount)}</td>
                    <td className="tnum px-4 py-3 text-right text-foreground">{formatNumber(org.projectCount)}</td>
                    <td className="px-4 py-3 text-muted-foreground">{org.lastLoginAt ? formatDate(org.lastLoginAt) : "—"}</td>
                    <td className="px-4 py-3 text-muted-foreground">{formatDate(org.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {result.items.length > 0 && (
          <div className="flex items-center justify-between border-t border-border px-4 py-3">
            <p className="text-[12.5px] text-muted-foreground">
              {formatNumber(result.total)} organizasyon · sayfa {result.page}/{totalPages}
            </p>
            <div className="flex items-center gap-2">
              {result.page > 1 ? (
                <Link
                  href={withQuery({ page: result.page - 1 })}
                  className="rounded-lg border border-border px-3 py-1.5 text-[13px] font-medium text-foreground hover:bg-muted"
                >
                  Önceki
                </Link>
              ) : (
                <span className="rounded-lg border border-border px-3 py-1.5 text-[13px] font-medium text-muted-foreground opacity-50">
                  Önceki
                </span>
              )}
              {result.page < totalPages ? (
                <Link
                  href={withQuery({ page: result.page + 1 })}
                  className="rounded-lg border border-border px-3 py-1.5 text-[13px] font-medium text-foreground hover:bg-muted"
                >
                  Sonraki
                </Link>
              ) : (
                <span className="rounded-lg border border-border px-3 py-1.5 text-[13px] font-medium text-muted-foreground opacity-50">
                  Sonraki
                </span>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
