import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth/guard";
import { getProjectForUser } from "@/server/services/project-service";
import { getProjectFinanceSummary } from "@/server/services/project-finance-service";
import { listUsers } from "@/server/services/user-service";
import { ServiceError } from "@/server/services/errors";
import { canCreateProject, canManageProjectTeam, ROLE_LABELS } from "@/lib/permissions";
import { formatDate, formatMoney } from "@/lib/utils";
import { PROJECT_STATUS_META, PROJECT_STATUS_OPTIONS } from "@/components/app/project-status";
import { ProjectStatusForm } from "@/components/app/project-status-form";
import { ProjectTeam } from "@/components/app/project-team";
import { TransactionsTable } from "@/components/app/transactions-table";
import { AccrualTrendChart, CategoryDistributionChart } from "@/components/app/dashboard-charts";
import {
  ProjectCashMovementSummary,
  ProjectFinanceDetails,
  ProjectFinanceHighlights,
  ProjectSettlementsTable,
} from "@/components/app/project-finance-summary";

export default async function ProjectDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const user = await requireUser();

  let project;
  try {
    project = await getProjectForUser(user, id);
  } catch (err) {
    if (err instanceof ServiceError && err.code === "NOT_FOUND") notFound();
    throw err;
  }

  const st = PROJECT_STATUS_META[project.status];
  const canManageTeam = canManageProjectTeam(user.role);
  const orgUsers = canManageTeam ? await listUsers(user) : [];
  const memberIds = new Set(project.members.map((m) => m.userId));
  const assignableUsers = orgUsers.filter((u) => !memberIds.has(u.id));
  const finance = await getProjectFinanceSummary(user, id);

  const incomeRows = finance.incomeList.map((r) => ({
    id: r.id,
    description: r.description,
    counterpartName: r.counterpartName,
    projectName: null,
    categoryName: r.categoryName,
    totalAmount: r.totalAmount,
    remainingAmount: r.remainingAmount,
    dueDate: r.dueDate,
    status: r.status,
    currency: r.currency,
  }));
  const expenseRows = finance.expenseList.map((r) => ({
    id: r.id,
    description: r.description,
    counterpartName: r.counterpartName,
    projectName: null,
    categoryName: r.categoryName,
    totalAmount: r.totalAmount,
    remainingAmount: r.remainingAmount,
    dueDate: r.dueDate,
    status: r.status,
    currency: r.currency,
  }));

  return (
    <div className="mx-auto max-w-[1500px] animate-fade-in space-y-6">
      <div className="flex flex-wrap items-start gap-3">
        <div>
          <h1 className="font-display text-2xl font-bold tracking-tight">{project.name}</h1>
          <p className="mt-0.5 text-sm text-muted-foreground">{project.code}</p>
        </div>
        <span className={`ml-auto inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[12px] font-semibold ${st.tone}`}>
          {st.label}
        </span>
      </div>

      <div className="grid gap-6 lg:grid-cols-[1.4fr_1fr]">
        <div className="space-y-6">
          <div className="rounded-2xl border border-border bg-card p-5 shadow-soft">
            <h2 className="font-display text-[15px] font-semibold tracking-tight">Genel bakış</h2>
            <dl className="mt-4 grid grid-cols-2 gap-4 text-sm">
              <Field label="Müşteri" value={project.customer?.name ?? "—"} />
              <Field label="Konum" value={[project.city, project.district].filter(Boolean).join(" / ") || "—"} />
              <Field label="Başlangıç" value={project.startDate ? formatDate(project.startDate) : "—"} />
              <Field label="Planlanan bitiş" value={project.plannedEndDate ? formatDate(project.plannedEndDate) : "—"} />
              <Field label="Sözleşme bedeli" value={formatMoney(project.contractAmount.toString())} />
              <Field label="Tahmini bütçe" value={formatMoney(project.estimatedBudget.toString())} />
            </dl>
            {project.notes && <p className="mt-4 text-sm text-muted-foreground">{project.notes}</p>}
          </div>

          {canCreateProject(user.role) && (
            <div className="rounded-2xl border border-border bg-card p-5 shadow-soft">
              <h2 className="font-display text-[15px] font-semibold tracking-tight">Durum</h2>
              <p className="mt-1 text-sm text-muted-foreground">Proje durumunu güncelle.</p>
              <div className="mt-3">
                <ProjectStatusForm projectId={project.id} currentStatus={project.status} options={PROJECT_STATUS_OPTIONS} />
              </div>
            </div>
          )}
        </div>

        <div className="rounded-2xl border border-border bg-card p-5 shadow-soft">
          <h2 className="font-display text-[15px] font-semibold tracking-tight">Ekip</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Proje yöneticisi rolündeki kullanıcılar yalnızca atandıkları projeleri görebilir.
          </p>
          <ProjectTeam
            projectId={project.id}
            members={project.members.map((m) => ({
              userId: m.userId,
              name: `${m.user.firstName} ${m.user.lastName}`,
              email: m.user.email,
              roleLabel: ROLE_LABELS[m.user.role],
            }))}
            assignableUsers={assignableUsers.map((u) => ({
              id: u.id,
              name: `${u.firstName} ${u.lastName}`,
              roleLabel: ROLE_LABELS[u.role],
            }))}
            canManage={canManageTeam}
          />
        </div>
      </div>

      <div className="space-y-6">
        <h2 className="font-display text-lg font-bold tracking-tight">Proje Finans Özeti</h2>
        <ProjectFinanceHighlights summary={finance} />
        <ProjectFinanceDetails summary={finance} />

        <div className="grid gap-4 lg:grid-cols-2">
          <div className="rounded-2xl border border-border bg-card p-5 shadow-soft">
            <div className="mb-3 flex items-baseline justify-between gap-2">
              <h2 className="font-display text-[15px] font-semibold tracking-tight">Aylık Gelir / Gider</h2>
              <span className="text-[11.5px] text-muted-foreground">Son 12 ay, tahakkuk bazlı</span>
            </div>
            <AccrualTrendChart data={finance.monthlyTrend} />
          </div>
          <div className="rounded-2xl border border-border bg-card p-5 shadow-soft">
            <div className="mb-3 flex items-baseline justify-between gap-2">
              <h2 className="font-display text-[15px] font-semibold tracking-tight">Gider Kategorisi Dağılımı</h2>
              <span className="text-[11.5px] text-muted-foreground">Tüm zamanlar</span>
            </div>
            <CategoryDistributionChart data={finance.categoryDistribution} />
          </div>
        </div>

        <ProjectCashMovementSummary summary={finance} />

        <div className="overflow-hidden rounded-2xl border border-border bg-card shadow-soft">
          <div className="border-b border-border p-4">
            <h2 className="font-display text-[15px] font-semibold tracking-tight">Tahsilat ve Ödeme Hareketleri</h2>
          </div>
          <ProjectSettlementsTable settlements={finance.settlements} />
        </div>

        <div className="space-y-3">
          <h2 className="font-display text-[15px] font-semibold tracking-tight">Gelirler</h2>
          <TransactionsTable rows={incomeRows} basePath="/income" type="INCOME" counterpartLabel="Müşteri" />
        </div>

        <div className="space-y-3">
          <h2 className="font-display text-[15px] font-semibold tracking-tight">Giderler</h2>
          <TransactionsTable rows={expenseRows} basePath="/expenses" type="EXPENSE" counterpartLabel="Tedarikçi" />
        </div>
      </div>
    </div>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-[11px] text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 font-medium">{value}</dd>
    </div>
  );
}
