import { requireRole } from "@/lib/auth/guard";
import { listCategoriesForUser } from "@/server/services/category-service";
import { canManageCategories } from "@/lib/permissions";
import { CategorySection } from "@/components/app/category-section";

export default async function CategoriesPage() {
  const user = await requireRole(["OWNER", "ADMIN", "FINANCE"]);
  const categories = await listCategoriesForUser(user);
  const canManage = canManageCategories(user.role);

  const rows = categories.map((c) => ({
    id: c.id,
    type: c.type,
    name: c.name,
    parentId: c.parentId,
    isSystem: c.isSystem,
    isActive: c.isActive,
    usageCount: c._count.transactions + c._count.budgetItems,
  }));

  return (
    <div className="mx-auto max-w-4xl animate-fade-in space-y-6">
      <div>
        <h1 className="font-display text-2xl font-bold tracking-tight">Kategoriler</h1>
        <p className="mt-0.5 text-sm text-muted-foreground">
          Gelir ve gider kategorilerini yönetin. Varsayılan kategoriler değiştirilemez veya pasifleştirilemez.
        </p>
      </div>

      <CategorySection type="INCOME" categories={rows.filter((c) => c.type === "INCOME")} canManage={canManage} />
      <CategorySection type="EXPENSE" categories={rows.filter((c) => c.type === "EXPENSE")} canManage={canManage} />
    </div>
  );
}
