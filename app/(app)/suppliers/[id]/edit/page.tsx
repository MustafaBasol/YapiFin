import { notFound } from "next/navigation";
import { requireRole } from "@/lib/auth/guard";
import { getSupplierForUser } from "@/server/services/supplier-service";
import { ServiceError } from "@/server/services/errors";
import { SupplierForm } from "@/components/app/supplier-form";

export default async function EditSupplierPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const user = await requireRole(["OWNER", "ADMIN"]);

  let supplier;
  try {
    supplier = await getSupplierForUser(user, id);
  } catch (err) {
    if (err instanceof ServiceError && err.code === "NOT_FOUND") notFound();
    throw err;
  }

  return (
    <div className="mx-auto max-w-3xl animate-fade-in space-y-6">
      <div>
        <h1 className="font-display text-2xl font-bold tracking-tight">Tedarikçiyi düzenle</h1>
        <p className="mt-0.5 text-sm text-muted-foreground">{supplier.name}</p>
      </div>
      <div className="rounded-2xl border border-border bg-card p-6 shadow-soft">
        <SupplierForm
          supplier={{
            id: supplier.id,
            type: supplier.type,
            name: supplier.name,
            identityOrTaxNumber: supplier.identityOrTaxNumber ?? "",
            taxOffice: supplier.taxOffice ?? "",
            contactName: supplier.contactName ?? "",
            phone: supplier.phone ?? "",
            email: supplier.email ?? "",
            city: supplier.city ?? "",
            district: supplier.district ?? "",
            address: supplier.address ?? "",
          }}
        />
      </div>
    </div>
  );
}
