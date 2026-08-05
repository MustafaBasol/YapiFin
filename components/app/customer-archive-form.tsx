"use client";

import { useActionState } from "react";
import { archiveCustomerAction, reactivateCustomerAction } from "@/app/actions/customers";
import { initialActionState } from "@/lib/action-state";
import { Button } from "@/components/ui/button";
import { FormAlert } from "@/components/auth/field-error";

export function CustomerArchiveForm({ customerId, isActive }: { customerId: string; isActive: boolean }) {
  const [state, formAction, pending] = useActionState(
    isActive ? archiveCustomerAction : reactivateCustomerAction,
    initialActionState,
  );

  return (
    <form action={formAction} className="space-y-2">
      <input type="hidden" name="id" value={customerId} />
      <FormAlert error={state?.error} success={state?.success} />
      <Button type="submit" variant={isActive ? "outline" : "primary"} size="sm" disabled={pending}>
        {isActive ? "Müşteriyi arşivle" : "Yeniden etkinleştir"}
      </Button>
    </form>
  );
}
