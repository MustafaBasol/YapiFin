import { requireRole } from "@/lib/auth/guard";
import { listProjectsForUser } from "@/server/services/project-service";
import { listSuppliersForUser } from "@/server/services/supplier-service";
import { listCategoriesForTransactionForm } from "@/server/services/category-service";
import { canViewSuppliers } from "@/lib/permissions";
import { ExpenseForm } from "@/components/app/expense-form";

export default async function NewExpensePage() {
  const user = await requireRole(["OWNER", "ADMIN", "FINANCE", "PROJECT_MANAGER"]);
  const [projects, suppliers, categories] = await Promise.all([
    listProjectsForUser(user),
    canViewSuppliers(user.role) ? listSuppliersForUser(user) : Promise.resolve([]),
    listCategoriesForTransactionForm(user, "EXPENSE"),
  ]);

  return (
    <div className="mx-auto max-w-3xl animate-fade-in space-y-6">
      <div>
        <h1 className="font-display text-2xl font-bold tracking-tight">Yeni gider</h1>
        <p className="mt-0.5 text-sm text-muted-foreground">
          {user.role === "PROJECT_MANAGER"
            ? "Yalnızca atandığınız projelere gider girebilirsiniz."
            : "Gider/borç kaydı oluşturun."}
        </p>
      </div>
      <div className="rounded-2xl border border-border bg-card p-6 shadow-soft">
        <ExpenseForm
          projects={projects.map((p) => ({ id: p.id, name: p.name }))}
          suppliers={suppliers.map((s) => ({ id: s.id, name: s.name }))}
          categories={categories.map((c) => ({ id: c.id, name: c.name }))}
          requireProject={user.role === "PROJECT_MANAGER"}
        />
      </div>
    </div>
  );
}
