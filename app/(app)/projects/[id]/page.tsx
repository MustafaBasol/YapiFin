import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth/guard";
import { getProjectForUser } from "@/server/services/project-service";
import { listUsers } from "@/server/services/user-service";
import { ServiceError } from "@/server/services/errors";
import { canCreateProject, canManageProjectTeam, ROLE_LABELS } from "@/lib/permissions";
import { formatDate, formatMoney } from "@/lib/utils";
import { PROJECT_STATUS_META, PROJECT_STATUS_OPTIONS } from "@/components/app/project-status";
import { ProjectStatusForm } from "@/components/app/project-status-form";
import { ProjectTeam } from "@/components/app/project-team";

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

  return (
    <div className="mx-auto max-w-4xl animate-fade-in space-y-6">
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
