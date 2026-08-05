import Link from "next/link";
import { Plus } from "lucide-react";
import { requireRole } from "@/lib/auth/guard";
import { listSuppliersForUser } from "@/server/services/supplier-service";
import { canManageSuppliers } from "@/lib/permissions";
import { SuppliersTable } from "@/components/app/suppliers-table";

export default async function SuppliersPage() {
  const user = await requireRole(["OWNER", "ADMIN", "FINANCE"]);
  const suppliers = await listSuppliersForUser(user);

  const rows = suppliers.map((s) => ({
    id: s.id,
    type: s.type,
    name: s.name,
    contactName: s.contactName,
    phone: s.phone,
    city: s.city,
    isActive: s.isActive,
  }));

  return (
    <div className="mx-auto max-w-[1500px] animate-fade-in space-y-6">
      <div className="flex flex-wrap items-center gap-3">
        <div>
          <h1 className="font-display text-2xl font-bold tracking-tight">Tedarikçiler / Taşeronlar</h1>
          <p className="mt-0.5 text-sm text-muted-foreground">Tüm tedarikçi ve taşeron kayıtları.</p>
        </div>
        {canManageSuppliers(user.role) && (
          <Link
            href="/suppliers/new"
            className="ml-auto inline-flex h-9 items-center gap-1.5 rounded-lg bg-primary px-3.5 text-[13px] font-semibold text-primary-foreground shadow-sm transition-opacity hover:opacity-90"
          >
            <Plus className="h-4 w-4" />
            Yeni tedarikçi
          </Link>
        )}
      </div>

      <SuppliersTable suppliers={rows} />
    </div>
  );
}
