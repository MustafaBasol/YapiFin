import { requireRole } from "@/lib/auth/guard";
import { listProjectsForUser } from "@/server/services/project-service";
import { DocumentUploadForm } from "@/components/app/document-upload-form";

export default async function NewDocumentOcrPage() {
  const user = await requireRole(["OWNER", "ADMIN", "FINANCE", "PROJECT_MANAGER"]);
  const projects = await listProjectsForUser(user);

  return (
    <div className="mx-auto max-w-3xl animate-fade-in space-y-6">
      <div>
        <h1 className="font-display text-2xl font-bold tracking-tight">Belge yükle (OCR)</h1>
        <p className="mt-0.5 text-sm text-muted-foreground">
          Fatura veya fiş yükleyin; sistem alanları okumayı dener. Hiçbir gider kaydı otomatik
          oluşturulmaz — bir sonraki adımda tüm alanları gözden geçirip onaylamanız gerekir.
        </p>
      </div>
      <div className="rounded-2xl border border-border bg-card p-6 shadow-soft">
        <DocumentUploadForm
          projects={projects.map((p) => ({ id: p.id, name: p.name }))}
          requireProject={user.role === "PROJECT_MANAGER"}
        />
      </div>
    </div>
  );
}
