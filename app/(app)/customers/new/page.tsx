import { requireRole } from "@/lib/auth/guard";
import { CustomerForm } from "@/components/app/customer-form";

export default async function NewCustomerPage() {
  await requireRole(["OWNER", "ADMIN"]);

  return (
    <div className="mx-auto max-w-3xl animate-fade-in space-y-6">
      <div>
        <h1 className="font-display text-2xl font-bold tracking-tight">Yeni müşteri</h1>
        <p className="mt-0.5 text-sm text-muted-foreground">Müşteri bilgilerini girin.</p>
      </div>
      <div className="rounded-2xl border border-border bg-card p-6 shadow-soft">
        <CustomerForm />
      </div>
    </div>
  );
}
