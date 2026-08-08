"use client";

import { useActionState } from "react";
import { deleteIntegrationConnectionAction } from "@/app/actions/integrations";
import { initialActionState } from "@/lib/action-state";
import { Button } from "@/components/ui/button";
import { FormAlert } from "@/components/auth/field-error";

export function IntegrationDeleteForm({ connectionId }: { connectionId: string }) {
  const [state, formAction, pending] = useActionState(deleteIntegrationConnectionAction, initialActionState);

  return (
    <form action={formAction} className="space-y-2">
      <input type="hidden" name="id" value={connectionId} />
      <FormAlert error={state?.error} />
      <Button type="submit" variant="outline" size="sm" disabled={pending}>
        Bağlantıyı sil
      </Button>
      <p className="text-xs text-muted-foreground">
        Yalnızca hiç kimlik bilgisi tanımlanmamış ve hiçbir olay geçmişi olmayan bağlantılar silinebilir; aksi halde
        yalnızca devre dışı bırakabilirsiniz.
      </p>
    </form>
  );
}
