"use client";

import { useActionState } from "react";
import Link from "next/link";
import { ArrowRight, Loader2 } from "lucide-react";
import { forgotPasswordAction } from "@/app/actions/auth";
import { initialActionState } from "@/lib/action-state";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import { FormAlert } from "@/components/auth/field-error";

export function ForgotPasswordForm() {
  const [state, formAction, pending] = useActionState(forgotPasswordAction, initialActionState);

  return (
    <div className="space-y-5">
      <p className="text-sm text-muted-foreground">
        E-posta adresinizi girin; kayıtlıysa parola sıfırlama bağlantısı gönderilecektir.
      </p>
      <form action={formAction} className="space-y-4">
        <FormAlert error={state?.error} success={state?.success} />
        <div className="space-y-1.5">
          <Label htmlFor="email">E-posta</Label>
          <Input id="email" name="email" type="email" autoComplete="email" required />
        </div>
        <Button type="submit" disabled={pending} className="w-full gap-2">
          {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
          Sıfırlama bağlantısı gönder
          {!pending && <ArrowRight className="h-4 w-4" />}
        </Button>
      </form>

      <p className="text-center text-sm text-muted-foreground">
        <Link href="/login" className="font-medium text-primary hover:underline underline-offset-4">
          Girişe dön
        </Link>
      </p>
    </div>
  );
}
