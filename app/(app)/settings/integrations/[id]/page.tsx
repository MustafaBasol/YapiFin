import { notFound } from "next/navigation";
import { requireRole } from "@/lib/auth/guard";
import { getConnectionForUser } from "@/server/services/integrations/integration-service";
import { ServiceError } from "@/server/services/errors";
import { cn } from "@/lib/utils";
import {
  INTEGRATION_TYPE_META,
  INTEGRATION_PROVIDER_META,
  INTEGRATION_ENVIRONMENT_META,
  INTEGRATION_STATUS_META,
} from "@/components/app/integration-meta";
import { IntegrationMetadataForm } from "@/components/app/integration-metadata-form";
import { IntegrationCredentialForm } from "@/components/app/integration-credential-form";
import { IntegrationStatusForm } from "@/components/app/integration-status-form";
import { IntegrationDeleteForm } from "@/components/app/integration-delete-form";
import { NilveraLookupPanel } from "@/components/app/nilvera-lookup-panel";
import { Badge } from "@/components/ui/badge";

export default async function IntegrationConnectionDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const user = await requireRole(["OWNER", "ADMIN"]);

  let connection;
  try {
    connection = await getConnectionForUser(user, id);
  } catch (err) {
    if (err instanceof ServiceError && err.code === "NOT_FOUND") notFound();
    throw err;
  }

  const status = INTEGRATION_STATUS_META[connection.status] ?? {
    label: connection.status,
    tone: "bg-muted text-muted-foreground",
  };

  return (
    <div className="mx-auto max-w-3xl animate-fade-in space-y-6">
      <div>
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="font-display text-2xl font-bold tracking-tight">{connection.displayName}</h1>
          <span className={cn("inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[12px] font-semibold", status.tone)}>
            {status.label}
          </span>
        </div>
        <p className="mt-0.5 text-sm text-muted-foreground">
          {INTEGRATION_TYPE_META[connection.integrationType]?.label ?? connection.integrationType} ·{" "}
          {INTEGRATION_PROVIDER_META[connection.provider]?.label ?? connection.provider} ·{" "}
          {INTEGRATION_ENVIRONMENT_META[connection.environment]?.label ?? connection.environment}
        </p>
      </div>

      <div className="rounded-2xl border border-border bg-card p-5 shadow-soft">
        <h2 className="font-display text-[15px] font-semibold tracking-tight">Bağlantı bilgileri</h2>
        <div className="mt-4">
          <IntegrationMetadataForm
            connectionId={connection.id}
            displayName={connection.displayName}
            externalTenantId={connection.externalTenantId ?? ""}
          />
        </div>
      </div>

      <div className="rounded-2xl border border-border bg-card p-5 shadow-soft">
        <h2 className="font-display text-[15px] font-semibold tracking-tight">Kimlik bilgisi</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {connection.credentialConfigured
            ? `Tanımlı — son güncelleme ${connection.credentialUpdatedAt?.toLocaleDateString("tr-TR") ?? "—"}.`
            : "Bu bağlantı için henüz kimlik bilgisi tanımlanmadı."}
        </p>
        <div className="mt-3">
          <IntegrationCredentialForm connectionId={connection.id} configured={connection.credentialConfigured} />
        </div>
      </div>

      {connection.provider === "NILVERA" && connection.environment === "SANDBOX" && (
        <div className="rounded-2xl border border-border bg-card p-5 shadow-soft">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="font-display text-[15px] font-semibold tracking-tight">Nilvera sorgulama</h2>
            <Badge tone="info">Sandbox / Salt okunur</Badge>
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            Bu bölüm yalnızca Nilvera SANDBOX ortamı için mükellef ve e-belge durumu sorgulaması sağlar; e-belge
            gönderimi, iptali veya üretim ortamı bu fazda desteklenmez.
          </p>
          <div className="mt-4">
            <NilveraLookupPanel connectionId={connection.id} credentialConfigured={connection.credentialConfigured} />
          </div>
        </div>
      )}

      <div className="rounded-2xl border border-border bg-card p-5 shadow-soft">
        <h2 className="font-display text-[15px] font-semibold tracking-tight">Durum</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {connection.status === "ACTIVE"
            ? "Bu bağlantı etkin. Devre dışı bırakıldığında bu organizasyon için opt-in özellik kapanır."
            : "Bu bağlantı devre dışı. Bu fazda etkinleştirme, herhangi bir sağlayıcıya gerçek bir çağrı yapmaz."}
        </p>
        <div className="mt-3">
          <IntegrationStatusForm connectionId={connection.id} isActive={connection.status === "ACTIVE"} />
        </div>
      </div>

      <div className="rounded-2xl border border-dashed border-border bg-card p-5">
        <h2 className="font-display text-[15px] font-semibold tracking-tight">Bağlantıyı sil</h2>
        <div className="mt-3">
          <IntegrationDeleteForm connectionId={connection.id} />
        </div>
      </div>
    </div>
  );
}
