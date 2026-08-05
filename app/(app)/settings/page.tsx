import { requireRole } from "@/lib/auth/guard";
import { db } from "@/lib/db";
import { OrganizationSettingsForm } from "@/components/app/organization-settings-form";

export default async function SettingsPage() {
  const actor = await requireRole(["OWNER", "ADMIN"]);
  const organization = await db.organization.findUniqueOrThrow({ where: { id: actor.organizationId } });

  return (
    <div className="mx-auto max-w-2xl animate-fade-in space-y-6">
      <div>
        <h1 className="font-display text-2xl font-bold tracking-tight">Ayarlar</h1>
        <p className="mt-0.5 text-sm text-muted-foreground">Firma bilgilerini görüntüleyin ve güncelleyin.</p>
      </div>

      <div className="rounded-2xl border border-border bg-card p-6 shadow-soft">
        <OrganizationSettingsForm
          readOnly={actor.role !== "OWNER"}
          organization={{
            tradeName: organization.tradeName ?? organization.name,
            taxOffice: organization.taxOffice ?? "",
            taxNumber: organization.taxNumber ?? "",
            phone: organization.phone ?? "",
            email: organization.email ?? "",
            city: organization.city ?? "",
            district: organization.district ?? "",
            address: organization.address ?? "",
          }}
        />
      </div>
    </div>
  );
}
