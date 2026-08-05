"use client";

import { useActionState } from "react";
import { ArrowRight, Loader2 } from "lucide-react";
import { acceptInvitationAction } from "@/app/actions/auth";
import { initialActionState } from "@/lib/action-state";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import { FormAlert } from "@/components/auth/field-error";

export function AcceptInvitationForm({ token }: { token: string }) {
  const [state, formAction, pending] = useActionState(acceptInvitationAction, initialActionState);

  return (
    <form action={formAction} className="space-y-4">
      <input type="hidden" name="token" value={token} />
      <FormAlert error={state?.error} />
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="firstName">Ad</Label>
          <Input id="firstName" name="firstName" autoComplete="given-name" required />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="lastName">Soyad</Label>
          <Input id="lastName" name="lastName" autoComplete="family-name" required />
        </div>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="password">Parola</Label>
        <Input id="password" name="password" type="password" autoComplete="new-password" required />
        <p className="text-xs text-muted-foreground">En az 8 karakter, en az bir harf ve bir rakam içermelidir.</p>
      </div>
      <Button type="submit" disabled={pending} className="w-full gap-2">
        {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
        Daveti kabul et ve katıl
        {!pending && <ArrowRight className="h-4 w-4" />}
      </Button>
    </form>
  );
}
