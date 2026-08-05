import { CategoryRow, type CategoryRowData } from "@/components/app/category-row";
import { CategoryCreateForm } from "@/components/app/category-create-form";
import { CATEGORY_TYPE_META } from "@/components/app/category-type";
import type { TransactionType } from "@prisma/client";

interface CategoryInput {
  id: string;
  name: string;
  parentId: string | null;
  isSystem: boolean;
  isActive: boolean;
  usageCount: number;
}

function buildTreeRows(categories: CategoryInput[]): CategoryRowData[] {
  const byParent = new Map<string | null, CategoryInput[]>();
  for (const c of categories) {
    const list = byParent.get(c.parentId) ?? [];
    list.push(c);
    byParent.set(c.parentId, list);
  }

  const rows: CategoryRowData[] = [];
  function visit(parentId: string | null, depth: number) {
    const children = byParent.get(parentId) ?? [];
    for (const c of children) {
      rows.push({ id: c.id, name: c.name, isSystem: c.isSystem, isActive: c.isActive, depth, usageCount: c.usageCount });
      visit(c.id, depth + 1);
    }
  }
  visit(null, 0);
  return rows;
}

export function CategorySection({
  type,
  categories,
  canManage,
}: {
  type: TransactionType;
  categories: CategoryInput[];
  canManage: boolean;
}) {
  const meta = CATEGORY_TYPE_META[type];
  const rows = buildTreeRows(categories);
  const parentOptions = categories.filter((c) => c.parentId === null).map((c) => ({ id: c.id, name: c.name }));

  return (
    <div className="rounded-2xl border border-border bg-card p-5 shadow-soft">
      <div className="flex items-center gap-2">
        <h2 className="font-display text-[15px] font-semibold tracking-tight">{meta.label} kategorileri</h2>
      </div>

      {rows.length === 0 ? (
        <p className="mt-4 text-sm text-muted-foreground">Henüz kategori eklenmemiş.</p>
      ) : (
        <div className="mt-4 overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left">
                <th className="label-mono py-2 pl-4 font-medium text-muted-foreground">Ad</th>
                <th className="label-mono py-2 pr-4 font-medium text-muted-foreground">Kaynak</th>
                <th className="label-mono py-2 pr-4 font-medium text-muted-foreground">Kullanım</th>
                <th className="label-mono py-2 pr-4 font-medium text-muted-foreground">Durum</th>
                <th className="label-mono py-2 pr-4 text-right font-medium text-muted-foreground">İşlem</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <CategoryRow key={r.id} category={r} canManage={canManage} />
              ))}
            </tbody>
          </table>
        </div>
      )}

      {canManage && <CategoryCreateForm type={type} parentOptions={parentOptions} />}
    </div>
  );
}
