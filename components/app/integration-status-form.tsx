"use client";

import { useActionState } from "react";
import { disableIntegrationConnectionAction, enableIntegrationConnectionAction } from "@/app/actions/integrations";
import { initialActionState } from "@/lib/action-state";
import { Button } from "@/components/ui/button";
import { FormAlert } from "@/components/auth/field-error";

export function IntegrationStatusForm({ connectionId, isActive }: { connectionId: string; isActive: boolean }) {
  const [state, formAction, pending] = useActionState(
    isActive ? disableIntegrationConnectionAction : enableIntegrationConnectionAction,
    initialActionState,
  );

  return (
    <form action={formAction} className="space-y-2">
      <input type="hidden" name="id" value={connectionId} />
      <FormAlert error={state?.error} success={state?.success} />
      <Button type="submit" variant={isActive ? "outline" : "primary"} size="sm" disabled={pending}>
        {isActive ? "Bağlantıyı devre dışı bırak" : "Bağlantıyı etkinleştir"}
      </Button>
    </form>
  );
}
