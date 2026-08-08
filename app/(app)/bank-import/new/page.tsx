import { requireRole } from "@/lib/auth/guard";
import { listBankAccountsForImport } from "@/server/services/bank-import-service";
import { BankImportUploadForm } from "@/components/app/bank-import-upload-form";

export default async function NewBankImportPage() {
  const user = await requireRole(["OWNER", "ADMIN", "FINANCE"]);
  const accounts = await listBankAccountsForImport(user);

  return (
    <div className="mx-auto max-w-3xl animate-fade-in space-y-6">
      <div>
        <h1 className="font-display text-2xl font-bold tracking-tight">Banka ekstresi içe aktar</h1>
        <p className="mt-0.5 text-sm text-muted-foreground">
          Dosyadaki satırlar yalnızca aday olarak kaydedilir; hiçbir tahsilat, ödeme veya transfer otomatik
          oluşturulmaz. Her satırı bir sonraki adımda gözden geçirip tek tek mutabık kılmanız veya yok saymanız
          gerekir.
        </p>
      </div>
      <div className="rounded-2xl border border-border bg-card p-6 shadow-soft">
        <BankImportUploadForm accounts={accounts.map((a) => ({ id: a.id, name: a.name, bankName: a.bankName }))} />
      </div>
    </div>
  );
}
