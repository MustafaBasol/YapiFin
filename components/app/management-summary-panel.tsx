"use client";

import { useState } from "react";
import { Sparkles, Loader2, AlertTriangle, RefreshCw, CalendarRange, Lightbulb, ListChecks, TrendingDown, TrendingUp, Minus, Info } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { cn, formatMoney } from "@/lib/utils";
import type { InsightSeverity } from "@/lib/ai/insights/schema";
import type {
  ManagementSummary,
  ManagementSummaryMetric,
  ManagementSummaryRisk,
} from "@/lib/ai/management-summary/schema";

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

/**
 * Ölçü değerini tr-TR biçiminde gösterir. `lib/utils.ts` `formatPercent`
 * BİLEREK kullanılmaz — o yardımcı pozitif değerlere `+` öneki ekler ve
 * yalnızca işaretli DEĞİŞİM içindir; bir seviye değeri ("bütçe kullanım oranı
 * %62") `+%62` olarak gösterilemez (bkz. ai-insights-panel.tsx, aynı ayrım).
 */
function formatMetricValue(value: string, kind: ManagementSummaryMetric["kind"]): string {
  switch (kind) {
    case "MONEY":
      return formatMoney(value);
    case "PERCENT":
      return `%${value.replace(".", ",")}`;
    // Yüzde PUAN, yüzde DEĞİLDİR (bkz. YF-702-F3) — birim açıkça yazılır.
    case "PERCENTAGE_POINT":
      return `${value.replace(".", ",")} puan`;
    case "TEXT":
      return value;
  }
}

/** İşaretli değişim metni — pozitif değerler `+` öneki alır. */
function formatSignedChange(value: string, kind: ManagementSummaryMetric["kind"]): string {
  const sign = value.startsWith("-") ? "" : "+";
  return `${sign}${formatMetricValue(value, kind)}`;
}

/**
 * Değişimin rengi, ölçünün KENDİ semantiğinden türetilir: tahsilatın artması
 * iyidir, vadesi geçmiş alacağın artması kötüdür. Bu karar sunucuda
 * `favorableDirection` alanıyla verilir; arayüz onu yeniden yorumlamaz
 * (bkz. lib/ai/management-summary/schema.ts).
 */
function changeTone(metric: ManagementSummaryMetric): "success" | "destructive" | "muted" {
  if (!metric.direction || metric.direction === "FLAT" || metric.favorableDirection === "NONE") return "muted";
  return metric.direction === metric.favorableDirection ? "success" : "destructive";
}

function DirectionIcon({ direction }: { direction: ManagementSummaryMetric["direction"] }) {
  if (direction === "UP") return <TrendingUp className="h-3.5 w-3.5" />;
  if (direction === "DOWN") return <TrendingDown className="h-3.5 w-3.5" />;
  return <Minus className="h-3.5 w-3.5" />;
}

type ErrorState = { message: string; code?: string; retryable: boolean };

function errorFromResponse(status: number, body: { error?: string; code?: string }): ErrorState {
  const message = body.error ?? "Yönetim özeti üretilirken bir hata oluştu.";
  if (body.code === "AI_PLAN_REQUIRED") {
    return { message: "Bu özellik mevcut planınıza dahil değil. Devam etmek için planınızı yükseltin.", code: body.code, retryable: false };
  }
  if (body.code === "AI_QUOTA_EXCEEDED") {
    return { message: "Bu ayki AI kullanım kotanız doldu. Yeni dönemde veya plan yükseltmesiyle tekrar deneyebilirsiniz.", code: body.code, retryable: false };
  }
  if (body.code === "AI_PROVIDER_DISABLED") {
    return { message: "AI yönetim özeti bu organizasyon için henüz etkin değil.", code: body.code, retryable: false };
  }
  if (body.code === "AI_PROVIDER_UNAVAILABLE") {
    return { message: "AI sağlayıcısına şu anda ulaşılamıyor. Lütfen birazdan tekrar deneyin.", code: body.code, retryable: true };
  }
  return { message, code: body.code, retryable: status >= 500 };
}

