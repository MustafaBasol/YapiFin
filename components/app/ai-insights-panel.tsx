"use client";

import { useState } from "react";
import { Sparkles, Loader2, AlertTriangle, RefreshCw, ShieldAlert, Lightbulb } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { AiInsight, AiInsightsResult, InsightSeverity } from "@/lib/ai/insights/schema";

type BadgeTone = "neutral" | "primary" | "success" | "warning" | "destructive" | "info";

const SEVERITY_TONE: Record<InsightSeverity, BadgeTone> = {
  CRITICAL: "destructive",
  HIGH: "warning",
  MEDIUM: "info",
  LOW: "neutral",
};

const SEVERITY_LABELS: Record<InsightSeverity, string> = {
  CRITICAL: "Kritik",
  HIGH: "Yüksek",
  MEDIUM: "Orta",
  LOW: "Düşük",
};

type ErrorState = { message: string; code?: string; retryable: boolean };

function errorFromResponse(status: number, body: { error?: string; code?: string }): ErrorState {
  const message = body.error ?? "İçgörüler üretilirken bir hata oluştu.";
  if (body.code === "AI_PLAN_REQUIRED") {
    return { message: "Bu özellik mevcut planınıza dahil değil. Devam etmek için planınızı yükseltin.", code: body.code, retryable: false };
  }
  if (body.code === "AI_QUOTA_EXCEEDED") {
    return { message: "Bu ayki AI kullanım kotanız doldu. Yeni dönemde veya plan yükseltmesiyle tekrar deneyebilirsiniz.", code: body.code, retryable: false };
  }
  if (body.code === "AI_PROVIDER_DISABLED") {
    return { message: "AI içgörü özelliği bu organizasyon için henüz etkin değil.", code: body.code, retryable: false };
  }
  if (body.code === "AI_PROVIDER_UNAVAILABLE") {
    return { message: "AI sağlayıcısına şu anda ulaşılamıyor. Lütfen birazdan tekrar deneyin.", code: body.code, retryable: true };
  }
  return { message, code: body.code, retryable: status >= 500 };
}

export function AiInsightsPanel() {
  const [status, setStatus] = useState<"idle" | "loading" | "success" | "error">("idle");
  const [result, setResult] = useState<AiInsightsResult | null>(null);
  const [error, setError] = useState<ErrorState | null>(null);

  async function generate() {
    setStatus("loading");
    setError(null);
    try {
      const res = await fetch("/api/ai/insights", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
      const body = await res.json();
      if (!res.ok) {
        setError(errorFromResponse(res.status, body));
        setStatus("error");
        return;
      }
      setResult(body as AiInsightsResult);
      setStatus("success");
    } catch {
      setError({ message: "Ağ bağlantısı hatası. Lütfen tekrar deneyin.", retryable: true });
      setStatus("error");
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-border bg-card p-5 shadow-soft">
        <div className="flex items-start gap-3">
          <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary">
            <Sparkles className="h-4.5 w-4.5" />
          </span>
          <div>
            <p className="text-sm font-semibold text-foreground">AI finansal içgörüleri</p>
            <p className="mt-0.5 text-[12.5px] text-muted-foreground">
              Mevcut bütçe, nakit akışı ve tahsilat verilerinizden erken uyarılar üretir. Tüm tutarlar YapiFin&apos;in kendi
              hesaplamalarından gelir; AI yalnızca yorumlar ve önceliklendirir.
            </p>
          </div>
        </div>
        <Button onClick={generate} disabled={status === "loading"}>
          {status === "loading" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
          İçgörüleri Üret
        </Button>
      </div>

      {status === "error" && error && (
        <div className="flex items-start gap-3 rounded-2xl border border-destructive/20 bg-destructive/5 p-5">
          <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-destructive" />
          <div className="flex-1">
            <p className="text-sm font-medium text-destructive">{error.message}</p>
          </div>
          {error.retryable && (
            <Button variant="outline" onClick={generate}>
              <RefreshCw className="h-3.5 w-3.5" />
              Tekrar dene
            </Button>
          )}
        </div>
      )}

      {status === "success" && result && result.insights.length === 0 && (
        <div className="grid place-items-center rounded-2xl border border-dashed border-border bg-card py-16 text-center">
          <ShieldAlert className="h-8 w-8 text-muted-foreground/50" />
          <p className="mt-3 text-sm text-muted-foreground">Şu anda dikkat gerektiren bir finansal sinyal bulunamadı.</p>
          <p className="mt-1 text-[12.5px] text-muted-foreground">Bütçe, nakit akışı ve tahsilat durumunuz normal görünüyor.</p>
        </div>
      )}

      {status === "success" && result && result.insights.length > 0 && (
        <div className="space-y-3">
          {result.truncated && (
            <p className="text-[12px] text-muted-foreground">
              En önemli {result.insights.length} sinyal gösteriliyor (toplam {result.signalCount} sinyal tespit edildi).
            </p>
          )}
          {result.insights.map((insight) => (
            <InsightCard key={insight.id} insight={insight} />
          ))}
        </div>
      )}
    </div>
  );
}

function InsightCard({ insight }: { insight: AiInsight }) {
  const evidenceEntries = Object.entries(insight.evidence);
  return (
    <div className="rounded-2xl border border-border bg-card p-5 shadow-soft">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={SEVERITY_TONE[insight.severity]}>{SEVERITY_LABELS[insight.severity]}</Badge>
        {insight.affectedProjectName && <Badge tone="neutral">{insight.affectedProjectName}</Badge>}
        <span
          className={cn(
            "ml-auto inline-flex items-center gap-1 text-[11px] font-medium",
            insight.isAiGenerated ? "text-primary" : "text-muted-foreground",
          )}
          title={
            insight.isAiGenerated
              ? "Bu açıklama yapay zekâ tarafından üretildi; aşağıdaki kanıt rakamları YapiFin'in kendi hesaplamalarıdır."
              : "AI yorumu şu anda üretilemedi; aşağıdaki metin YapiFin'in otomatik özetidir."
          }
        >
          <Lightbulb className="h-3 w-3" />
          {insight.isAiGenerated ? "AI yorumu" : "Otomatik özet"}
        </span>
      </div>

      <h3 className="mt-2.5 text-[15px] font-semibold text-foreground">{insight.title}</h3>
      <p className="mt-1 text-[13px] leading-relaxed text-muted-foreground">{insight.explanation}</p>

      {evidenceEntries.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 rounded-lg bg-muted/50 px-3 py-2 text-[11.5px] text-muted-foreground">
          {evidenceEntries.map(([key, value]) => (
            <span key={key} className="tnum">
              <span className="text-muted-foreground/70">{key}:</span> {value}
            </span>
          ))}
        </div>
      )}

      <div className="mt-3 flex items-start gap-1.5 border-t border-border pt-3 text-[13px] text-foreground">
        <span className="font-medium">Önerilen aksiyon:</span>
        <span className="text-muted-foreground">{insight.suggestedAction}</span>
      </div>
    </div>
  );
}
