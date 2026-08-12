import { requireUser } from "@/lib/auth/guard";
import { AskYapiFinPanel } from "@/components/app/ask-yapifin-panel";

export default async function AskYapiFinPage() {
  await requireUser();

  return (
    <div className="mx-auto max-w-[1100px] animate-fade-in space-y-6">
      <div>
        <h1 className="font-display text-2xl font-bold tracking-tight">YapıFin&apos;e Sor</h1>
        <p className="mt-0.5 text-sm text-muted-foreground">
          Bütçe, nakit akışı, alacak/borç ve proje durumu hakkında sorular sorun. Rakamlar her zaman YapıFin&apos;in kendi
          hesaplamalarıdır; yalnızca yorum yapay zekâ tarafından üretilir.
        </p>
      </div>
      <AskYapiFinPanel />
    </div>
  );
}
