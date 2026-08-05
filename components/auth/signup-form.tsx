"use client";

import { useActionState } from "react";
import Link from "next/link";
import { ArrowRight, Loader2 } from "lucide-react";
import { registerOwnerAction } from "@/app/actions/auth";
import { initialActionState } from "@/lib/action-state";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import { FormAlert } from "@/components/auth/field-error";

export function SignupForm() {
  const [state, formAction, pending] = useActionState(registerOwnerAction, initialActionState);

  return (
    <div className="space-y-5">
      <form action={formAction} className="space-y-4">
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

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="email">E-posta</Label>
            <Input id="email" name="email" type="email" autoComplete="email" required />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="phone">Telefon</Label>
            <Input id="phone" name="phone" type="tel" autoComplete="tel" />
          </div>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="password">Parola</Label>
          <Input id="password" name="password" type="password" autoComplete="new-password" required />
          <p className="text-xs text-muted-foreground">En az 8 karakter, en az bir harf ve bir rakam içermelidir.</p>
        </div>

        <div className="h-px bg-border" />

        <div className="space-y-1.5">
          <Label htmlFor="organizationName">Firma ticari adı</Label>
          <Input id="organizationName" name="organizationName" required />
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="city">İl</Label>
            <Input id="city" name="city" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="district">İlçe</Label>
            <Input id="district" name="district" />
          </div>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="taxOffice">Vergi dairesi</Label>
            <Input id="taxOffice" name="taxOffice" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="taxNumber">Vergi numarası</Label>
            <Input id="taxNumber" name="taxNumber" />
          </div>
        </div>

        <Button type="submit" disabled={pending} className="w-full gap-2">
          {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
          Firma kaydı oluştur
          {!pending && <ArrowRight className="h-4 w-4" />}
        </Button>
      </form>

      <p className="text-center text-sm text-muted-foreground">
        Zaten hesabın var mı?{" "}
        <Link href="/login" className="font-medium text-primary hover:underline underline-offset-4">
          Giriş yap
        </Link>
      </p>
    </div>
  );
}
