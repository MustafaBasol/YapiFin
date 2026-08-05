"use client";

import { useActionState } from "react";
import { resendInvitationAction } from "@/app/actions/users";
import { initialActionState } from "@/lib/action-state";
import { ROLE_LABELS } from "@/lib/permissions";
import { formatDate } from "@/lib/utils";
import type { UserRole } from "@prisma/client";

interface Invitation {
  id: string;
  email: string;
  role: UserRole;
  expiresAt: string;
}

export function PendingInvitationsTable({ invitations }: { invitations: Invitation[] }) {
  return (
    <div className="overflow-hidden rounded-2xl border border-border bg-card shadow-soft">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border text-left">
              <th className="label-mono py-2.5 pl-4 font-medium text-muted-foreground">E-posta</th>
              <th className="label-mono py-2.5 font-medium text-muted-foreground">Rol</th>
              <th className="label-mono py-2.5 font-medium text-muted-foreground">Son geçerlilik</th>
              <th className="label-mono py-2.5 pr-4 text-right font-medium text-muted-foreground">İşlem</th>
            </tr>
          </thead>
          <tbody>
            {invitations.map((inv) => (
              <InvitationRow key={inv.id} invitation={inv} />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function InvitationRow({ invitation }: { invitation: Invitation }) {
  const [state, formAction, pending] = useActionState(resendInvitationAction, initialActionState);
  const expired = new Date(invitation.expiresAt) < new Date();

  return (
    <tr className="border-b border-border/60 last:border-0">
      <td className="py-3 pl-4 font-medium">{invitation.email}</td>
      <td className="py-3 pr-4 text-muted-foreground">{ROLE_LABELS[invitation.role]}</td>
      <td className="py-3 pr-4">
        <span className={expired ? "text-destructive" : "text-muted-foreground"}>
          {formatDate(invitation.expiresAt)}
          {expired && " · süresi doldu"}
        </span>
      </td>
      <td className="py-3 pr-4 text-right">
        <form action={formAction} className="inline">
          <input type="hidden" name="invitationId" value={invitation.id} />
          <button type="submit" disabled={pending} className="text-[12.5px] font-medium text-primary hover:underline cursor-pointer">
            Yeniden gönder
          </button>
        </form>
        {state?.error && <span className="ml-2 text-[11px] text-destructive">{state.error}</span>}
      </td>
    </tr>
  );
}
