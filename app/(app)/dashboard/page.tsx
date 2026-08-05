import { Suspense } from "react";
import Link from "next/link";
import {
  AlertTriangle,
  Banknote,
  HandCoins,
  HardHat,
  Landmark,
  ListChecks,
  Plus,
  TrendingDown,
  TrendingUp,
  Truck,
  Users as UsersIcon,
} from "lucide-react";
import { requireUser } from "@/lib/auth/guard";
import { getDashboardData } from "@/server/services/dashboard-service";
import { listProjectsForUser } from "@/server/services/project-service";
import { parseDashboardFilter } from "@/lib/validation/dashboard";
import { canCreateProject } from "@/lib/permissions";
import { formatMoney } from "@/lib/utils";
import { StatCard } from "@/components/app/stat-card";
import { DashboardFilterBar } from "@/components/app/dashboard-filter-bar";
import {
  CategoryDistributionChart,
  MonthlyCashFlowChart,
  NetCashFlowChart,
  ProjectComparisonChart,
} from "@/components/app/dashboard-charts";
import { DashboardUpcomingList } from "@/components/app/dashboard-upcoming-list";
import { DashboardRecentMovements } from "@/components/app/dashboard-recent-movements";
import { TRANSACTION_STATUS_META, transactionStatusLabel } from "@/components/app/transaction-status";
import { formatDate } from "@/lib/utils";
import type { OrganizationDashboardData, ProjectManagerDashboardData } from "@/server/services/dashboard-service";

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await requireUser();
  const rawParams = await searchParams;
  const filter = parseDashboardFilter(rawParams);

  const [data, projects] = await Promise.all([getDashboardData(user, filter), listProjectsForUser(user)]);

  return (
    <div className="mx-auto max-w-[1500px] animate-fade-in space-y-6">
      <div className="flex flex-wrap items-center gap-3">
        <div>
          <h1 className="font-display text-2xl font-bold tracking-tight">Panel</h1>
          <p className="mt-0.5 text-sm text-muted-foreground">
            {user.organizationName} · Hoş geldin, {user.firstName}
          </p>
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-2.5">
          <Suspense>
            <DashboardFilterBar
              period={data.period}
              projects={projects.map((p) => ({ id: p.id, name: p.name }))}
              selectedProjectId={data.projectFilter?.id ?? null}
            />
          </Suspense>
          {canCreateProject(user.role) && (
            <Link
              href="/projects/new"
              className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-primary px-3.5 text-[13px] font-semibold text-primary-foreground shadow-sm transition-opacity hover:opacity-90"
            >
              <Plus className="h-4 w-4" />
              Yeni proje
            </Link>
          )}
        </div>
      </div>

      {data.scope === "ORGANIZATION" ? <OrganizationDashboard data={data} /> : <ProjectManagerDashboard data={data} />}
    </div>
  );
}

