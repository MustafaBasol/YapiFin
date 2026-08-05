import { requireRole } from "@/lib/auth/guard";
import { ProjectForm } from "@/components/app/project-form";

export default async function NewProjectPage() {
  await requireRole(["OWNER", "ADMIN"]);

  return (
    <div className="mx-auto max-w-3xl animate-fade-in space-y-6">
      <div>
        <h1 className="font-display text-2xl font-bold tracking-tight">Yeni proje</h1>
        <p className="mt-0.5 text-sm text-muted-foreground">Proje bilgilerini girin.</p>
      </div>
      <div className="rounded-2xl border border-border bg-card p-6 shadow-soft">
        <ProjectForm />
      </div>
    </div>
  );
}
