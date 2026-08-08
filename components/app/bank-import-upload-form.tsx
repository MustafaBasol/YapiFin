"use client";

import { useActionState } from "react";
import { ArrowRight, Loader2, Upload } from "lucide-react";
import { uploadBankStatementAction } from "@/app/actions/bank-import";
import { initialActionState } from "@/lib/action-state";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/input";
import { FormAlert } from "@/components/auth/field-error";

interface AccountOption {
  id: string;
  name: string;
  bankName: string | null;
}

export function BankImportUploadForm({ accounts }: { accounts: AccountOption[] }) {
  const [state, formAction, pending] = useActionState(uploadBankStatementAction, initialActionState);

  return (
    <form action={formAction} className="space-y-4">
      <FormAlert error={state?.error} />

      <div className="space-y-1.5">
        <Label htmlFor="financialAccountId">Banka hesabı</Label>
        <select
          id="financialAccountId"
          name="financialAccountId"
          required
          defaultValue=""
          className="flex h-10 w-full rounded-lg border border-input bg-card px-3 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <option value="" disabled>
            Seçin…
          </option>
          {accounts.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
              {a.bankName ? ` — ${a.bankName}` : ""}
            </option>
          ))}
        </select>
        {accounts.length === 0 && (
          <p className="text-xs text-destructive">Aktif banka hesabı bulunamadı. Önce Kasa ve Banka altından bir banka hesabı oluşturun.</p>
        )}
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="file">Ekstre dosyası</Label>
        <input
          id="file"
          name="file"
          type="file"
          accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
          required
          className="flex h-10 w-full items-center rounded-lg border border-input bg-card px-3 text-sm text-foreground file:mr-3 file:rounded-md file:border-0 file:bg-muted file:px-3 file:py-1.5 file:text-xs file:font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
        <p className="text-xs text-muted-foreground">
          CSV veya Excel (.xlsx) — en fazla 5 MB. Dosyada &quot;Tarih&quot;, &quot;Açıklama&quot; ve &quot;Tutar&quot; başlıklı sütunlar
          olmalıdır.
        </p>
      </div>

      <Button type="submit" disabled={pending || accounts.length === 0} className="gap-2">
        {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
        Yükle ve önizle
        {!pending && <ArrowRight className="h-4 w-4" />}
      </Button>
    </form>
  );
}