function OrganizationDashboard({ data }: { data: OrganizationDashboardData }) {
  const { kpis } = data;
  return (
    <div className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard icon={TrendingUp} label="Toplam Tahsilat" value={formatMoney(kpis.collectedIncome)} hint="Seçilen dönem" />
        <StatCard icon={TrendingDown} label="Toplam Ödeme" value={formatMoney(kpis.paidExpense)} hint="Seçilen dönem" />
        <StatCard
          icon={Banknote}
          label="Net Nakit Akışı"
          value={formatMoney(kpis.netCashFlow)}
          hint="Seçilen dönem"
          tone={Number(kpis.netCashFlow) >= 0 ? "success" : "destructive"}
        />
        <StatCard
          icon={Landmark}
          label="Kasa ve Banka Bakiyesi"
          value={formatMoney(kpis.cashAndBankBalance)}
          hint={data.projectFilter ? "Organizasyon geneli (proje filtresinden etkilenmez)" : "Güncel"}
        />
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard icon={HandCoins} label="Açık Alacak" value={formatMoney(kpis.openReceivable)} hint="Güncel" />
        <StatCard
          icon={AlertTriangle}
          label="Vadesi Geçen Alacak"
          value={formatMoney(kpis.overdueReceivable)}
          hint="Güncel"
          tone={Number(kpis.overdueReceivable) > 0 ? "destructive" : "neutral"}
        />
        <StatCard icon={HandCoins} label="Açık Borç" value={formatMoney(kpis.openPayable)} hint="Güncel" />
        <StatCard
          icon={AlertTriangle}
          label="Vadesi Geçen Borç"
          value={formatMoney(kpis.overduePayable)}
          hint="Güncel"
          tone={Number(kpis.overduePayable) > 0 ? "destructive" : "neutral"}
        />
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard icon={HardHat} label="Aktif Proje" value={String(kpis.activeProjectCount)} hint={`${kpis.totalProjectCount} toplam proje`} />
        <StatCard icon={UsersIcon} label="Aktif Müşteri" value={String(kpis.activeCustomerCount)} hint="organizasyonda" />
        <StatCard icon={Truck} label="Aktif Tedarikçi/Taşeron" value={String(kpis.activeSupplierCount)} hint="organizasyonda" />
        <StatCard
          icon={ListChecks}
          label="Bütçesi Kritik Proje"
          value={String(kpis.budgetCriticalProjectCount)}
          hint="Gider, bütçenin %80'ini aştı"
          tone={kpis.budgetCriticalProjectCount > 0 ? "warning" : "neutral"}
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <ChartCard title="Aylık Tahsilat / Ödeme" subtitle={monthlySeriesSubtitle(data.monthlySeriesGranularity)}>
          <MonthlyCashFlowChart data={data.monthlySeries} />
        </ChartCard>
        <ChartCard title="Aylık Net Nakit Akışı" subtitle={monthlySeriesSubtitle(data.monthlySeriesGranularity)}>
          <NetCashFlowChart data={data.monthlySeries} />
        </ChartCard>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <ChartCard title="Gider Kategorisi Dağılımı" subtitle="Seçilen dönem">
          <CategoryDistributionChart data={data.expenseCategoryDistribution} />
        </ChartCard>
        <ChartCard title="Proje Kârlılık Karşılaştırması" subtitle="Tahakkuk bazlı, organizasyon geneli, tüm zamanlar">
          <ProjectComparisonChart data={data.projectComparison} />
        </ChartCard>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <ChartCard title="Yaklaşan Tahsilatlar" subtitle="Önümüzdeki 30 gün">
          <DashboardUpcomingList items={data.upcomingCollections} emptyLabel="Yaklaşan tahsilat bulunmuyor." />
        </ChartCard>
        <ChartCard title="Yaklaşan Ödemeler" subtitle="Önümüzdeki 30 gün">
          <DashboardUpcomingList items={data.upcomingPayments} emptyLabel="Yaklaşan ödeme bulunmuyor." />
        </ChartCard>
      </div>

      <div className="overflow-hidden rounded-2xl border border-border bg-card shadow-soft">
        <div className="border-b border-border p-4">
          <h2 className="font-display text-[15px] font-semibold tracking-tight">Son Finansal Hareketler</h2>
        </div>
        <DashboardRecentMovements movements={data.recentMovements} />
      </div>
    </div>
  );
}

