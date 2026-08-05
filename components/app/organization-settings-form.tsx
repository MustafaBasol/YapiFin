"use client";

import { useActionState } from "react";
import { updateOrganizationAction } from "@/app/actions/organization";
import { initialActionState } from "@/lib/action-state";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import { FormAlert } from "@/components/auth/field-error";

interface OrganizationFields {
  tradeName: string;
  taxOffice: string;
  taxNumber: string;
  phone: string;
  email: string;
  city: string;
  district: string;
  address: string;
}

export function OrganizationSettingsForm({
  organization,
  readOnly,
}: {
  organization: OrganizationFields;
  readOnly: boolean;
}) {
  const [state, formAction, pending] = useActionState(updateOrganizationAction, initialActionState);

  return (
    <form action={formAction} className="space-y-4">
      {readOnly && (
        <p className="rounded-lg bg-muted px-3 py-2 text-xs text-muted-foreground">
          Firma ayarlarını yalnızca firma sahibi değiştirebilir. Bilgileri görüntülüyorsunuz.
        </p>
      )}
      <FormAlert error={state?.error} success={state?.success} />

      <div className="space-y-1.5">
        <Label htmlFor="tradeName">Firma ticari adı</Label>
        <Input id="tradeName" name="tradeName" defaultValue={organization.tradeName} disabled={readOnly} required />
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="taxOffice">Vergi dairesi</Label>
          <Input id="taxOffice" name="taxOffice" defaultValue={organization.taxOffice} disabled={readOnly} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="taxNumber">Vergi numarası</Label>
          <Input id="taxNumber" name="taxNumber" defaultValue={organization.taxNumber} disabled={readOnly} />
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="phone">Telefon</Label>
          <Input id="phone" name="phone" defaultValue={organization.phone} disabled={readOnly} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="email">E-posta</Label>
          <Input id="email" name="email" type="email" defaultValue={organization.email} disabled={readOnly} />
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="city">İl</Label>
          <Input id="city" name="city" defaultValue={organization.city} disabled={readOnly} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="district">İlçe</Label>
          <Input id="district" name="district" defaultValue={organization.district} disabled={readOnly} />
        </div>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="address">Adres</Label>
        <Input id="address" name="address" defaultValue={organization.address} disabled={readOnly} />
      </div>

      {!readOnly && (
        <Button type="submit" disabled={pending}>
          Değişiklikleri kaydet
        </Button>
      )}
    </form>
  );
}
