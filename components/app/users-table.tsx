"use client";

import { useActionState } from "react";
import { changeUserRoleAction, deactivateUserAction, reactivateUserAction } from "@/app/actions/users";
import { initialActionState } from "@/lib/action-state";
import { ROLE_LABELS } from "@/lib/permissions";
import { FormAlert } from "@/components/auth/field-error";
import type { UserRole, UserStatus } from "@prisma/client";

interface UserRow {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  role: UserRole;
  status: UserStatus;
  projectCount: number;
}

const ALL_ROLES: UserRole[] = ["OWNER", "ADMIN", "FINANCE", "PROJECT_MANAGER"];

export function UsersTable({
  users,
  currentUserId,
  currentUserRole,
}: {
  users: UserRow[];
  currentUserId: string;
  currentUserRole: UserRole;
}) {
  return (
    <div className="overflow-hidden rounded-2xl border border-border bg-card shadow-soft">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border text-left">
              <th className="label-mono py-2.5 pl-4 font-medium text-muted-foreground">Kullanıcı</th>
              <th className="label-mono py-2.5 font-medium text-muted-foreground">Rol</th>
              <th className="label-mono py-2.5 font-medium text-muted-foreground">Durum</th>
              <th className="label-mono py-2.5 font-medium text-muted-foreground">Proje</th>
              <th className="label-mono py-2.5 pr-4 text-right font-medium text-muted-foreground">İşlem</th>
            </tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <UserRowItem
                key={u.id}
                user={u}
                isSelf={u.id === currentUserId}
                actorCanTouch={u.role !== "OWNER" || currentUserRole === "OWNER"}
                actorIsOwner={currentUserRole === "OWNER"}
              />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function UserRowItem({
  user,
  isSelf,
  actorCanTouch,
  actorIsOwner,
}: {
  user: UserRow;
  isSelf: boolean;
  actorCanTouch: boolean;
  actorIsOwner: boolean;
}) {
  const [roleState, roleAction] = useActionState(changeUserRoleAction, initialActionState);
  const [statusState, statusAction] = useActionState(
    user.status === "SUSPENDED" ? reactivateUserAction : deactivateUserAction,
    initialActionState,
  );

  const canManage = actorCanTouch && !isSelf;

  return (
    <tr className="border-b border-border/60 last:border-0">
      <td className="py-3 pl-4">
        <p className="font-medium leading-tight">
          {user.firstName} {user.lastName}
          {isSelf && <span className="ml-1.5 text-xs text-muted-foreground">(sen)</span>}
        </p>
        <p className="text-xs text-muted-foreground">{user.email}</p>
        {(roleState?.error || statusState?.error) && (
          <div className="mt-1">
            <FormAlert error={roleState?.error ?? statusState?.error} />
          </div>
        )}
      </td>
      <td className="py-3 pr-4">
        {canManage ? (
          <form action={roleAction}>
            <input type="hidden" name="userId" value={user.id} />
            <select
              name="role"
              defaultValue={user.role}
              onChange={(e) => e.currentTarget.form?.requestSubmit()}
              className="h-8 rounded-md border border-input bg-card px-2 text-xs text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {ALL_ROLES.filter((r) => r !== "OWNER" || actorIsOwner).map((r) => (
                <option key={r} value={r}>
                  {ROLE_LABELS[r]}
                </option>
              ))}
            </select>
          </form>
        ) : (
          <span className="text-[13px] text-muted-foreground">{ROLE_LABELS[user.role]}</span>
        )}
      </td>
      <td className="py-3 pr-4">
        <span
          className={
            user.status === "ACTIVE"
              ? "inline-flex items-center gap-1 rounded-full bg-success/12 px-2 py-0.5 text-[11px] font-semibold text-success"
              : "inline-flex items-center gap-1 rounded-full bg-destructive/10 px-2 py-0.5 text-[11px] font-semibold text-destructive"
          }
        >
          {user.status === "ACTIVE" ? "Aktif" : user.status === "SUSPENDED" ? "Pasif" : "Davetli"}
        </span>
      </td>
      <td className="py-3 pr-4 text-[13px] text-muted-foreground">{user.projectCount}</td>
      <td className="py-3 pr-4 text-right">
        {canManage && (
          <form action={statusAction} className="inline">
            <input type="hidden" name="userId" value={user.id} />
            <button
              type="submit"
              className="text-[12.5px] font-medium text-primary hover:underline cursor-pointer"
            >
              {user.status === "SUSPENDED" ? "Etkinleştir" : "Pasifleştir"}
            </button>
          </form>
        )}
      </td>
    </tr>
  );
}
