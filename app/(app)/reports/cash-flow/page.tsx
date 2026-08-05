import { AlertTriangle, Banknote, CalendarCheck2, CalendarClock, HardHat, Target, TrendingDown, TrendingUp, Wallet } from "lucide-react";
import { requireUser } from "@/lib/auth/guard";
import { getCashFlowReport } from "@/server/services/cash-flow-report-service";
import { listProjectsForUser } from "@/server/services/project-service";
import { parseCashFlowFilter } from "@/lib/validation/reports";
import { formatMoney, formatDate } from "@/lib/utils";
import { StatCard } from "@/components/app/stat-card";
import { ChartCard } from "@/components/app/report-chart-card";
import { CashFlowFilterBar } from "@/components/app/cash-flow-filter-bar";
import { CashFlowProjectionChart } from "@/components/app/cash-flow-charts";
import { CashFlowMaturityTable, CashFlowMaturityList, CashFlowProjectComparisonTable } from "@/components/app/cash-flow-tables";
import type { CashFlowReport } from "@/server/services/cash-flow-report-service";

export default async function CashFlowReportPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await requireUser();
  const rawParams = await searchParams;
  const parsed = parseCashFlowFilter(rawParams);
  const projects = await listProjectsForUser(user);

  if (!parsed.success) {
    return (
      <div className="mx-auto max-w-[1500px] animate-fade-in space-y-6">
        <PageHeader />
        <div className="grid place-items-center rounded-2xl border border-dashed border-destructive/40 bg-destructive/5 py-16 text-center">
          <AlertTriangle className="h-8 w-8 text-destructive/60" />
          <p className="mt-3 text-sm font-medium text-destructive">{parsed.error}</p>
          <p className="mt-1 text-[12.5px] text-muted-foreground">Lütfen tarih aralığını kontrol edip tekrar deneyin.</p>
        </div>
      </div>
    );
  }

  const filter = parsed.data;
  const data = await getCashFlowReport(user, filter);

  return (
    <div className="mx-auto max-w-[1500px] animate-fade-in space-y-6">
      <div className="flex flex-wrap items-center gap-3">
        <PageHeader />
        <div className="ml-auto">
          <CashFlowFilterBar
            range={filter.range}
            scenario={filter.scenario}
            startDate={filter.startDate}
            endDate={filter.endDate}
            projects={projects.map((p) => ({ id: p.id, name: p.name }))}
            selectedProjectId={data.projectFilter?.id ?? null}
          />
        </div>
      </div>

      <p className="text-[12px] text-muted-foreground">
        Dönem: {formatDate(data.rangeStart)} – {formatDate(new Date(data.rangeEnd.getTime() - 1))}
      </p>

      {data.scope === "PROJECT_MANAGER" && !data.hasAssignedProjects ? (
        <EmptyPmState />
      ) : (
        <CashFlowReportBody data={data} />
      )}
    </div>
  );
}

function PageHeader() {
  return (
    <div>
      <h1 className="font-display text-2xl font-bold tracking-tight">Nakit Akışı Raporu</h1>
      <p className="mt-0.5 text-sm text-muted-foreground">Vade takibi ve planlanan nakit akışı projeksiyonu.</p>
    </div>
  );
}

function EmptyPmState() {
  return (
    <div className="grid place-items-center rounded-2xl border border-dashed border-border bg-card py-20 text-center">
      <HardHat className="h-8 w-8 text-muted-foreground/50" />
      <p className="mt-3 text-sm text-muted-foreground">Henüz bir projeye atanmadınız.</p>
      <p className="mt-1 text-[12.5px] text-muted-foreground">
        Nakit akışı raporunu görebilmek için firma sahibinizin sizi bir projeye ataması gerekir.
      </p>
    </div>
  );
}

