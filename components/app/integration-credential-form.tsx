"use client";

import { useActionState } from "react";
import { Loader2 } from "lucide-react";
import { setIntegrationCredentialAction } from "@/app/actions/integrations";
import { initialActionState } from "@/lib/action-state";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/input";
import { FormAlert } from "@/components/auth/field-error";

export function IntegrationCredentialForm({ connectionId, configured }: { connectionId: string; configured: boolean }) {
  const [state, formAction, pending] = useActionState(setIntegrationCredentialAction, initialActionState);

  return (
    <form action={formAction} className="space-y-3">
      <input type="hidden" name="connectionId" value={connectionId} />
      <FormAlert error={state?.error} success={state?.success} />
      <div className="space-y-1.5">
        <Label htmlFor="secretValue">{configured ? "Kimlik bilgisini değiştir" : "Kimlik bilgisi"}</Label>
        <textarea
          id="secretValue"
          name="secretValue"
          rows={3}
          required
          autoComplete="off"
          placeholder="API anahtarı / erişim anahtarı"
          className="flex w-full rounded-lg border border-input bg-card px-3 py-2 font-mono text-sm text-foreground placeholder:text-muted-foreground/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
        <p className="text-xs text-muted-foreground">
          Kaydedildikten sonra bu değer bir daha hiçbir yerde (ekranda, günlükte) düz metin olarak gösterilmez —
          yalnızca &ldquo;tanımlı&rdquo; durumu görüntülenir.
        </p>
      </div>
      <Button type="submit" disabled={pending} variant="outline" size="sm" className="gap-2">
        {pending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
        {configured ? "Kimlik bilgisini değiştir" : "Kimlik bilgisini kaydet"}
      </Button>
    </form>
  );
}
