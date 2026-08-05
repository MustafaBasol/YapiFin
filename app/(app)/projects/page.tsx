import Link from "next/link";
import { Plus } from "lucide-react";
import { requireUser } from "@/lib/auth/guard";
import { listProjectsForUser } from "@/server/services/project-service";
import { canCreateProject } from "@/lib/permissions";
import { ProjectsTable } from "@/components/app/projects-table";

export default async function ProjectsPage() {
  const user = await requireUser();
  const projects = await listProjectsForUser(user);

  const rows = projects.map((p) => ({
    id: p.id,
    code: p.code,
    name: p.name,
    status: p.status,
    customerName: p.customer?.name ?? null,
    contractAmount: p.contractAmount.toString(),
    memberCount: p._count.members,
  }));

  return (
    <div className="mx-auto max-w-[1500px] animate-fade-in space-y-6">
      <div className="flex flex-wrap items-center gap-3">
        <div>
          <h1 className="font-display text-2xl font-bold tracking-tight">Projeler</h1>
          <p className="mt-0.5 text-sm text-muted-foreground">Tüm projeler, durumları ve sözleşme bedelleriyle.</p>
        </div>
        {canCreateProject(user.role) && (
          <Link
            href="/projects/new"
            className="ml-auto inline-flex h-9 items-center gap-1.5 rounded-lg bg-primary px-3.5 text-[13px] font-semibold text-primary-foreground shadow-sm transition-opacity hover:opacity-90"
          >
            <Plus className="h-4 w-4" />
            Yeni proje
          </Link>
        )}
      </div>

      <ProjectsTable projects={rows} />
    </div>
  );
}
