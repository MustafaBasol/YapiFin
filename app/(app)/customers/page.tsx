import Link from "next/link";
import { Plus } from "lucide-react";
import { requireUser } from "@/lib/auth/guard";
import { listCustomersForUser } from "@/server/services/customer-service";
import { canManageCustomers } from "@/lib/permissions";
import { CustomersTable } from "@/components/app/customers-table";

export default async function CustomersPage() {
  const user = await requireUser();
  const customers = await listCustomersForUser(user);

  const rows = customers.map((c) => ({
    id: c.id,
    type: c.type,
    name: c.name,
    contactName: c.contactName,
    phone: c.phone,
    city: c.city,
    isActive: c.isActive,
    projectCount: c._count.projects,
  }));

  return (
    <div className="mx-auto max-w-[1500px] animate-fade-in space-y-6">
      <div className="flex flex-wrap items-center gap-3">
        <div>
          <h1 className="font-display text-2xl font-bold tracking-tight">Müşteriler</h1>
          <p className="mt-0.5 text-sm text-muted-foreground">Tüm müşteriler ve ilişkili projeleri.</p>
        </div>
        {canManageCustomers(user.role) && (
          <Link
            href="/customers/new"
            className="ml-auto inline-flex h-9 items-center gap-1.5 rounded-lg bg-primary px-3.5 text-[13px] font-semibold text-primary-foreground shadow-sm transition-opacity hover:opacity-90"
          >
            <Plus className="h-4 w-4" />
            Yeni müşteri
          </Link>
        )}
      </div>

      <CustomersTable customers={rows} />
    </div>
  );
}
