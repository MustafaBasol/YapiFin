import { requireRole } from "@/lib/auth/guard";
import { SupplierForm } from "@/components/app/supplier-form";

export default async function NewSupplierPage() {
  await requireRole(["OWNER", "ADMIN"]);

  return (
    <div className="mx-auto max-w-3xl animate-fade-in space-y-6">
      <div>
        <h1 className="font-display text-2xl font-bold tracking-tight">Yeni tedarikçi</h1>
        <p className="mt-0.5 text-sm text-muted-foreground">Tedarikçi/taşeron bilgilerini girin.</p>
      </div>
      <div className="rounded-2xl border border-border bg-card p-6 shadow-soft">
        <SupplierForm />
      </div>
    </div>
  );
}
