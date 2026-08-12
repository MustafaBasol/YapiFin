import { requireUser } from "@/lib/auth/guard";
import { AiInsightsPanel } from "@/components/app/ai-insights-panel";

export default async function AiInsightsPage() {
  await requireUser();

  return (
    <div className="mx-auto max-w-[1100px] animate-fade-in space-y-6">
      <div>
        <h1 className="font-display text-2xl font-bold tracking-tight">AI İçgörüleri</h1>
        <p className="mt-0.5 text-sm text-muted-foreground">
          Bütçe, nakit akışı ve tahsilat verilerinizden erken uyarılar. Rakamlar YapıFin&apos;in kendi hesaplamalarıdır; yorum ve
          öneriler yapay zekâ tarafından üretilir.
        </p>
      </div>
      <AiInsightsPanel />
    </div>
  );
}
