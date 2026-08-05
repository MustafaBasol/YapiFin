"use client";

import { useActionState } from "react";
import { UserMinus } from "lucide-react";
import { assignProjectMemberAction, removeProjectMemberAction } from "@/app/actions/projects";
import { initialActionState } from "@/lib/action-state";
import { Button } from "@/components/ui/button";
import { FormAlert } from "@/components/auth/field-error";

interface Member {
  userId: string;
  name: string;
  email: string;
  roleLabel: string;
}

interface AssignableUser {
  id: string;
  name: string;
  roleLabel: string;
}

export function ProjectTeam({
  projectId,
  members,
  assignableUsers,
  canManage,
}: {
  projectId: string;
  members: Member[];
  assignableUsers: AssignableUser[];
  canManage: boolean;
}) {
  const [assignState, assignAction, assignPending] = useActionState(assignProjectMemberAction, initialActionState);
  const [removeState, removeAction] = useActionState(removeProjectMemberAction, initialActionState);

  return (
    <div className="mt-4 space-y-4">
      <FormAlert error={assignState?.error ?? removeState?.error} success={assignState?.success ?? removeState?.success} />

      {members.length === 0 ? (
        <p className="text-sm text-muted-foreground">Bu projeye henüz kimse atanmadı.</p>
      ) : (
        <ul className="space-y-1.5">
          {members.map((m) => (
            <li key={m.userId} className="flex items-center gap-2.5 rounded-lg border border-border px-3 py-2">
              <div className="min-w-0 flex-1">
                <p className="truncate text-[13px] font-medium">{m.name}</p>
                <p className="truncate text-[11px] text-muted-foreground">
                  {m.email} · {m.roleLabel}
                </p>
              </div>
              {canManage && (
                <form action={removeAction}>
                  <input type="hidden" name="projectId" value={projectId} />
                  <input type="hidden" name="userId" value={m.userId} />
                  <button
                    type="submit"
                    aria-label="Projeden çıkar"
                    className="grid h-7 w-7 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive cursor-pointer"
                  >
                    <UserMinus className="h-4 w-4" />
                  </button>
                </form>
              )}
            </li>
          ))}
        </ul>
      )}

      {canManage && assignableUsers.length > 0 && (
        <form action={assignAction} className="flex items-center gap-2 border-t border-border pt-4">
          <input type="hidden" name="projectId" value={projectId} />
          <select
            name="userId"
            required
            className="h-9 flex-1 rounded-lg border border-input bg-card px-2.5 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <option value="">Kullanıcı seç…</option>
            {assignableUsers.map((u) => (
              <option key={u.id} value={u.id}>
                {u.name} ({u.roleLabel})
              </option>
            ))}
          </select>
          <Button type="submit" size="sm" disabled={assignPending}>
            Ekle
          </Button>
        </form>
      )}
    </div>
  );
}
