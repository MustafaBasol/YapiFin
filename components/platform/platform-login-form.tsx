"use client";

import { useActionState } from "react";
import { Loader2, ShieldCheck } from "lucide-react";
import { platformLoginAction } from "@/app/actions/platform-auth";
import { initialActionState } from "@/lib/action-state";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import { FormAlert } from "@/components/auth/field-error";

/**
 * YF-818 — Kiracı (tenant) giriş formundan (`components/auth/login-form.tsx`)
 * KASITLI OLARAK görsel olarak FARKLI: "Firma kaydı oluştur" bağlantısı yok,
 * parola sıfırlama akışı yok (platform-admin hesapları operasyonel olarak
 * elle oluşturulur), koyu petrol kart + yetki rozetiyle bariz biçimde ayrı
 * bir yüzey olduğu vurgulanır.
 */
export function PlatformLoginForm() {
  const [state, formAction, pending] = useActionState(platformLoginAction, initialActionState);

  return (
    <form action={formAction} className="space-y-4">
      <FormAlert error={state?.error} />
      <div className="space-y-1.5">
        <Label htmlFor="email">E-posta</Label>
        <Input id="email" name="email" type="email" autoComplete="email" required />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="password">Parola</Label>
        <Input id="password" name="password" type="password" autoComplete="current-password" required />
      </div>
      <Button type="submit" disabled={pending} className="w-full gap-2">
        {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldCheck className="h-4 w-4" />}
        Panele giriş yap
      </Button>
    </form>
  );
}
