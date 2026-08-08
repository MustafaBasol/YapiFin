import Link from "next/link";
import { Plus } from "lucide-react";
import { requireRole } from "@/lib/auth/guard";
import { listBatchesForUser } from "@/server/services/bank-import-service";
import { formatDateTime } from "@/lib/utils";

export default async function BankImportListPage() {
  const user = await requireRole(["OWNER", "ADMIN", "FINANCE"]);
  const batches = await listBatchesForUser(user);

  return (
    <div className="mx-auto max-w-[1200px] animate-fade-in space-y-6">
      <div className="flex flex-wrap items-center gap-3">
        <div>
          <h1 className="font-display text-2xl font-bold tracking-tight">Banka İçe Aktarım</h1>
          <p className="mt-0.5 text-sm text-muted-foreground">
            Yüklenen ekstre dosyaları ve mutabakat durumu. Hiçbir satır sizin onayınız olmadan finansal kayda
            dönüşmez.
          </p>
        </div>
        <div className="ml-auto">
          <Link
            href="/bank-import/new"
            className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-primary px-3.5 text-[13px] font-semibold text-primary-foreground shadow-sm transition-opacity hover:opacity-90"
          >
            <Plus className="h-4 w-4" />
            Ekstre içe aktar
          </Link>
        </div>
      </div>

      {batches.length === 0 ? (
        <div className="rounded-2xl border border-border bg-card p-8 text-center text-sm text-muted-foreground shadow-soft">
          Henüz içe aktarılmış bir ekstre yok.
        </div>
      ) : (
        <div className="overflow-hidden rounded-2xl border border-border bg-card shadow-soft">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left">
                  <th className="label-mono px-4 py-3 font-medium text-muted-foreground">Dosya</th>
                  <th className="label-mono px-4 py-3 font-medium text-muted-foreground">Yüklenme</th>
                  <th className="label-mono px-4 py-3 text-right font-medium text-muted-foreground">İçe Aktarılan</th>
                  <th className="label-mono px-4 py-3 text-right font-medium text-muted-foreground">Hatalı</th>
                  <th className="label-mono px-4 py-3 text-right font-medium text-muted-foreground">Mükerrer (Atlanan)</th>
                </tr>
              </thead>
              <tbody>
                {batches.map((b) => (
                  <tr key={b.id} className="border-b border-border/60 last:border-0 hover:bg-muted/40">
                    <td className="px-4 py-3">
                      <Link href={`/bank-import/${b.id}`} className="font-medium text-foreground hover:underline">
                        {b.fileName}
                      </Link>
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">{formatDateTime(b.createdAt)}</td>
                    <td className="px-4 py-3 text-right tabular-nums">{b.importedRowCount}</td>
                    <td className="px-4 py-3 text-right tabular-nums">
                      {b.errorRowCount > 0 ? <span className="text-destructive">{b.errorRowCount}</span> : b.errorRowCount}
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums text-muted-foreground">{b.duplicateSkippedCount}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
