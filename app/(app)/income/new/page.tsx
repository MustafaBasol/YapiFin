import { requireRole } from "@/lib/auth/guard";
import { listProjectsForUser } from "@/server/services/project-service";
import { listCustomersForUser } from "@/server/services/customer-service";
import { listCategoriesForTransactionForm } from "@/server/services/category-service";
import { IncomeForm } from "@/components/app/income-form";

export default async function NewIncomePage() {
  const user = await requireRole(["OWNER", "ADMIN", "FINANCE"]);
  const [projects, customers, categories] = await Promise.all([
    listProjectsForUser(user),
    listCustomersForUser(user),
    listCategoriesForTransactionForm(user, "INCOME"),
  ]);

  return (
    <div className="mx-auto max-w-3xl animate-fade-in space-y-6">
      <div>
        <h1 className="font-display text-2xl font-bold tracking-tight">Yeni gelir</h1>
        <p className="mt-0.5 text-sm text-muted-foreground">Gelir/alacak kaydı oluşturun.</p>
      </div>
      <div className="rounded-2xl border border-border bg-card p-6 shadow-soft">
        <IncomeForm
          projects={projects.map((p) => ({ id: p.id, name: p.name }))}
          customers={customers.map((c) => ({ id: c.id, name: c.name }))}
          categories={categories.map((c) => ({ id: c.id, name: c.name }))}
        />
      </div>
    </div>
  );
}
