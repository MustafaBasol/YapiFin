import { notFound } from "next/navigation";
import { requireRole } from "@/lib/auth/guard";
import { getCustomerForUser } from "@/server/services/customer-service";
import { ServiceError } from "@/server/services/errors";
import { CustomerForm } from "@/components/app/customer-form";

export default async function EditCustomerPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const user = await requireRole(["OWNER", "ADMIN"]);

  let customer;
  try {
    customer = await getCustomerForUser(user, id);
  } catch (err) {
    if (err instanceof ServiceError && err.code === "NOT_FOUND") notFound();
    throw err;
  }

  return (
    <div className="mx-auto max-w-3xl animate-fade-in space-y-6">
      <div>
        <h1 className="font-display text-2xl font-bold tracking-tight">Müşteriyi düzenle</h1>
        <p className="mt-0.5 text-sm text-muted-foreground">{customer.name}</p>
      </div>
      <div className="rounded-2xl border border-border bg-card p-6 shadow-soft">
        <CustomerForm
          customer={{
            id: customer.id,
            type: customer.type,
            name: customer.name,
            identityOrTaxNumber: customer.identityOrTaxNumber ?? "",
            taxOffice: customer.taxOffice ?? "",
            contactName: customer.contactName ?? "",
            phone: customer.phone ?? "",
            email: customer.email ?? "",
            city: customer.city ?? "",
            district: customer.district ?? "",
            address: customer.address ?? "",
          }}
        />
      </div>
    </div>
  );
}
