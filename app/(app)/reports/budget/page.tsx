import { AlertTriangle, HardHat, PiggyBank, Target, TrendingUp, Wallet } from "lucide-react";
import { requireUser } from "@/lib/auth/guard";
import { getBudgetReport } from "@/server/services/budget-report-service";
import { listProjectsForUser } from "@/server/services/project-service";
import { listCategoriesForUser } from "@/server/services/category-service";
import { canViewAllProjects } from "@/lib/permissions";
import { parseBudgetFilter } from "@/lib/validation/reports";
import { formatMoney } from "@/lib/utils";
import { StatCard } from "@/components/app/stat-card";
import { ChartCard } from "@/components/app/report-chart-card";
import { BudgetFilterBar } from "@/components/app/budget-filter-bar";
import { BudgetCategoryTrendChart } from "@/components/app/budget-charts";
import {
  BudgetProjectTable,
  BudgetCategoryTable,
  BudgetProjectCategoryMatrix,
  BudgetOverBudgetList,
  BudgetAtRiskList,
  BudgetNoBudgetList,
} from "@/components/app/budget-tables";
import { ReportExportButtons } from "@/components/app/report-export-buttons";
import type { BudgetReport } from "@/server/services/budget-report-service";

export default async function BudgetReportPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await requireUser();
  const rawParams = await searchParams;
  const filter = parseBudgetFilter(rawParams);

  const [data, projects, categories] = await Promise.all([
    getBudgetReport(user, filter),
    listProjectsForUser(user),
    canViewAllProjects(user.role) ? listCategoriesForUser(user) : Promise.resolve([]),
  ]);

  const expenseCategories = categories.filter((c) => c.type === "EXPENSE");

  return (
    <div className="mx-auto max-w-[1500px] animate-fade-in space-y-6">
      <div className="flex flex-wrap items-center gap-3">
        <div>
          <h1 className="font-display text-2xl font-bold tracking-tight">Bütçe Analizi</h1>
          <p className="mt-0.5 text-sm text-muted-foreground">Proje bütçe kullanımı ve gider kategori dağılımı.</p>
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-2.5">
          <BudgetFilterBar
            projects={projects.map((p) => ({ id: p.id, name: p.name }))}
            categories={expenseCategories.map((c) => ({ id: c.id, name: c.name }))}
            selectedProjectId={data.projectFilter?.id ?? null}
            selectedCategoryId={filter.categoryId ?? null}
          />
          <ReportExportButtons
            endpoint="/api/exports/budget"
            params={{ projectId: data.projectFilter?.id, categoryId: filter.categoryId }}
          />
        </div>
      </div>

      {data.scope === "PROJECT_MANAGER" && !data.hasAssignedProjects ? <EmptyPmState /> : <BudgetReportBody data={data} />}
    </div>
  );
}

function EmptyPmState() {
  return (
    <div className="grid place-items-center rounded-2xl border border-dashed border-border bg-card py-20 text-center">
      <HardHat className="h-8 w-8 text-muted-foreground/50" />
      <p className="mt-3 text-sm text-muted-foreground">Henüz bir projeye atanmadınız.</p>
      <p className="mt-1 text-[12.5px] text-muted-foreground">
        Bütçe analizini görebilmek için firma sahibinizin sizi bir projeye ataması gerekir.
      </p>
    </div>
  );
}

function BudgetReportBody({ data }: { data: BudgetReport }) {
  const { metrics } = data;
  return (
    <div className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard icon={Wallet} label="Toplam Proje Bütçesi" value={formatMoney(metrics.totalProjectBudget)} hint="Tüm projeler" />
        <StatCard icon={TrendingUp} label="Gerçekleşen Gider" value={formatMoney(metrics.totalRealizedExpenses)} hint="İptal hariç" />
        <StatCard icon={PiggyBank} label="Ödenen Gider" value={formatMoney(metrics.totalPaidExpenses)} hint="Aktif ödemeler" />
        <StatCard
          icon={Target}
          label="Kalan Bütçe"
          value={formatMoney(metrics.totalRemainingBudget)}
          hint={metrics.budgetUsagePercentage ? `Kullanım: %${metrics.budgetUsagePercentage.replace(".", ",")}` : "Bütçe girilmemiş"}
          tone={Number(metrics.totalRemainingBudget) < 0 ? "destructive" : "neutral"}
        />
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          icon={AlertTriangle}
          label="Bütçe Aşan Proje"
          value={String(metrics.projectsOverBudgetCount)}
          hint="Aktif projeler"
          tone={metrics.projectsOverBudgetCount > 0 ? "destructive" : "neutral"}
        />
        <StatCard
          icon={AlertTriangle}
          label="Bütçesi Kritik Proje"
          value={String(metrics.projectsAtRiskCount)}
          hint="%80 ve üzeri kullanım"
          tone={metrics.projectsAtRiskCount > 0 ? "warning" : "neutral"}
        />
        <StatCard icon={HardHat} label="Bütçesiz Aktif Proje" value={String(metrics.projectsWithoutBudgetCount)} hint="Bütçe girilmemiş" />
        <StatCard
          icon={Target}
          label="Ortalama Bütçe Kullanımı"
          value={metrics.averageBudgetUtilization ? `%${metrics.averageBudgetUtilization.replace(".", ",")}` : "—"}
          hint="Yalnızca bütçeli aktif projeler"
        />
      </div>

      <ChartCard title="Proje Bütçe Karşılaştırması" subtitle={`${data.projectComparison.length} proje`}>
        <BudgetProjectTable rows={data.projectComparison} />
      </ChartCard>

      <div className="grid gap-4 lg:grid-cols-2">
        <ChartCard title="Bütçeyi Aşan Projeler" subtitle="Aktif projeler">
          <BudgetOverBudgetList rows={data.overBudgetProjects} />
        </ChartCard>
        <ChartCard title="Bütçe Sınırına Yaklaşan Projeler" subtitle="%80 ve üzeri kullanım, aktif projeler">
          <BudgetAtRiskList rows={data.atRiskProjects} />
        </ChartCard>
      </div>

      {data.projectsWithoutBudget.length > 0 && (
        <ChartCard title="Bütçesi Girilmemiş Projeler" subtitle="Aktif projeler">
          <BudgetNoBudgetList rows={data.projectsWithoutBudget} />
        </ChartCard>
      )}

      <ChartCard title="Gider Kategori Analizi" subtitle={`${data.categoryAnalysis.length} kategori`}>
        <BudgetCategoryTable rows={data.categoryAnalysis} />
      </ChartCard>

      <ChartCard
        title="Aylık Kategori Trendi"
        subtitle={data.categoryMonthlyTrend.length === 1 ? data.categoryMonthlyTrend[0].name : "Son 12 ay, en çok harcanan ilk 5 kategori"}
      >
        <BudgetCategoryTrendChart series={data.categoryMonthlyTrend} />
      </ChartCard>

      <ChartCard title="Proje × Kategori Dağılımı" subtitle="En yüksek harcamalı kombinasyonlar">
        <BudgetProjectCategoryMatrix rows={data.projectCategoryMatrix} truncated={data.projectCategoryMatrixTruncated} />
      </ChartCard>
    </div>
  );
}
