import { requireRole } from "@/lib/auth/guard";
import { IntegrationConnectionForm } from "@/components/app/integration-connection-form";

export default async function NewIntegrationConnectionPage() {
  await requireRole(["OWNER", "ADMIN"]);

  return (
    <div className="mx-auto max-w-2xl animate-fade-in space-y-6">
      <div>
        <h1 className="font-display text-2xl font-bold tracking-tight">Yeni entegrasyon bağlantısı</h1>
        <p className="mt-0.5 text-sm text-muted-foreground">
          Sağlayıcı bağlantı yapılandırmasını oluşturun. Kimlik bilgisini bağlantı oluşturulduktan sonra ayrıca
          ekleyebilirsiniz.
        </p>
      </div>
      <div className="rounded-2xl border border-border bg-card p-6 shadow-soft">
        <IntegrationConnectionForm />
      </div>
    </div>
  );
}
