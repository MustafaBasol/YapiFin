import { notFound } from "next/navigation";
import { requireRole } from "@/lib/auth/guard";
import { getTransactionForUser } from "@/server/services/transaction-service";
import { listProjectsForUser } from "@/server/services/project-service";
import { listSuppliersForUser } from "@/server/services/supplier-service";
import { listCategoriesForTransactionForm } from "@/server/services/category-service";
import { ServiceError } from "@/server/services/errors";
import { ExpenseForm } from "@/components/app/expense-form";

export default async function EditExpensePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await requireRole(["OWNER", "ADMIN", "FINANCE"]);

  let record;
  try {
    record = await getTransactionForUser(user, id, "EXPENSE");
  } catch (err) {
    if (err instanceof ServiceError && err.code === "NOT_FOUND") notFound();
    throw err;
  }

  const [projects, suppliers, categories] = await Promise.all([
    listProjectsForUser(user),
    listSuppliersForUser(user),
    listCategoriesForTransactionForm(user, "EXPENSE"),
  ]);

  return (
    <div className="mx-auto max-w-3xl animate-fade-in space-y-6">
      <div>
        <h1 className="font-display text-2xl font-bold tracking-tight">Gideri düzenle</h1>
        <p className="mt-0.5 text-sm text-muted-foreground">{record.description}</p>
      </div>
      <div className="rounded-2xl border border-border bg-card p-6 shadow-soft">
        <ExpenseForm
          expense={{
            id: record.id,
            projectId: record.projectId ?? "",
            supplierId: record.supplierId ?? "",
            categoryId: record.categoryId,
            documentNumber: record.documentNumber ?? "",
            description: record.description,
            issueDate: record.issueDate.toISOString().slice(0, 10),
            dueDate: record.dueDate ? record.dueDate.toISOString().slice(0, 10) : "",
            subtotal: Number(record.subtotal),
            taxRate: Number(record.taxRate),
          }}
          projects={projects.map((p) => ({ id: p.id, name: p.name }))}
          suppliers={suppliers.map((s) => ({ id: s.id, name: s.name }))}
          categories={categories.map((c) => ({ id: c.id, name: c.name }))}
          requireProject={false}
        />
      </div>
    </div>
  );
}
