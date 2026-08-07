"use client";

import { useActionState } from "react";
import { ArrowRight, Loader2, Upload } from "lucide-react";
import { uploadDocumentAction } from "@/app/actions/document-extraction";
import { initialActionState } from "@/lib/action-state";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/input";
import { FormAlert } from "@/components/auth/field-error";

interface Option {
  id: string;
  name: string;
}

export function DocumentUploadForm({
  projects,
  requireProject,
}: {
  projects: Option[];
  requireProject: boolean;
}) {
  const [state, formAction, pending] = useActionState(uploadDocumentAction, initialActionState);

  return (
    <form action={formAction} className="space-y-4">
      <FormAlert error={state?.error} />

      <div className="space-y-1.5">
        <Label htmlFor="file">Fatura/fiş dosyası</Label>
        <input
          id="file"
          name="file"
          type="file"
          accept=".pdf,.jpg,.jpeg,.png,application/pdf,image/jpeg,image/png"
          required
          className="flex h-10 w-full items-center rounded-lg border border-input bg-card px-3 text-sm text-foreground file:mr-3 file:rounded-md file:border-0 file:bg-muted file:px-3 file:py-1.5 file:text-xs file:font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
        <p className="text-xs text-muted-foreground">PDF, JPEG veya PNG — en fazla 8 MB.</p>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="projectId">
          Proje {requireProject && <span className="text-destructive">*</span>}
        </Label>
        <select
          id="projectId"
          name="projectId"
          required={requireProject}
          className="flex h-10 w-full rounded-lg border border-input bg-card px-3 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {!requireProject && <option value="">Yok</option>}
          {requireProject && (
            <option value="" disabled>
              Seçin…
            </option>
          )}
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </div>

      <Button type="submit" disabled={pending} className="gap-2">
        {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
        Yükle ve oku
        {!pending && <ArrowRight className="h-4 w-4" />}
      </Button>
    </form>
  );
}