function ProjectManagerDashboard({ data }: { data: ProjectManagerDashboardData }) {
  if (!data.hasAssignedProjects) {
    return (
      <div className="grid place-items-center rounded-2xl border border-dashed border-border bg-card py-20 text-center">
        <HardHat className="h-8 w-8 text-muted-foreground/50" />
        <p className="mt-3 text-sm text-muted-foreground">Henüz bir projeye atanmadınız.</p>
        <p className="mt-1 text-[12.5px] text-muted-foreground">
          Proje finans özetini görebilmek için firma sahibinizin sizi bir projeye ataması gerekir.
        </p>
      </div>
    );
  }

  const { kpis } = data;
  return (
    <div className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <StatCard icon={TrendingUp} label="Toplam Tahsilat" value={formatMoney(kpis.collectedIncome)} hint="Atandığınız projeler · seçilen dönem" />
        <StatCard icon={TrendingDown} label="Toplam Ödeme" value={formatMoney(kpis.paidExpense)} hint="Atandığınız projeler · seçilen dönem" />
        <StatCard
          icon={Banknote}
          label="Net Nakit Akışı"
          value={formatMoney(kpis.netCashFlow)}
          hint="Atandığınız projeler"
          tone={Number(kpis.netCashFlow) >= 0 ? "success" : "destructive"}
        />
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard icon={HandCoins} label="Açık Alacak" value={formatMoney(kpis.openReceivable)} hint="Güncel" />
        <StatCard
          icon={AlertTriangle}
          label="Vadesi Geçen Alacak"
          value={formatMoney(kpis.overdueReceivable)}
          hint="Güncel"
          tone={Number(kpis.overdueReceivable) > 0 ? "destructive" : "neutral"}
        />
        <StatCard icon={HandCoins} label="Açık Borç" value={formatMoney(kpis.openPayable)} hint="Güncel" />
        <StatCard
          icon={AlertTriangle}
          label="Vadesi Geçen Borç"
          value={formatMoney(kpis.overduePayable)}
          hint="Güncel"
          tone={Number(kpis.overduePayable) > 0 ? "destructive" : "neutral"}
        />
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <StatCard icon={HardHat} label="Aktif Proje" value={String(kpis.activeProjectCount)} hint={`${kpis.totalProjectCount} atanmış proje`} />
        <StatCard
          icon={ListChecks}
          label="Bütçesi Kritik Proje"
          value={String(kpis.budgetCriticalProjectCount)}
          hint="Gider, bütçenin %80'ini aştı"
          tone={kpis.budgetCriticalProjectCount > 0 ? "warning" : "neutral"}
        />
        <StatCard icon={UsersIcon} label="Atanmış Proje" value={String(kpis.totalProjectCount)} hint="toplam" />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <ChartCard title="Aylık Tahsilat / Ödeme" subtitle={monthlySeriesSubtitle(data.monthlySeriesGranularity)}>
          <MonthlyCashFlowChart data={data.monthlySeries} />
        </ChartCard>
        <ChartCard title="Aylık Net Nakit Akışı" subtitle={monthlySeriesSubtitle(data.monthlySeriesGranularity)}>
          <NetCashFlowChart data={data.monthlySeries} />
        </ChartCard>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <ChartCard title="Gider Kategorisi Dağılımı" subtitle="Seçilen dönem">
          <CategoryDistributionChart data={data.expenseCategoryDistribution} />
        </ChartCard>
        <ChartCard title="Proje Kârlılık Karşılaştırması" subtitle="Tahakkuk bazlı, atandığınız projeler">
          <ProjectComparisonChart data={data.projectComparison} />
        </ChartCard>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <ChartCard title="Yaklaşan Tahsilatlar" subtitle="Önümüzdeki 30 gün">
          <DashboardUpcomingList items={data.upcomingCollections} emptyLabel="Yaklaşan tahsilat bulunmuyor." />
        </ChartCard>
        <ChartCard title="Yaklaşan Ödemeler" subtitle="Önümüzdeki 30 gün">
          <DashboardUpcomingList items={data.upcomingPayments} emptyLabel="Yaklaşan ödeme bulunmuyor." />
        </ChartCard>
      </div>

      <div className="overflow-hidden rounded-2xl border border-border bg-card shadow-soft">
        <div className="border-b border-border p-4">
          <h2 className="font-display text-[15px] font-semibold tracking-tight">Son Proje Hareketleri</h2>
        </div>
        {data.recentProjectActivity.length === 0 ? (
          <div className="grid place-items-center py-14 text-center">
            <ListChecks className="h-7 w-7 text-muted-foreground/50" />
            <p className="mt-3 text-sm text-muted-foreground">Henüz bir gelir/gider kaydı yok.</p>
          </div>
        ) : (
          <div className="divide-y divide-border/60">
            {data.recentProjectActivity.map((a) => {
              const st = TRANSACTION_STATUS_META[a.status];
              return (
                <div key={a.id} className="flex items-center gap-3 px-4 py-3">
                  <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary">
                    {a.type === "INCOME" ? <TrendingUp className="h-4 w-4" /> : <TrendingDown className="h-4 w-4" />}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[13px] font-medium leading-tight">{a.description}</p>
                    <p className="truncate text-[11.5px] text-muted-foreground">
                      {a.projectName} · {formatDate(a.issueDate)}
                    </p>
                  </div>
                  <span className="tnum text-[13px] font-semibold">{formatMoney(a.totalAmount)}</span>
                  {st && (
                    <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold ${st.tone}`}>
                      {transactionStatusLabel(a.status, a.type)}
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

function monthlySeriesSubtitle(granularity: "CURRENT_YEAR" | "LAST_12_MONTHS") {
  return granularity === "CURRENT_YEAR" ? "Bu yıl, aylık" : "Son 12 ay";
}

function ChartCard({ title, subtitle, children }: { title: string; subtitle: string; children: React.ReactNode }) {
  return (
    <div className="rounded-2xl border border-border bg-card p-5 shadow-soft">
      <div className="mb-3 flex items-baseline justify-between gap-2">
        <h2 className="font-display text-[15px] font-semibold tracking-tight">{title}</h2>
        <span className="text-[11.5px] text-muted-foreground">{subtitle}</span>
      </div>
      {children}
    </div>
  );
}