function CashFlowReportBody({ data }: { data: CashFlowReport }) {
  const isOrg = data.scope === "ORGANIZATION";
  const { summary } = data;

  return (
    <div className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {isOrg && (
          <StatCard icon={Wallet} label="Açılış Bakiyesi" value={formatMoney(data.openingBalance)} hint="Güncel kasa/banka" />
        )}
        <StatCard icon={TrendingUp} label="Gerçekleşen Tahsilat" value={formatMoney(summary.realizedCollections)} hint="Seçilen dönem" />
        <StatCard icon={TrendingDown} label="Gerçekleşen Ödeme" value={formatMoney(summary.realizedPayments)} hint="Seçilen dönem" />
        <StatCard
          icon={Banknote}
          label="Gerçekleşen Net Nakit Akışı"
          value={formatMoney(summary.realizedNet)}
          hint="Seçilen dönem"
          tone={Number(summary.realizedNet) >= 0 ? "success" : "destructive"}
        />
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard icon={CalendarClock} label="Planlanan Tahsilatlar" value={formatMoney(summary.scheduledCollections)} hint="Bugünden dönem sonuna" />
        <StatCard icon={CalendarClock} label="Planlanan Ödemeler" value={formatMoney(summary.scheduledPayments)} hint="Bugünden dönem sonuna" />
        <StatCard
          icon={CalendarCheck2}
          label="Beklenen Net Nakit"
          value={formatMoney(summary.scheduledNet)}
          hint="Tahmini, garanti değildir"
          tone={Number(summary.scheduledNet) >= 0 ? "success" : "destructive"}
        />
        {isOrg && (
          <StatCard
            icon={Target}
            label="Tahmini Kapanış Bakiyesi"
            value={formatMoney(data.projectedClosingBalance)}
            hint="Tahmindir — garanti nakit değildir"
          />
        )}
      </div>

      <ChartCard title="Vade Tarihi Dağılımı" subtitle="Güncel duruma göre, dönem filtresinden bağımsız">
        <CashFlowMaturityTable receivables={data.receivableBuckets} payables={data.payableBuckets} />
      </ChartCard>

      <ChartCard title="Aylık Planlanan Nakit Akışı Projeksiyonu" subtitle="Bugünden seçilen dönem sonuna">
        <CashFlowProjectionChart data={data.monthlyProjection} showRunningBalance={isOrg} />
      </ChartCard>

      {data.projectComparison.length > 0 && (
        <ChartCard title="Proje Bazlı Nakit Akışı Karşılaştırması" subtitle="En yüksek riskli/hareketli projeler">
          <CashFlowProjectComparisonTable rows={data.projectComparison} truncated={data.projectComparisonTruncated} />
        </ChartCard>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        <ChartCard title="Alacak Vade Listesi" subtitle={`${data.receivables.rows.length} kayıt`}>
          <CashFlowMaturityList section={data.receivables} counterpartLabel="Müşteri" emptyLabel="Açık alacak bulunmuyor." />
        </ChartCard>
        <ChartCard title="Borç Vade Listesi" subtitle={`${data.payables.rows.length} kayıt`}>
          <CashFlowMaturityList section={data.payables} counterpartLabel="Tedarikçi/Taşeron" emptyLabel="Açık borç bulunmuyor." />
        </ChartCard>
      </div>

      {(data.receivablesNoDueDate.rows.length > 0 || data.payablesNoDueDate.rows.length > 0) && (
        <div className="grid gap-4 lg:grid-cols-2">
          <ChartCard title="Vade Tarihi Girilmemiş Alacaklar" subtitle={`${data.receivablesNoDueDate.rows.length} kayıt`}>
            <CashFlowMaturityList section={data.receivablesNoDueDate} counterpartLabel="Müşteri" emptyLabel="Vade tarihi girilmemiş alacak yok." />
          </ChartCard>
          <ChartCard title="Vade Tarihi Girilmemiş Borçlar" subtitle={`${data.payablesNoDueDate.rows.length} kayıt`}>
            <CashFlowMaturityList section={data.payablesNoDueDate} counterpartLabel="Tedarikçi/Taşeron" emptyLabel="Vade tarihi girilmemiş borç yok." />
          </ChartCard>
        </div>
      )}
    </div>
  );
}
