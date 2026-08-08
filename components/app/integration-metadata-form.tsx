"use client";

import { useActionState } from "react";
import { Loader2 } from "lucide-react";
import { updateIntegrationConnectionAction } from "@/app/actions/integrations";
import { initialActionState } from "@/lib/action-state";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import { FormAlert } from "@/components/auth/field-error";

export function IntegrationMetadataForm({
  connectionId,
  displayName,
  externalTenantId,
}: {
  connectionId: string;
  displayName: string;
  externalTenantId: string;
}) {
  const [state, formAction, pending] = useActionState(updateIntegrationConnectionAction, initialActionState);

  return (
    <form action={formAction} className="space-y-4">
      <input type="hidden" name="id" value={connectionId} />
      <FormAlert error={state?.error} success={state?.success} />

      <div className="space-y-1.5">
        <Label htmlFor="displayName">Görünen ad</Label>
        <Input id="displayName" name="displayName" defaultValue={displayName} required />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="externalTenantId">Harici hesap/kiracı kimliği (opsiyonel)</Label>
        <Input id="externalTenantId" name="externalTenantId" defaultValue={externalTenantId} placeholder="opsiyonel" />
      </div>

      <Button type="submit" disabled={pending} variant="outline" size="sm" className="gap-2">
        {pending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
        Değişiklikleri kaydet
      </Button>
    </form>
  );
}
