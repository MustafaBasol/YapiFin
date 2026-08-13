"use client";

import { useMemo, useState } from "react";
import {
  AlertTriangle,
  CalendarClock,
  CalendarRange,
  Lightbulb,
  ListChecks,
  Loader2,
  RefreshCw,
  Sparkles,
  Target,
  TrendingDown,
  Wallet,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { StatCard } from "@/components/app/stat-card";
import { cn, formatDate, formatMoney } from "@/lib/utils";
import type { InsightSeverity } from "@/lib/ai/insights/schema";
import type {
  CashFlowScenarioResult,
  CashScenarioCellDto,
  CashScenarioDriverDto,
} from "@/lib/ai/cash-flow-scenario/schema";

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

const HORIZONS = [30, 60, 90] as const;
type Horizon = (typeof HORIZONS)[number];

const SCENARIO_ORDER = ["BASE", "RISK", "OPTIMISTIC"] as const;
type ScenarioKey = (typeof SCENARIO_ORDER)[number];

const SCENARIO_LABELS: Record<ScenarioKey, string> = {
  BASE: "Baz senaryo",
  RISK: "Risk senaryosu",
  OPTIMISTIC: "İyimser senaryo",
};

const SCENARIO_TONE: Record<ScenarioKey, BadgeTone> = {
  BASE: "primary",
  RISK: "destructive",
  OPTIMISTIC: "success",
};

const SCENARIO_HINTS: Record<ScenarioKey, string> = {
  BASE: "Tahsilat ve ödemeler vade tarihinde",
  RISK: "Tahsilatlar 30 gün gecikir",
  OPTIMISTIC: "Ödemeler 15 gün ötelenir",
};

/**
 * Kanıt değeri gösterimi — `formatPercent` BİLEREK kullanılmaz: o yardımcı
 * pozitif değerlere `+` öneki ekler ve yalnızca işaretli DEĞİŞİM içindir.
 * Bir seviye değeri ("karşılama oranı %62") `+%62` olarak gösterilemez.
 */
function formatEvidenceValue(value: string, kind: CashScenarioDriverDto["evidence"][number]["kind"]): string {
  switch (kind) {
    case "MONEY":
      return formatMoney(value);
    case "PERCENT":
      return `%${value.replace(".", ",")}`;
    case "PERCENTAGE_POINT":
      return `${value.replace(".", ",")} puan`;
    case "TEXT":
      return value;
  }
}

type ErrorState = { message: string; code?: string; retryable: boolean };

function errorFromResponse(status: number, body: { error?: string; code?: string }): ErrorState {
  const message = body.error ?? "Nakit akışı senaryosu üretilirken bir hata oluştu.";
  if (body.code === "AI_PLAN_REQUIRED") {
    return {
      message: "Bu özellik mevcut planınıza dahil değil. Devam etmek için planınızı yükseltin.",
      code: body.code,
      retryable: false,
    };
  }
  if (body.code === "AI_QUOTA_EXCEEDED") {
    return {
      message: "Bu ayki AI kullanım kotanız doldu. Yeni dönemde veya plan yükseltmesiyle tekrar deneyebilirsiniz.",
      code: body.code,
      retryable: false,
    };
  }
  if (body.code === "AI_PROVIDER_DISABLED") {
    return {
      message: "AI nakit akışı senaryosu bu organizasyon için henüz etkin değil.",
      code: body.code,
      retryable: false,
    };
  }
  if (body.code === "AI_PROVIDER_UNAVAILABLE") {
    return {
      message: "AI sağlayıcısına şu anda ulaşılamıyor. Lütfen birazdan tekrar deneyin.",
      code: body.code,
      retryable: true,
    };
  }
  return { message, code: body.code, retryable: status >= 500 };
}

function ScenarioColumn({ cell }: { cell: CashScenarioCellDto }) {
  const scenario = cell.scenario as ScenarioKey;
  const breakLabel = cell.alreadyNegativeAtOpening
    ? "Bugün (açılışta negatif)"
    : cell.breakDate
      ? formatDate(cell.breakDate)
      : "Kırılma yok";

  return (
    <div className="rounded-xl border border-border p-4">
      <div className="flex items-center justify-between gap-2">
        <Badge tone={SCENARIO_TONE[scenario]}>{SCENARIO_LABELS[scenario]}</Badge>
        {cell.willBreak && <Badge tone="destructive">Kırılma</Badge>}
      </div>
      <p className="mt-1.5 text-[11px] text-muted-foreground">{SCENARIO_HINTS[scenario]}</p>

      <p className="mt-3 tnum text-[22px] font-bold leading-none">
        {cell.endingCash !== null ? formatMoney(cell.endingCash) : "—"}
      </p>
      <p className="mt-1 text-[11px] text-muted-foreground">
        {cell.endingCash !== null ? "Tahmini kapanış nakdi" : "Nakit bakiyesi bu kapsamda gösterilmez"}
      </p>

      <dl className="mt-3 space-y-1.5 border-t border-border pt-3 text-[12px]">
        <div className="flex items-center justify-between gap-2">
          <dt className="text-muted-foreground">Beklenen tahsilat</dt>
          <dd className="tnum font-medium text-success">{formatMoney(cell.expectedCollections)}</dd>
        </div>
        <div className="flex items-center justify-between gap-2">
          <dt className="text-muted-foreground">Beklenen ödeme</dt>
          <dd className="tnum font-medium text-destructive">{formatMoney(cell.expectedPayments)}</dd>
        </div>
        <div className="flex items-center justify-between gap-2">
          <dt className="text-muted-foreground">Net değişim</dt>
          <dd className="tnum font-medium">{formatMoney(cell.netChange)}</dd>
        </div>
        {cell.minimumCashPoint && (
          <div className="flex items-center justify-between gap-2">
            <dt className="text-muted-foreground">En düşük nakit</dt>
            <dd className="tnum font-medium">{formatMoney(cell.minimumCashPoint.amount)}</dd>
          </div>
        )}
        {cell.endingCash !== null && (
          <div className="flex items-center justify-between gap-2">
            <dt className="text-muted-foreground">Kritik kırılma</dt>
            <dd className={cn("font-medium", cell.willBreak ? "text-destructive" : "text-muted-foreground")}>
              {breakLabel}
            </dd>
          </div>
        )}
      </dl>

      {cell.aiComment && (
        <p className="mt-3 border-t border-border pt-3 text-[12px] italic text-muted-foreground">{cell.aiComment}</p>
      )}
    </div>
  );
}

function DriverRow({ driver }: { driver: CashScenarioDriverDto }) {
  return (
    <div className="border-t border-border py-3 first:border-t-0 first:pt-0">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={SEVERITY_TONE[driver.severity]}>{SEVERITY_LABELS[driver.severity]}</Badge>
        <p className="text-[13px] font-medium text-foreground">{driver.title}</p>
        <Badge tone="neutral">
          {SCENARIO_LABELS[driver.scenario as ScenarioKey]} · {driver.horizonDays} gün
        </Badge>
      </div>
      <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1">
        {driver.evidence.map((item) => (
          <p key={`${driver.id}-${item.label}`} className="text-[12px] text-muted-foreground">
            {item.label}: <span className="tnum font-medium text-foreground">{formatEvidenceValue(item.value, item.kind)}</span>
          </p>
        ))}
      </div>
      {driver.aiComment && <p className="mt-1.5 text-[12px] italic text-muted-foreground">{driver.aiComment}</p>}
    </div>
  );
}

export function CashFlowScenarioPanel({ projectId }: { projectId?: string }) {
  const [status, setStatus] = useState<"idle" | "loading" | "success" | "error">("idle");
  const [result, setResult] = useState<CashFlowScenarioResult | null>(null);
  const [error, setError] = useState<ErrorState | null>(null);
  const [horizon, setHorizon] = useState<Horizon>(30);

  const visibleCells = useMemo(() => {
    if (!result) return [];
    return SCENARIO_ORDER.map((scenario) =>
      result.cells.find((c) => c.scenario === scenario && c.horizonDays === horizon),
    ).filter((c): c is CashScenarioCellDto => Boolean(c));
  }, [result, horizon]);

  const baseCell = visibleCells.find((c) => c.scenario === "BASE");
  const riskCell = visibleCells.find((c) => c.scenario === "RISK");

  const assumptions = useMemo(() => {
    const seen = new Map<string, string>();
    for (const cell of visibleCells) {
      for (const assumption of cell.assumptions) seen.set(assumption.id, assumption.label);
    }
    return [...seen.entries()];
  }, [visibleCells]);

  async function generate() {
    setStatus("loading");
    setError(null);
    try {
      const res = await fetch("/api/ai/cash-flow-scenarios", {
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
      setResult(body as CashFlowScenarioResult);
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
            <p className="text-sm font-semibold text-foreground">Nakit akışı senaryo projeksiyonu</p>
            <p className="mt-0.5 text-[12.5px] text-muted-foreground">
              Açık alacak ve borçlarınızın vade tarihlerinden 30/60/90 günlük nakit projeksiyonu üretir; baz, risk ve
              iyimser senaryoları karşılaştırır. Tüm rakamlar YapıFin&apos;in kendi hesaplamalarıdır; AI yalnızca yorumlar
              ve önceliklendirir.
            </p>
          </div>
        </div>
        <Button onClick={generate} disabled={status === "loading"}>
          {status === "loading" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
          Senaryoları Üret
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

      {status === "success" && result && (
        <div className="space-y-4">
          {result.isEmptyForecast ? (
            <div className="grid place-items-center rounded-2xl border border-dashed border-border bg-card py-12 text-center">
              <CalendarRange className="h-8 w-8 text-muted-foreground/50" />
              <p className="mt-3 text-sm text-muted-foreground">
                Vade tarihi girilmiş açık bir alacak veya borç kaydı bulunamadı.
              </p>
              <p className="mt-1 text-[12.5px] text-muted-foreground">
                Nakit projeksiyonu yalnızca vade tarihi girilmiş kayıtlardan üretilir; vade girildikçe senaryolar
                otomatik oluşur.
              </p>
            </div>
          ) : (
            <>
              <div className="flex h-9 flex-wrap items-center rounded-lg border border-border bg-card p-0.5">
                {HORIZONS.map((value) => (
                  <button
                    key={value}
                    type="button"
                    onClick={() => setHorizon(value)}
                    className={
                      value === horizon
                        ? "h-full rounded-md bg-primary px-3 text-[12.5px] font-semibold text-primary-foreground"
                        : "h-full rounded-md px-3 text-[12.5px] font-medium text-muted-foreground transition-colors hover:text-foreground"
                    }
                  >
                    {value} gün
                  </button>
                ))}
              </div>

              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                <StatCard
                  icon={Wallet}
                  label="Açılış Nakdi"
                  value={baseCell?.openingCash !== null && baseCell ? formatMoney(baseCell.openingCash!) : "—"}
                  hint={result.cashVisibility ? "Tüm aktif hesaplar" : "Bu kapsamda gösterilmez"}
                />
                <StatCard
                  icon={Target}
                  label="Tahmini Kapanış Bakiyesi"
                  value={baseCell?.endingCash ? formatMoney(baseCell.endingCash) : "—"}
                  hint="Baz senaryo"
                />
                <StatCard
                  icon={TrendingDown}
                  label="Minimum Nakit (Risk)"
                  value={riskCell?.minimumCashPoint ? formatMoney(riskCell.minimumCashPoint.amount) : "—"}
                  tone={riskCell?.willBreak ? "destructive" : "neutral"}
                  hint={`Risk senaryosunda en düşük nokta · ${horizon} gün`}
                />
                <StatCard
                  icon={CalendarClock}
                  label="Kritik Kırılma Tarihi"
                  value={
                    // Nakit görünürlüğü yoksa "Yok" YAZILAMAZ: kırılma
                    // olmadığı değil, bakiyenin BİLİNMEDİĞİ anlamına gelir.
                    // "Bilinmiyor" ile "sıfır/yok" bu ekranda hiçbir yerde
                    // karıştırılmaz.
                    !result.cashVisibility || !riskCell || riskCell.endingCash === null
                      ? "—"
                      : riskCell.alreadyNegativeAtOpening
                        ? "Bugün"
                        : riskCell.breakDate
                          ? formatDate(riskCell.breakDate)
                          : "Yok"
                  }
                  tone={riskCell?.willBreak ? "warning" : "neutral"}
                  hint={
                    result.cashVisibility
                      ? "Risk senaryosunda nakidin sıfırın altına indiği ilk gün"
                      : "Bu kapsamda nakit bakiyesi gösterilmez"
                  }
                />
              </div>

              <div className="rounded-2xl border border-border bg-card p-5 shadow-soft">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-sm font-semibold text-foreground">Senaryo Karşılaştırması</p>
                  <p className="text-[11px] text-muted-foreground">{baseCell?.windowLabel}</p>
                </div>
                <p className="mt-1 text-[12px] text-muted-foreground">
                  Senaryolar yalnızca <strong>zamanlama</strong> varsayımıdır; hiçbirinde yeni gelir veya gider
                  eklenmez. Baz senaryo bir orta değer değil, riskin üst ve iyimserin alt sınırıdır.
                </p>
                <div className="mt-4 grid gap-4 lg:grid-cols-3">
                  {visibleCells.map((cell) => (
                    <ScenarioColumn key={`${cell.scenario}-${cell.horizonDays}`} cell={cell} />
                  ))}
                </div>
              </div>

              <div className="rounded-2xl border border-border bg-card p-5 shadow-soft">
                <div className="flex items-center gap-2">
                  <Lightbulb
                    className={cn("h-4 w-4", result.isAiGenerated ? "text-primary" : "text-muted-foreground")}
                  />
                  <p className="text-sm font-semibold text-foreground">{result.headline}</p>
                  <span
                    className={cn(
                      "ml-auto inline-flex items-center gap-1 text-[11px] font-medium",
                      result.isAiGenerated ? "text-primary" : "text-muted-foreground",
                    )}
                    title={
                      result.isAiGenerated
                        ? "Bu metin yapay zekâ tarafından üretildi; yukarıdaki rakamlar YapıFin'in kendi hesaplamalarıdır."
                        : "AI yorumu şu anda üretilemedi; aşağıdaki metin YapıFin'in otomatik özetidir."
                    }
                  >
                    <Lightbulb className="h-3 w-3" />
                    {result.isAiGenerated ? "AI yorumu" : "Otomatik özet"}
                  </span>
                </div>
                <p className="mt-2 text-[13px] leading-relaxed text-muted-foreground">{result.overview}</p>
              </div>

              {result.drivers.length > 0 && (
                <div className="rounded-2xl border border-border bg-card p-5 shadow-soft">
                  <p className="text-sm font-semibold text-foreground">Öne çıkan risk faktörleri</p>
                  <p className="mt-0.5 text-[12px] text-muted-foreground">
                    Tümü deterministik hesaplamadır; AI yalnızca sıralamayı yorumlar.
                  </p>
                  <div className="mt-3">
                    {result.drivers.map((driver) => (
                      <DriverRow key={driver.id} driver={driver} />
                    ))}
                  </div>
                </div>
              )}

              {result.recommendedActions.length > 0 && (
                <div className="rounded-2xl border border-border bg-card p-5 shadow-soft">
                  <div className="flex items-center gap-2">
                    <ListChecks className="h-4 w-4 text-primary" />
                    <p className="text-sm font-semibold text-foreground">Önerilen aksiyonlar</p>
                    {/*
                      Aksiyon metinleri AI üretimiyse SERBEST metindir ve
                      deterministik yedekle görsel olarak aynıdır. Kaynağın
                      hangisi olduğu burada da açıkça işaretlenir — kullanıcı
                      bir öneriyi YapıFin hesabı sanmamalıdır.
                    */}
                    <span
                      className={cn(
                        "ml-auto inline-flex items-center gap-1 text-[11px] font-medium",
                        result.isAiGenerated ? "text-primary" : "text-muted-foreground",
                      )}
                      title={
                        result.isAiGenerated
                          ? "Bu öneriler yapay zekâ tarafından üretildi; yukarıdaki rakamlar YapıFin'in kendi hesaplamalarıdır."
                          : "AI önerisi üretilemedi; bu öneriler YapıFin'in deterministik kurallarından gelir."
                      }
                    >
                      <Lightbulb className="h-3 w-3" />
                      {result.isAiGenerated ? "AI önerisi" : "Otomatik öneri"}
                    </span>
                  </div>
                  <ul className="mt-2 space-y-1.5">
                    {result.recommendedActions.map((action, index) => (
                      <li key={`${index}-${action}`} className="text-[13px] text-muted-foreground">
                        • {action}
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              <details className="rounded-2xl border border-border bg-card p-5 shadow-soft">
                <summary className="cursor-pointer text-sm font-semibold text-foreground">
                  Senaryonun dayandığı varsayımlar ({assumptions.length})
                </summary>
                <ul className="mt-3 space-y-1.5">
                  {assumptions.map(([id, label]) => (
                    <li key={id} className="text-[12.5px] text-muted-foreground">
                      • {label}
                    </li>
                  ))}
                </ul>
                {result.dataCoverage.length > 0 && (
                  <div className="mt-4 border-t border-border pt-3">
                    <p className="text-[12.5px] font-medium text-foreground">Kapsam dışı kalanlar</p>
                    <ul className="mt-1.5 space-y-1.5">
                      {result.dataCoverage.map((gap) => (
                        <li key={gap.section} className="text-[12.5px] text-muted-foreground">
                          • <span className="font-medium text-foreground">{gap.section}:</span> {gap.reason}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </details>
            </>
          )}
        </div>
      )}
    </div>
  );
}
