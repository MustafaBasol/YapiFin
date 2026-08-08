"use client";

import { useActionState } from "react";
import { ArrowRight, Loader2 } from "lucide-react";
import { createIntegrationConnectionAction } from "@/app/actions/integrations";
import { initialActionState } from "@/lib/action-state";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import { FormAlert } from "@/components/auth/field-error";
import {
  INTEGRATION_TYPE_META,
  INTEGRATION_TYPE_OPTIONS,
  INTEGRATION_PROVIDER_META,
  INTEGRATION_PROVIDER_OPTIONS,
  INTEGRATION_ENVIRONMENT_META,
  INTEGRATION_ENVIRONMENT_OPTIONS,
} from "@/components/app/integration-meta";

const selectClassName =
  "flex h-10 w-full rounded-lg border border-input bg-card px-3 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

export function IntegrationConnectionForm() {
  const [state, formAction, pending] = useActionState(createIntegrationConnectionAction, initialActionState);

  return (
    <form action={formAction} className="space-y-4">
      <FormAlert error={state?.error} />

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="integrationType">Entegrasyon türü</Label>
          <select id="integrationType" name="integrationType" defaultValue="E_INVOICE" className={selectClassName}>
            {INTEGRATION_TYPE_OPTIONS.map((t) => (
              <option key={t} value={t}>
                {INTEGRATION_TYPE_META[t].label}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="provider">Sağlayıcı</Label>
          <select id="provider" name="provider" defaultValue="GENERIC" className={selectClassName}>
            {INTEGRATION_PROVIDER_OPTIONS.map((p) => (
              <option key={p} value={p}>
                {INTEGRATION_PROVIDER_META[p].label}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="environment">Ortam</Label>
          <select id="environment" name="environment" defaultValue="SANDBOX" className={selectClassName}>
            {INTEGRATION_ENVIRONMENT_OPTIONS.map((e) => (
              <option key={e} value={e}>
                {INTEGRATION_ENVIRONMENT_META[e].label}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="displayName">Görünen ad</Label>
          <Input id="displayName" name="displayName" placeholder="örn. Nilvera – Test" required />
        </div>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="externalTenantId">Harici hesap/kiracı kimliği (opsiyonel)</Label>
        <Input id="externalTenantId" name="externalTenantId" placeholder="opsiyonel" />
      </div>

      <p className="rounded-lg bg-muted px-3 py-2 text-xs text-muted-foreground">
        Bağlantı oluşturulduğunda devre dışı (INACTIVE) olarak başlar; kimlik bilgisini tanımladıktan sonra ayrıca
        etkinleştirmeniz gerekir. Bu aşamada sağlayıcıya gerçek bir bağlantı kurulmaz.
      </p>

      <Button type="submit" disabled={pending} className="gap-2">
        {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
        Bağlantıyı oluştur
        {!pending && <ArrowRight className="h-4 w-4" />}
      </Button>
    </form>
  );
}
