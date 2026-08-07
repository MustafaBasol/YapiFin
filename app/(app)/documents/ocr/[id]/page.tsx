import Link from "next/link";
import { notFound } from "next/navigation";
import { requireRole } from "@/lib/auth/guard";
import {
  getDocumentExtractionForUser,
  parseCandidateResult,
} from "@/server/services/document-extraction-service";
import { ServiceError } from "@/server/services/errors";
import { listProjectsForUser } from "@/server/services/project-service";
import { listSuppliersForUser } from "@/server/services/supplier-service";
import { listCategoriesForTransactionForm } from "@/server/services/category-service";
import { canViewSuppliers } from "@/lib/permissions";
import { DocumentExtractionConfirmForm } from "@/components/app/document-extraction-confirm-form";

const STATUS_LABELS: Record<string, string> = {
  PENDING: "İşleniyor",
  EXTRACTED: "Okundu — gözden geçirin",
  FAILED: "Otomatik okuma başarısız — alanları elle girin",
  CONFIRMING: "Onaylanıyor",
  CONFIRMED: "Onaylandı",
};

function CandidateRow({ label, value, confidence }: { label: string; value: string | null; confidence: number | null }) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-border/60 py-2 text-sm last:border-0">
      <span className="text-muted-foreground">{label}</span>
      <span className="text-right font-medium">
        {value ?? <span className="text-muted-foreground/70">—</span>}
        {value && confidence != null && (
          <span className="ml-2 text-xs text-muted-foreground">({Math.round(confidence * 100)}%)</span>
        )}
      </span>
    </div>
  );
}

export default async function DocumentOcrReviewPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const user = await requireRole(["OWNER", "ADMIN", "FINANCE", "PROJECT_MANAGER"]);

  let extraction;
  try {
    extraction = await getDocumentExtractionForUser(user, id);
  } catch (err) {
    if (err instanceof ServiceError && err.code === "NOT_FOUND") notFound();
    throw err;
  }

  const candidates = parseCandidateResult(extraction.candidateJson);

  const [projects, suppliers, categories] = await Promise.all([
    listProjectsForUser(user),
    canViewSuppliers(user.role) ? listSuppliersForUser(user) : Promise.resolve([]),
    listCategoriesForTransactionForm(user, "EXPENSE"),
  ]);

  return (
    <div className="mx-auto max-w-3xl animate-fade-in space-y-6">
      <div>
        <h1 className="font-display text-2xl font-bold tracking-tight">Belgeyi gözden geçir ve onayla</h1>
        <p className="mt-0.5 text-sm text-muted-foreground">
          {extraction.fileName} · {STATUS_LABELS[extraction.status] ?? extraction.status}
        </p>
      </div>

      <div className="rounded-2xl border border-border bg-card p-6 shadow-soft">
        <h2 className="mb-1 text-sm font-semibold">OCR adayları (doğrulanmamış)</h2>
        <p className="mb-3 text-xs text-muted-foreground">
          Bu değerler otomatik okuma denemesinden gelir ve hiçbir şekilde doğrudan kaydedilmez. Aşağıdaki
          formu bu değerleri kontrol ederek siz doldurup onaylamalısınız.
        </p>
        <div>
          <CandidateRow label="Tedarikçi" value={candidates.supplierName.value} confidence={candidates.supplierName.confidence} />
          <CandidateRow label="Belge no" value={candidates.documentNumber.value} confidence={candidates.documentNumber.confidence} />
          <CandidateRow label="Belge tarihi" value={candidates.documentDateRaw.value} confidence={candidates.documentDateRaw.confidence} />
          <CandidateRow label="Ara toplam" value={candidates.subtotalAmountRaw.value} confidence={candidates.subtotalAmountRaw.confidence} />
          <CandidateRow label="KDV tutarı" value={candidates.taxAmountRaw.value} confidence={candidates.taxAmountRaw.confidence} />
          <CandidateRow label="Genel toplam" value={candidates.totalAmountRaw.value} confidence={candidates.totalAmountRaw.confidence} />
          <CandidateRow label="Para birimi" value={candidates.currency.value} confidence={candidates.currency.confidence} />
        </div>
      </div>

      {extraction.status === "CONFIRMED" && (
        <div className="rounded-2xl border border-success/30 bg-success/10 p-6 text-sm text-success">
          Bu belge zaten onaylanmış ve bir gider kaydına dönüştürülmüş.{" "}
          {extraction.confirmedTransactionId && (
            <Link href={`/expenses/${extraction.confirmedTransactionId}`} className="font-semibold underline">
              Gider kaydını görüntüle
            </Link>
          )}
        </div>
      )}

      {extraction.status === "CONFIRMING" && (
        <div className="rounded-2xl border border-warning/30 bg-warning/10 p-6 text-sm text-warning">
          Bu belge şu anda onaylanıyor. Lütfen sayfayı birazdan yenileyin.
        </div>
      )}

      {(extraction.status === "EXTRACTED" || extraction.status === "FAILED") && (
        <div className="rounded-2xl border border-border bg-card p-6 shadow-soft">
          <DocumentExtractionConfirmForm
            extractionId={extraction.id}
            documentNumberHint={candidates.documentNumber.value ?? ""}
            descriptionHint={candidates.supplierName.value ?? ""}
            projects={projects.map((p) => ({ id: p.id, name: p.name }))}
            suppliers={suppliers.map((s) => ({ id: s.id, name: s.name }))}
            categories={categories.map((c) => ({ id: c.id, name: c.name }))}
            requireProject={user.role === "PROJECT_MANAGER"}
          />
        </div>
      )}

      {extraction.status === "PENDING" && (
        <div className="rounded-2xl border border-border bg-card p-6 text-sm text-muted-foreground">
          Belge işleniyor, lütfen sayfayı birazdan yenileyin.
        </div>
      )}
    </div>
  );
}
