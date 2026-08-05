import Link from "next/link";
import { notFound } from "next/navigation";
import { Pencil } from "lucide-react";
import { requireRole } from "@/lib/auth/guard";
import { getSupplierForUser } from "@/server/services/supplier-service";
import { ServiceError } from "@/server/services/errors";
import { canManageSuppliers } from "@/lib/permissions";
import { SUPPLIER_TYPE_META } from "@/components/app/supplier-type";
import { SupplierArchiveForm } from "@/components/app/supplier-archive-form";
import { cn } from "@/lib/utils";

export default async function SupplierDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const user = await requireRole(["OWNER", "ADMIN", "FINANCE"]);

  let supplier;
  try {
    supplier = await getSupplierForUser(user, id);
  } catch (err) {
    if (err instanceof ServiceError && err.code === "NOT_FOUND") notFound();
    throw err;
  }

  const type = SUPPLIER_TYPE_META[supplier.type] ?? { label: supplier.type, tone: "bg-muted text-muted-foreground" };
  const canManage = canManageSuppliers(user.role);

  return (
    <div className="mx-auto max-w-3xl animate-fade-in space-y-6">
      <div className="flex flex-wrap items-start gap-3">
        <div>
          <h1 className="font-display text-2xl font-bold tracking-tight">{supplier.name}</h1>
          <div className="mt-1 flex items-center gap-2">
            <span className={cn("inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[12px] font-semibold", type.tone)}>
              {type.label}
            </span>
            <span
              className={cn(
                "inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[12px] font-semibold",
                supplier.isActive ? "bg-success/12 text-success" : "bg-destructive/10 text-destructive",
              )}
            >
              {supplier.isActive ? "Aktif" : "Arşivlendi"}
            </span>
          </div>
        </div>
        {canManage && (
          <Link
            href={`/suppliers/${supplier.id}/edit`}
            className="ml-auto inline-flex h-9 items-center gap-1.5 rounded-lg border border-border bg-card px-3.5 text-[13px] font-semibold text-foreground shadow-sm transition-colors hover:bg-muted"
          >
            <Pencil className="h-3.5 w-3.5" />
            Düzenle
          </Link>
        )}
      </div>

      <div className="rounded-2xl border border-border bg-card p-5 shadow-soft">
        <h2 className="font-display text-[15px] font-semibold tracking-tight">Genel bakış</h2>
        <dl className="mt-4 grid grid-cols-2 gap-4 text-sm">
          <Field label="TCKN / VKN" value={supplier.identityOrTaxNumber ?? "—"} />
          <Field label="Vergi dairesi" value={supplier.taxOffice ?? "—"} />
          <Field label="İlgili kişi" value={supplier.contactName ?? "—"} />
          <Field label="Telefon" value={supplier.phone ?? "—"} />
          <Field label="E-posta" value={supplier.email ?? "—"} />
          <Field label="Konum" value={[supplier.city, supplier.district].filter(Boolean).join(" / ") || "—"} />
        </dl>
        {supplier.address && <p className="mt-4 text-sm text-muted-foreground">{supplier.address}</p>}
      </div>

      <div className="rounded-2xl border border-dashed border-border bg-card p-5">
        <h2 className="font-display text-[15px] font-semibold tracking-tight">Proje ve borç özeti</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          İlişkili projeler, toplam borç ve ödeme özeti; gider ve ödeme modülleri eklendiğinde burada görünecektir.
        </p>
      </div>

      {canManage && (
        <div className="rounded-2xl border border-border bg-card p-5 shadow-soft">
          <h2 className="font-display text-[15px] font-semibold tracking-tight">Kayıt durumu</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            {supplier.isActive
              ? "Bu tedarikçi arşivlenirse yeni giderlerde seçilemez."
              : "Bu tedarikçi arşivde; yeniden etkinleştirebilirsiniz."}
          </p>
          <div className="mt-3">
            <SupplierArchiveForm supplierId={supplier.id} isActive={supplier.isActive} />
          </div>
        </div>
      )}
    </div>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-[11px] text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 font-medium">{value}</dd>
    </div>
  );
}
