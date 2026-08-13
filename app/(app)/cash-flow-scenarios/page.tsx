import { requireUser } from "@/lib/auth/guard";
import { CashFlowScenarioPanel } from "@/components/app/cash-flow-scenario-panel";

export default async function CashFlowScenariosPage() {
  await requireUser();

  return (
    <div className="mx-auto max-w-[1100px] animate-fade-in space-y-6">
      <div>
        <h1 className="font-display text-2xl font-bold tracking-tight">Nakit Akışı Senaryoları</h1>
        <p className="mt-0.5 text-sm text-muted-foreground">
          Açık alacak ve borçlarınızın vade tarihlerinden 30, 60 ve 90 günlük nakit projeksiyonu: baz, risk ve iyimser
          senaryolar, kritik kırılma tarihi ve öne çıkan risk faktörleri. Rakamlar YapıFin&apos;in kendi
          hesaplamalarıdır; yorum, önceliklendirme ve aksiyon önerileri yapay zekâ tarafından üretilir.
        </p>
      </div>
      <CashFlowScenarioPanel />
    </div>
  );
}
