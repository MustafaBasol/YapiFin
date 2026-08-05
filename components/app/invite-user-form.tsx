"use client";

import { useActionState, useState } from "react";
import { inviteUserAction } from "@/app/actions/users";
import { initialActionState } from "@/lib/action-state";
import { ROLE_LABELS } from "@/lib/permissions";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import { FormAlert } from "@/components/auth/field-error";
import type { UserRole } from "@prisma/client";

const ROLE_OPTIONS: UserRole[] = ["ADMIN", "FINANCE", "PROJECT_MANAGER"];

export function InviteUserForm({ projects }: { projects: { id: string; name: string }[] }) {
  const [state, formAction, pending] = useActionState(inviteUserAction, initialActionState);
  const [role, setRole] = useState<UserRole>("FINANCE");

  return (
    <form action={formAction} className="space-y-4">
      <FormAlert error={state?.error} success={state?.success} />
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="email">E-posta</Label>
          <Input id="email" name="email" type="email" required />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="role">Rol</Label>
          <select
            id="role"
            name="role"
            value={role}
            onChange={(e) => setRole(e.target.value as UserRole)}
            className="flex h-10 w-full rounded-lg border border-input bg-card px-3 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {ROLE_OPTIONS.map((r) => (
              <option key={r} value={r}>
                {ROLE_LABELS[r]}
              </option>
            ))}
          </select>
        </div>
      </div>

      {role === "PROJECT_MANAGER" && (
        <div className="space-y-1.5">
          <Label>Proje erişimi</Label>
          {projects.length === 0 ? (
            <p className="text-sm text-muted-foreground">Önce en az bir proje oluşturmalısınız.</p>
          ) : (
            <div className="flex flex-wrap gap-2">
              {projects.map((p) => (
                <label
                  key={p.id}
                  className="flex items-center gap-1.5 rounded-lg border border-border bg-card px-2.5 py-1.5 text-[13px]"
                >
                  <input type="checkbox" name="projectIds" value={p.id} className="h-3.5 w-3.5" />
                  {p.name}
                </label>
              ))}
            </div>
          )}
        </div>
      )}

      <Button type="submit" disabled={pending} size="sm">
        Davet gönder
      </Button>
    </form>
  );
}
