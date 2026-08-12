import Link from "next/link";
import {
  Ban,
  Building2,
  CalendarClock,
  CreditCard,
  HardHat,
  Hourglass,
  ShieldAlert,
  Users,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { requirePlatformAdmin } from "@/lib/auth/platform-guard";
import { getPlatformDashboardMetrics } from "@/server/services/platform/platform-dashboard-service";
import { cn, formatDate, formatNumber } from "@/lib/utils";

type CardTone = "neutral" | "warning" | "destructive";

interface MetricCard {
  icon: LucideIcon;
  label: string;
  value: number;
  hint?: string;
  tone?: CardTone;
}

const VALUE_TONE_CLASS: Record<CardTone, string> = {
  neutral: "",
  warning: "text-warning-foreground",
  destructive: "text-destructive",
};

/**
 * YF-818 — Platform Admin gösterge paneli. `requirePlatformAdmin` burada da
 * yeniden çağrılır (kiracı sayfalarının kendi guard'larını layout dışında da
 * savunma-derinliği için tekrar çağırma kuralıyla AYNI kural, bkz.
 * `app/(app)/projects/[id]/page.tsx` vb. — layout ZATEN korur ama sayfa
 * tek başına da güvenli kalır).
 */
export default async function PlatformDashboardPage() {
  await requirePlatformAdmin();
  const metrics = await getPlatformDashboardMetrics();

  const cards: MetricCard[] = [
    { icon: Building2, label: "Toplam Organizasyon", value: metrics.totalOrganizations },
    { icon: Users, label: "Toplam Kullanıcı", value: metrics.totalUsers },
    { icon: HardHat, label: "Toplam Proje", value: metrics.totalProjects },
    { icon: CreditCard, label: "Aktif Abonelik", value: metrics.activeSubscriptions },
    { icon: Hourglass, label: "Deneme Sürümü", value: metrics.trialSubscriptions },
    {
      icon: ShieldAlert,
      label: "Ödeme Gecikmesi (Grace Period)",
      value: metrics.gracePeriodOrganizations,
      tone: metrics.gracePeriodOrganizations > 0 ? "warning" : "neutral",
    },
    {
      icon: Ban,
      label: "Kısıtlı Organizasyon",
      value: metrics.restrictedOrganizations,
      tone: metrics.restrictedOrganizations > 0 ? "destructive" : "neutral",
    },
    { icon: CalendarClock, label: "Planlı İptal", value: metrics.scheduledCancellations },
  ];

  return (
    <div className="mx-auto max-w-[1400px] animate-fade-in space-y-6">
      <div>
        <h1 className="font-display text-2xl font-bold tracking-tight">Pano</h1>
        <p className="mt-0.5 text-sm text-muted-foreground">
          Platform genelinde organizasyon, kullanıcı ve faturalama sağlığı özeti.
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {cards.map((card) => (
          <div key={card.label} className="rounded-2xl border border-border bg-card p-5 shadow-soft">
            <div className="flex items-center justify-between">
              <p className="text-[12.5px] font-medium text-muted-foreground">{card.label}</p>
              <span className="grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary">
                <card.icon className="h-4 w-4" />
              </span>
            </div>
            <p className={cn("mt-2.5 tnum text-[26px] font-bold leading-none", VALUE_TONE_CLASS[card.tone ?? "neutral"])}>
              {formatNumber(card.value)}
            </p>
          </div>
        ))}
      </div>

      <div className="overflow-hidden rounded-2xl border border-border bg-card shadow-soft">
        <div className="flex items-center justify-between border-b border-border p-4">
          <h2 className="font-display text-[15px] font-semibold tracking-tight">Son Eklenen Organizasyonlar</h2>
          <Link href="/platform/organizations" className="text-[12.5px] font-medium text-primary hover:underline">
            Tüm organizasyonlar
          </Link>
        </div>
        {metrics.recentOrganizations.length === 0 ? (
          <div className="grid place-items-center py-14 text-center">
            <p className="text-sm text-muted-foreground">Henüz kayıtlı organizasyon yok.</p>
          </div>
        ) : (
          <div className="divide-y divide-border/60">
            {metrics.recentOrganizations.map((org) => (
              <Link
                key={org.id}
                href={`/platform/organizations/${org.id}`}
                className="flex items-center gap-3 px-4 py-3 transition-colors hover:bg-muted/50"
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[13px] font-medium">{org.name}</p>
                  {org.tradeName && <p className="truncate text-[11.5px] text-muted-foreground">{org.tradeName}</p>}
                </div>
                <span className="shrink-0 text-[12px] text-muted-foreground">{org.planCode ?? "Plansız"}</span>
                <span className="shrink-0 text-[12px] text-muted-foreground">{formatDate(org.createdAt)}</span>
              </Link>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
