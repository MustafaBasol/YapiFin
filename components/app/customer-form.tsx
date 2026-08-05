"use client";

import { useActionState } from "react";
import { ArrowRight, Loader2 } from "lucide-react";
import { createCustomerAction, updateCustomerAction } from "@/app/actions/customers";
import { initialActionState } from "@/lib/action-state";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import { FormAlert } from "@/components/auth/field-error";
import { CUSTOMER_TYPE_META, CUSTOMER_TYPE_OPTIONS } from "@/components/app/customer-type";

interface CustomerDefaults {
  id: string;
  type: string;
  name: string;
  identityOrTaxNumber: string;
  taxOffice: string;
  contactName: string;
  phone: string;
  email: string;
  city: string;
  district: string;
  address: string;
}

export function CustomerForm({ customer }: { customer?: CustomerDefaults }) {
  const action = customer ? updateCustomerAction : createCustomerAction;
  const [state, formAction, pending] = useActionState(action, initialActionState);

  return (
    <form action={formAction} className="space-y-4">
      {customer && <input type="hidden" name="id" value={customer.id} />}
      <FormAlert error={state?.error} />

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="type">Tür</Label>
          <select
            id="type"
            name="type"
            defaultValue={customer?.type ?? "COMPANY"}
            className="flex h-10 w-full rounded-lg border border-input bg-card px-3 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {CUSTOMER_TYPE_OPTIONS.map((t) => (
              <option key={t} value={t}>
                {CUSTOMER_TYPE_META[t].label}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="name">Ad / Ünvan</Label>
          <Input id="name" name="name" defaultValue={customer?.name} required />
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="identityOrTaxNumber">TCKN / VKN</Label>
          <Input
            id="identityOrTaxNumber"
            name="identityOrTaxNumber"
            defaultValue={customer?.identityOrTaxNumber}
            inputMode="numeric"
            placeholder="opsiyonel"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="taxOffice">Vergi dairesi</Label>
          <Input id="taxOffice" name="taxOffice" defaultValue={customer?.taxOffice} />
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="contactName">İlgili kişi</Label>
          <Input id="contactName" name="contactName" defaultValue={customer?.contactName} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="phone">Telefon</Label>
          <Input id="phone" name="phone" defaultValue={customer?.phone} />
        </div>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="email">E-posta</Label>
        <Input id="email" name="email" type="email" defaultValue={customer?.email} />
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="city">İl</Label>
          <Input id="city" name="city" defaultValue={customer?.city} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="district">İlçe</Label>
          <Input id="district" name="district" defaultValue={customer?.district} />
        </div>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="address">Adres</Label>
        <textarea
          id="address"
          name="address"
          rows={2}
          defaultValue={customer?.address}
          className="flex w-full rounded-lg border border-input bg-card px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
      </div>

      <Button type="submit" disabled={pending} className="gap-2">
        {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
        {customer ? "Değişiklikleri kaydet" : "Müşteriyi oluştur"}
        {!pending && <ArrowRight className="h-4 w-4" />}
      </Button>
    </form>
  );
}
