"use client";

import { useRouter, useSearchParams, usePathname } from "next/navigation";

export function BudgetFilterBar({
  projects,
  categories,
  selectedProjectId,
  selectedCategoryId,
}: {
  projects: { id: string; name: string }[];
  categories: { id: string; name: string }[];
  selectedProjectId: string | null;
  selectedCategoryId: string | null;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  function updateParam(key: string, value: string) {
    const params = new URLSearchParams(searchParams.toString());
    if (value) params.set(key, value);
    else params.delete(key);
    router.push(`${pathname}?${params.toString()}`);
  }

  return (
    <div className="flex flex-wrap items-center gap-2.5">
      {projects.length > 0 && (
        <select
          value={selectedProjectId ?? ""}
          onChange={(e) => updateParam("projectId", e.target.value)}
          className="h-9 rounded-lg border border-border bg-card px-2.5 text-[13px] text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <option value="">Tüm projeler</option>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      )}

      {categories.length > 0 && (
        <select
          value={selectedCategoryId ?? ""}
          onChange={(e) => updateParam("categoryId", e.target.value)}
          className="h-9 rounded-lg border border-border bg-card px-2.5 text-[13px] text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <option value="">En çok harcanan ilk 5 kategori (aylık trend)</option>
          {categories.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      )}
    </div>
  );
}
