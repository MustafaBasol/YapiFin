"use client";

import { useActionState } from "react";
import { archiveAccountAction, reactivateAccountAction } from "@/app/actions/accounts";
import { initialActionState } from "@/lib/action-state";
import { Button } from "@/components/ui/button";
import { FormAlert } from "@/components/auth/field-error";

export function AccountArchiveForm({ accountId, isActive }: { accountId: string; isActive: boolean }) {
  const [state, formAction, pending] = useActionState(
    isActive ? archiveAccountAction : reactivateAccountAction,
    initialActionState,
  );

  return (
    <form action={formAction} className="space-y-2">
      <input type="hidden" name="id" value={accountId} />
      <FormAlert error={state?.error} success={state?.success} />
      <Button type="submit" variant={isActive ? "outline" : "primary"} size="sm" disabled={pending}>
        {isActive ? "Hesabı arşivle" : "Yeniden etkinleştir"}
      </Button>
    </form>
  );
}
