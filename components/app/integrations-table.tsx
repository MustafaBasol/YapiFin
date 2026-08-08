import Link from "next/link";
import { Plug } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  INTEGRATION_TYPE_META,
  INTEGRATION_PROVIDER_META,
  INTEGRATION_ENVIRONMENT_META,
  INTEGRATION_STATUS_META,
} from "@/components/app/integration-meta";

interface Row {
  id: string;
  integrationType: string;
  provider: string;
  environment: string;
  displayName: string;
  status: string;
  credentialConfigured: boolean;
}

export function IntegrationsTable({ connections }: { connections: Row[] }) {
  if (connections.length === 0) {
    return (
      <div className="grid place-items-center rounded-2xl border border-dashed border-border bg-card py-16 text-center">
        <Plug className="h-8 w-8 text-muted-foreground/50" />
        <p className="mt-3 text-sm text-muted-foreground">Henüz entegrasyon bağlantısı eklenmemiş.</p>
      </div>
    );
  }

  return (
    <div className="overflow-hidden rounded-2xl border border-border bg-card shadow-soft">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border text-left">
              <th className="label-mono py-2.5 pl-4 font-medium text-muted-foreground">Bağlantı</th>
              <th className="label-mono py-2.5 font-medium text-muted-foreground">Tür</th>
              <th className="label-mono py-2.5 font-medium text-muted-foreground">Sağlayıcı</th>
              <th className="label-mono py-2.5 font-medium text-muted-foreground">Ortam</th>
              <th className="label-mono py-2.5 font-medium text-muted-foreground">Kimlik bilgisi</th>
              <th className="label-mono py-2.5 pr-4 font-medium text-muted-foreground">Durum</th>
            </tr>
          </thead>
          <tbody>
            {connections.map((c) => {
              const status = INTEGRATION_STATUS_META[c.status] ?? {
                label: c.status,
                tone: "bg-muted text-muted-foreground",
              };
              return (
                <tr key={c.id} className="border-b border-border/60 transition-colors last:border-0 hover:bg-muted/50">
                  <td className="py-3 pl-4">
                    <Link href={`/settings/integrations/${c.id}`} className="font-semibold leading-tight hover:underline">
                      {c.displayName}
                    </Link>
                  </td>
                  <td className="py-3 pr-4 text-[13px] text-muted-foreground">
                    {INTEGRATION_TYPE_META[c.integrationType]?.label ?? c.integrationType}
                  </td>
                  <td className="py-3 pr-4 text-[13px] text-muted-foreground">
                    {INTEGRATION_PROVIDER_META[c.provider]?.label ?? c.provider}
                  </td>
                  <td className="py-3 pr-4 text-[13px] text-muted-foreground">
                    {INTEGRATION_ENVIRONMENT_META[c.environment]?.label ?? c.environment}
                  </td>
                  <td className="py-3 pr-4">
                    <span
                      className={cn(
                        "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold",
                        c.credentialConfigured ? "bg-success/12 text-success" : "bg-muted text-muted-foreground",
                      )}
                    >
                      {c.credentialConfigured ? "Tanımlı" : "Tanımlı değil"}
                    </span>
                  </td>
                  <td className="py-3 pr-4">
                    <span className={cn("inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold", status.tone)}>
                      {status.label}
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
