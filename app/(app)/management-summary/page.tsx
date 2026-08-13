import { requireUser } from "@/lib/auth/guard";
import { ManagementSummaryPanel } from "@/components/app/management-summary-panel";

export default async function ManagementSummaryPage() {
  await requireUser();

  return (
    <div className="mx-auto max-w-[1100px] animate-fade-in space-y-6">
      <div>
        <h1 className="font-display text-2xl font-bold tracking-tight">AI Yönetim Özeti</h1>
        <p className="mt-0.5 text-sm text-muted-foreground">
          Tamamlanmış son haftanın finansal tablosu, bir önceki haftayla karşılaştırmalı olarak. Rakamlar YapıFin&apos;in kendi
          hesaplamalarıdır; yorum, önceliklendirme ve aksiyon önerileri yapay zekâ tarafından üretilir.
        </p>
      </div>
      <ManagementSummaryPanel />
    </div>
  );
}
