import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { requireUser } from "@/lib/auth/guard";
import { getProjectBudgetVarianceReport } from "@/server/services/project-budget-variance-service";
import { listCategoriesForTransactionForm } from "@/server/services/category-service";
import { ServiceError } from "@/server/services/errors";
import { ProjectBudgetSection } from "@/components/app/project-budget-section";
import { ProjectBudgetVarianceSection } from "@/components/app/project-budget-variance-section";

export default async function ProjectBudgetPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await requireUser();

  let budgetReport;
  try {
    // YF-407: proje erişimi ve kalem/finans-özeti sorguları tek seferde bu
    // çağrıyla çözülür; sapma raporu YF-406 planlama DTO'sunun bir üst
    // kümesi olduğundan aynı obje hem mevcut bütçe kalemi bölümüne hem yeni
    // sapma/tahmin bölümüne aktarılır (ikinci bir proje/finans sorgusu yok).
    budgetReport = await getProjectBudgetVarianceReport(user, id);
  } catch (err) {
    if (err instanceof ServiceError && err.code === "NOT_FOUND") notFound();
    throw err;
  }

  const activeCategoryOptions = budgetReport.canManage
    ? (await listCategoriesForTransactionForm(user, "EXPENSE")).map((c) => ({ id: c.id, name: c.name }))
    : [];

  return (
    <div className="mx-auto max-w-[1200px] animate-fade-in space-y-6">
      <div>
        <Link
          href={`/projects/${budgetReport.project.id}`}
          className="inline-flex items-center gap-1.5 text-[12.5px] font-medium text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          Projeye dön
        </Link>
        <div className="mt-2 flex flex-wrap items-baseline gap-2">
          <h1 className="font-display text-2xl font-bold tracking-tight">{budgetReport.project.name}</h1>
          <span className="text-sm text-muted-foreground">({budgetReport.project.code})</span>
        </div>
        <p className="mt-0.5 text-sm text-muted-foreground">Bütçe Planlaması</p>
      </div>

      <ProjectBudgetSection planning={budgetReport} activeCategoryOptions={activeCategoryOptions} />
      <ProjectBudgetVarianceSection report={budgetReport} />
    </div>
  );
}
