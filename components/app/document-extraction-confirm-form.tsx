"use client";

import { useActionState } from "react";
import { ArrowRight, Loader2 } from "lucide-react";
import { confirmDocumentExtractionAction } from "@/app/actions/document-extraction";
import { initialActionState } from "@/lib/action-state";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import { FormAlert } from "@/components/auth/field-error";

interface Option {
  id: string;
  name: string;
}

/**
 * Onay formu — tutar/KDV alanları OCR adaylarından KASITLI OLARAK
 * ön-doldurulmaz (bkz. görev talimatı "OCR confidence should not bypass
 * human confirmation"); kullanıcı yukarıdaki "OCR adayları" kartında ham
 * (doğrulanmamış) değerleri görüp kendi elleriyle girer. Yalnızca serbest
 * metin alanları (belge no, açıklama) güvenli bir kolaylık olarak
 * ön-doldurulur — bunlar para aritmetiğine hiç girmez.
 */
export function DocumentExtractionConfirmForm({
  extractionId,
  documentNumberHint,
  descriptionHint,
  projects,
  suppliers,
  categories,
  requireProject,
}: {
  extractionId: string;
  documentNumberHint: string;
  descriptionHint: string;
  projects: Option[];
  suppliers: Option[];
  categories: Option[];
  requireProject: boolean;
}) {
  const [state, formAction, pending] = useActionState(confirmDocumentExtractionAction, initialActionState);
  const today = new Date().toISOString().slice(0, 10);

  return (
    <form action={formAction} className="space-y-4">
      <input type="hidden" name="extractionId" value={extractionId} />
      <FormAlert error={state?.error} />

      <div className="space-y-1.5">
        <Label htmlFor="description">Açıklama</Label>
        <Input id="description" name="description" defaultValue={descriptionHint} required />
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="categoryId">Kategori</Label>
          <select
            id="categoryId"
            name="categoryId"
            required
            defaultValue=""
            className="flex h-10 w-full rounded-lg border border-input bg-card px-3 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <option value="" disabled>
              Seçin…
            </option>
            {categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </div>
        {suppliers.length > 0 && (
          <div className="space-y-1.5">
            <Label htmlFor="supplierId">Tedarikçi / Taşeron</Label>
            <select
              id="supplierId"
              name="supplierId"
              defaultValue=""
              className="flex h-10 w-full rounded-lg border border-input bg-card px-3 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <option value="">Yok</option>
              {suppliers.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </div>
        )}
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="projectId">
            Proje {requireProject && <span className="text-destructive">*</span>}
          </Label>
          <select
            id="projectId"
            name="projectId"
            required={requireProject}
            defaultValue=""
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
        <div className="space-y-1.5">
          <Label htmlFor="documentNumber">Belge/fatura no</Label>
          <Input id="documentNumber" name="documentNumber" defaultValue={documentNumberHint} placeholder="opsiyonel" />
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="issueDate">Belge tarihi</Label>
          <Input id="issueDate" name="issueDate" type="date" defaultValue={today} required />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="dueDate">Vade tarihi</Label>
          <Input id="dueDate" name="dueDate" type="date" />
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="subtotal">Ara toplam</Label>
          <Input id="subtotal" name="subtotal" type="number" step="0.01" min="0.01" required />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="taxRate">KDV oranı (%)</Label>
          <Input id="taxRate" name="taxRate" type="number" step="0.01" min="0" max="100" defaultValue={20} />
        </div>
      </div>

      <Button type="submit" disabled={pending} className="gap-2">
        {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
        Onayla ve gider olarak kaydet
        {!pending && <ArrowRight className="h-4 w-4" />}
      </Button>
    </form>
  );
}
