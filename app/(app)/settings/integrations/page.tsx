import Link from "next/link";
import { Plus } from "lucide-react";
import { requireRole } from "@/lib/auth/guard";
import { listConnectionsForOrg } from "@/server/services/integrations/integration-service";
import { IntegrationsTable } from "@/components/app/integrations-table";

export default async function IntegrationsPage() {
  const user = await requireRole(["OWNER", "ADMIN"]);
  const connections = await listConnectionsForOrg(user);

  const rows = connections.map((c) => ({
    id: c.id,
    integrationType: c.integrationType,
    provider: c.provider,
    environment: c.environment,
    displayName: c.displayName,
    status: c.status,
    credentialConfigured: c.credentialConfigured,
  }));

  return (
    <div className="mx-auto max-w-[1500px] animate-fade-in space-y-6">
      <div className="flex flex-wrap items-center gap-3">
        <div>
          <h1 className="font-display text-2xl font-bold tracking-tight">Entegrasyonlar</h1>
          <p className="mt-0.5 text-sm text-muted-foreground">
            E-belge ve muhasebe sağlayıcı bağlantı yapılandırması. Bu aşamada gerçek bir sağlayıcı çağrısı yapılmaz —
            yalnızca bağlantı ve kimlik bilgisi altyapısı hazırlanır.
          </p>
        </div>
        <Link
          href="/settings/integrations/new"
          className="ml-auto inline-flex h-9 items-center gap-1.5 rounded-lg bg-primary px-3.5 text-[13px] font-semibold text-primary-foreground shadow-sm transition-opacity hover:opacity-90"
        >
          <Plus className="h-4 w-4" />
          Yeni bağlantı
        </Link>
      </div>

      <IntegrationsTable connections={rows} />
    </div>
  );
}