export function ManagementSummaryPanel({ projectId }: { projectId?: string }) {
  const [status, setStatus] = useState<"idle" | "loading" | "success" | "error">("idle");
  const [result, setResult] = useState<ManagementSummary | null>(null);
  const [error, setError] = useState<ErrorState | null>(null);

  async function generate() {
    setStatus("loading");
    setError(null);
    try {
      const res = await fetch("/api/ai/management-summary", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(projectId ? { projectId } : {}),
      });
      const body = await res.json();
      if (!res.ok) {
        setError(errorFromResponse(res.status, body));
        setStatus("error");
        return;
      }
      setResult(body as ManagementSummary);
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
            <p className="text-sm font-semibold text-foreground">Haftalık yönetim özeti</p>
            <p className="mt-0.5 text-[12.5px] text-muted-foreground">
              Tamamlanmış son haftanın nakit, tahsilat, ödeme, bütçe ve kârlılık tablosunu bir önceki haftayla karşılaştırır.
              Tüm rakamlar YapıFin&apos;in kendi hesaplamalarıdır; AI yalnızca yorumlar ve önceliklendirir.
            </p>
          </div>
        </div>
        <Button onClick={generate} disabled={status === "loading"}>
          {status === "loading" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
          Özeti Üret
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

      {status === "success" && result && <SummaryCard summary={result} />}
    </div>
  );
}

function SummaryCard({ summary }: { summary: ManagementSummary }) {
  return (
    <div className="space-y-3">
      <div className="rounded-2xl border border-border bg-card p-5 shadow-soft">
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone="primary">
            <CalendarRange className="h-3 w-3" />
            {summary.periodLabel}
          </Badge>
          {summary.projectName && <Badge tone="neutral">{summary.projectName}</Badge>}
          {summary.actorScope === "PROJECT_MANAGER" && !summary.projectName && (
            <Badge tone="neutral">Atanmış projeleriniz</Badge>
          )}
          <span
            className={cn(
              "ml-auto inline-flex items-center gap-1 text-[11px] font-medium",
              summary.isAiGenerated ? "text-primary" : "text-muted-foreground",
            )}
            title={
              summary.isAiGenerated
                ? "Bu metin yapay zekâ tarafından üretildi; aşağıdaki rakamlar YapıFin'in kendi hesaplamalarıdır."
                : "AI yorumu şu anda üretilemedi; aşağıdaki metin YapıFin'in otomatik özetidir."
            }
          >
            <Lightbulb className="h-3 w-3" />
            {summary.isAiGenerated ? "AI yorumu" : "Otomatik özet"}
          </span>
        </div>

        <h3 className="mt-2.5 text-[15px] font-semibold text-foreground">{summary.headline}</h3>
        <p className="mt-1 text-[13px] leading-relaxed text-muted-foreground">{summary.overview}</p>
        <p className="mt-2 text-[11.5px] text-muted-foreground/70">Karşılaştırma dönemi: {summary.previousPeriodLabel}</p>
      </div>

      {summary.isEmptyPeriod && (
        <div className="grid place-items-center rounded-2xl border border-dashed border-border bg-card py-12 text-center">
          <CalendarRange className="h-8 w-8 text-muted-foreground/50" />
          <p className="mt-3 text-sm text-muted-foreground">Bu dönemde finansal hareket kaydedilmedi.</p>
          <p className="mt-1 text-[12.5px] text-muted-foreground">Karşılaştırma yapılabilecek bir değişim bulunmadığı için öne çıkan madde gösterilmiyor.</p>
        </div>
      )}

      {summary.topChanges.length > 0 && (
        <div className="rounded-2xl border border-border bg-card p-5 shadow-soft">
          <p className="text-sm font-semibold text-foreground">Öne çıkan değişimler</p>
          <div className="mt-3 space-y-3">
            {summary.topChanges.map((change) => {
              const tone = changeTone(change.metric);
              return (
                <div key={change.metric.key} className="border-t border-border pt-3 first:border-0 first:pt-0">
                  <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                    <span className="text-[13px] font-medium text-foreground">{change.metric.label}</span>
                    <span className="tnum text-[15px] font-semibold text-foreground">
                      {formatMetricValue(change.metric.value, change.metric.kind)}
                    </span>
                    {change.metric.change && change.metric.changeKind && (
                      <span
                        className={cn(
                          "tnum inline-flex items-center gap-1 text-[12px] font-medium",
                          tone === "success" && "text-success",
                          tone === "destructive" && "text-destructive",
                          tone === "muted" && "text-muted-foreground",
                        )}
                      >
                        <DirectionIcon direction={change.metric.direction} />
                        {formatSignedChange(change.metric.change, change.metric.changeKind)}
                      </span>
                    )}
                  </div>
                  <p className="mt-1 text-[13px] leading-relaxed text-muted-foreground">{change.comment}</p>
                  {change.metric.previousValue !== null && (
                    <p className="mt-1 text-[11.5px] text-muted-foreground/70">
                      Önceki dönem: {formatMetricValue(change.metric.previousValue, change.metric.kind)}
                    </p>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {summary.topRisks.length > 0 && (
        <div className="rounded-2xl border border-border bg-card p-5 shadow-soft">
          <div className="flex items-center justify-between gap-2">
            <p className="text-sm font-semibold text-foreground">Öne çıkan riskler</p>
            {summary.signalCount > summary.topRisks.length && (
              <span className="text-[11.5px] text-muted-foreground">
                En önemli {summary.topRisks.length} risk gösteriliyor (toplam {summary.signalCount} sinyal).
              </span>
            )}
          </div>
          <div className="mt-3 space-y-3">
            {summary.topRisks.map((risk) => (
              <RiskRow key={risk.signalId} risk={risk} />
            ))}
          </div>
        </div>
      )}

      {summary.recommendedActions.length > 0 && (
        <div className="rounded-2xl border border-border bg-card p-5 shadow-soft">
          <p className="flex items-center gap-1.5 text-sm font-semibold text-foreground">
            <ListChecks className="h-4 w-4 text-primary" />
            Önerilen takip aksiyonları
          </p>
          <ul className="mt-2.5 space-y-1.5">
            {summary.recommendedActions.map((action) => (
              <li key={action} className="flex gap-2 text-[13px] leading-relaxed text-muted-foreground">
                <span className="mt-[7px] h-1 w-1 shrink-0 rounded-full bg-primary" />
                {action}
              </li>
            ))}
          </ul>
        </div>
      )}

      <details className="rounded-2xl border border-border bg-card p-5 shadow-soft">
        <summary className="cursor-pointer text-sm font-semibold text-foreground">
          Özetin dayandığı veriler ({summary.metrics.length} ölçü)
        </summary>
        <div className="mt-3 grid gap-x-6 gap-y-2 sm:grid-cols-2">
          {summary.metrics.map((metric) => (
            <div key={metric.key} className="flex items-baseline justify-between gap-3 text-[12.5px]">
              <span className="text-muted-foreground">{metric.label}</span>
              <span className="tnum font-medium text-foreground">{formatMetricValue(metric.value, metric.kind)}</span>
            </div>
          ))}
        </div>
        {summary.dataCoverage.length > 0 && (
          <div className="mt-4 border-t border-border pt-3">
            <p className="flex items-center gap-1.5 text-[12px] font-medium text-muted-foreground">
              <Info className="h-3.5 w-3.5" />
              Kapsam notları
            </p>
            <ul className="mt-1.5 space-y-1">
              {summary.dataCoverage.map((gap) => (
                <li key={gap.section} className="text-[11.5px] text-muted-foreground/80">
                  <span className="font-medium">{gap.section}:</span> {gap.reason}
                </li>
              ))}
            </ul>
          </div>
        )}
      </details>
    </div>
  );
}

function RiskRow({ risk }: { risk: ManagementSummaryRisk }) {
  return (
    <div className="border-t border-border pt-3 first:border-0 first:pt-0">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={SEVERITY_TONE[risk.severity]}>{SEVERITY_LABELS[risk.severity]}</Badge>
        {risk.affectedProjectName && <Badge tone="neutral">{risk.affectedProjectName}</Badge>}
      </div>
      <p className="mt-1.5 text-[13px] leading-relaxed text-muted-foreground">{risk.comment}</p>
      {risk.evidence.period && (
        <p className="mt-1 text-[11.5px] text-muted-foreground/70">Veri dönemi: {risk.evidence.period}</p>
      )}
    </div>
  );
}
