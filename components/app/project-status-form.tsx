"use client";

import { useActionState } from "react";
import { setProjectStatusAction } from "@/app/actions/projects";
import { initialActionState } from "@/lib/action-state";
import { PROJECT_STATUS_META } from "@/components/app/project-status";
import { FormAlert } from "@/components/auth/field-error";
import type { ProjectStatus } from "@prisma/client";

export function ProjectStatusForm({
  projectId,
  currentStatus,
  options,
}: {
  projectId: string;
  currentStatus: ProjectStatus;
  options: ProjectStatus[];
}) {
  const [state, formAction, pending] = useActionState(setProjectStatusAction, initialActionState);

  return (
    <form action={formAction} className="space-y-2.5">
      <input type="hidden" name="projectId" value={projectId} />
      <FormAlert error={state?.error} success={state?.success} />
      <select
        name="status"
        defaultValue={currentStatus}
        disabled={pending}
        onChange={(e) => e.currentTarget.form?.requestSubmit()}
        className="flex h-10 w-full rounded-lg border border-input bg-card px-3 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {options.map((s) => (
          <option key={s} value={s}>
            {PROJECT_STATUS_META[s].label}
          </option>
        ))}
      </select>
    </form>
  );
}
