"use client";

import { useActionState } from "react";
import { archiveSupplierAction, reactivateSupplierAction } from "@/app/actions/suppliers";
import { initialActionState } from "@/lib/action-state";
import { Button } from "@/components/ui/button";
import { FormAlert } from "@/components/auth/field-error";

export function SupplierArchiveForm({ supplierId, isActive }: { supplierId: string; isActive: boolean }) {
  const [state, formAction, pending] = useActionState(
    isActive ? archiveSupplierAction : reactivateSupplierAction,
    initialActionState,
  );

  return (
    <form action={formAction} className="space-y-2">
      <input type="hidden" name="id" value={supplierId} />
      <FormAlert error={state?.error} success={state?.success} />
      <Button type="submit" variant={isActive ? "outline" : "primary"} size="sm" disabled={pending}>
        {isActive ? "Tedarikçiyi arşivle" : "Yeniden etkinleştir"}
      </Button>
    </form>
  );
}
