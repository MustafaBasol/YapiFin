"use client";

import { useActionState } from "react";
import { ArrowRight, Loader2 } from "lucide-react";
import { createSupplierAction, updateSupplierAction } from "@/app/actions/suppliers";
import { initialActionState } from "@/lib/action-state";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import { FormAlert } from "@/components/auth/field-error";
import { SUPPLIER_TYPE_META, SUPPLIER_TYPE_OPTIONS } from "@/components/app/supplier-type";

interface SupplierDefaults {
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

export function SupplierForm({ supplier }: { supplier?: SupplierDefaults }) {
  const action = supplier ? updateSupplierAction : createSupplierAction;
  const [state, formAction, pending] = useActionState(action, initialActionState);

  return (
    <form action={formAction} className="space-y-4">
      {supplier && <input type="hidden" name="id" value={supplier.id} />}
      <FormAlert error={state?.error} />

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="type">Tür</Label>
          <select
            id="type"
            name="type"
            defaultValue={supplier?.type ?? "SUPPLIER"}
            className="flex h-10 w-full rounded-lg border border-input bg-card px-3 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {SUPPLIER_TYPE_OPTIONS.map((t) => (
              <option key={t} value={t}>
                {SUPPLIER_TYPE_META[t].label}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="name">Ad / Ünvan</Label>
          <Input id="name" name="name" defaultValue={supplier?.name} required />
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="identityOrTaxNumber">TCKN / VKN</Label>
          <Input
            id="identityOrTaxNumber"
            name="identityOrTaxNumber"
            defaultValue={supplier?.identityOrTaxNumber}
            inputMode="numeric"
            placeholder="opsiyonel"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="taxOffice">Vergi dairesi</Label>
          <Input id="taxOffice" name="taxOffice" defaultValue={supplier?.taxOffice} />
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="contactName">İlgili kişi</Label>
          <Input id="contactName" name="contactName" defaultValue={supplier?.contactName} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="phone">Telefon</Label>
          <Input id="phone" name="phone" defaultValue={supplier?.phone} />
        </div>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="email">E-posta</Label>
        <Input id="email" name="email" type="email" defaultValue={supplier?.email} />
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="city">İl</Label>
          <Input id="city" name="city" defaultValue={supplier?.city} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="district">İlçe</Label>
          <Input id="district" name="district" defaultValue={supplier?.district} />
        </div>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="address">Adres</Label>
        <textarea
          id="address"
          name="address"
          rows={2}
          defaultValue={supplier?.address}
          className="flex w-full rounded-lg border border-input bg-card px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
      </div>

      <Button type="submit" disabled={pending} className="gap-2">
        {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
        {supplier ? "Değişiklikleri kaydet" : "Tedarikçiyi oluştur"}
        {!pending && <ArrowRight className="h-4 w-4" />}
      </Button>
    </form>
  );
}
