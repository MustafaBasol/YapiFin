import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { requireUser } from "@/lib/auth/guard";
import { getProjectBudgetPlanning } from "@/server/services/project-budget-service";
import { listCategoriesForTransactionForm } from "@/server/services/category-service";
import { ServiceError } from "@/server/services/errors";
import { ProjectBudgetSection } from "@/components/app/project-budget-section";

export default async function ProjectBudgetPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await requireUser();

  let planning;
  try {
    planning = await getProjectBudgetPlanning(user, id);
  } catch (err) {
    if (err instanceof ServiceError && err.code === "NOT_FOUND") notFound();
    throw err;
  }

  const activeCategoryOptions = planning.canManage
    ? (await listCategoriesForTransactionForm(user, "EXPENSE")).map((c) => ({ id: c.id, name: c.name }))
    : [];

  return (
    <div className="mx-auto max-w-[1200px] animate-fade-in space-y-6">
      <div>
        <Link
          href={`/projects/${planning.project.id}`}
          className="inline-flex items-center gap-1.5 text-[12.5px] font-medium text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          Projeye dön
        </Link>
        <div className="mt-2 flex flex-wrap items-baseline gap-2">
          <h1 className="font-display text-2xl font-bold tracking-tight">{planning.project.name}</h1>
          <span className="text-sm text-muted-foreground">({planning.project.code})</span>
        </div>
        <p className="mt-0.5 text-sm text-muted-foreground">Bütçe Planlaması</p>
      </div>

      <ProjectBudgetSection planning={planning} activeCategoryOptions={activeCategoryOptions} />
    </div>
  );
}
