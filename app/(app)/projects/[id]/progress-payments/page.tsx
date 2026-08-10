import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { requireUser } from "@/lib/auth/guard";
import { listProgressPaymentsForProject } from "@/server/services/progress-payment-service";
import { listCategoriesForTransactionForm } from "@/server/services/category-service";
import { ServiceError } from "@/server/services/errors";
import { ProgressPaymentList } from "@/components/app/progress-payment-list";
import { ProgressPaymentCreateForm } from "@/components/app/progress-payment-create-form";

export default async function ProjectProgressPaymentsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await requireUser();

  let listing;
  try {
    listing = await listProgressPaymentsForProject(user, id);
  } catch (err) {
    if (err instanceof ServiceError && err.code === "NOT_FOUND") notFound();
    throw err;
  }

  const activeCategoryOptions = listing.canManage
    ? (await listCategoriesForTransactionForm(user, "INCOME")).map((c) => ({ id: c.id, name: c.name }))
    : [];

  return (
    <div className="mx-auto max-w-[1200px] animate-fade-in space-y-6">
      <div>
        <Link
          href={`/projects/${listing.project.id}`}
          className="inline-flex items-center gap-1.5 text-[12.5px] font-medium text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          Projeye dön
        </Link>
        <div className="mt-2 flex flex-wrap items-baseline gap-2">
          <h1 className="font-display text-2xl font-bold tracking-tight">{listing.project.name}</h1>
          <span className="text-sm text-muted-foreground">({listing.project.code})</span>
        </div>
        <p className="mt-0.5 text-sm text-muted-foreground">Hakedişler</p>
      </div>

      <div className="overflow-hidden rounded-2xl border border-border bg-card shadow-soft">
        <div className="border-b border-border p-4">
          <h2 className="font-display text-[15px] font-semibold tracking-tight">Hakediş Listesi</h2>
          {!listing.canManage && (
            <p className="mt-1 text-[12px] text-muted-foreground">
              Yalnızca atandığınız projenin hakedişlerini görüntüleyebilirsiniz; ekleme/onay yetkiniz yok.
            </p>
          )}
        </div>

        <ProgressPaymentList projectId={listing.project.id} records={listing.records} />

        {listing.canManage && (
          <div className="p-4">
            <ProgressPaymentCreateForm projectId={listing.project.id} categoryOptions={activeCategoryOptions} />
          </div>
        )}
      </div>
    </div>
  );
}
