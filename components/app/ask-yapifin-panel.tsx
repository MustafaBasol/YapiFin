"use client";

import { useState } from "react";
import { Send, Loader2, AlertTriangle, RefreshCw, HelpCircle, Sparkles, Info } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import type { AskYapiFinResult } from "@/lib/ai/ask/schema";

const EXAMPLE_QUESTIONS = [
  "Bu ay toplam giderimiz ne kadar?",
  "En fazla bütçe aşımı hangi projede?",
  "Vadesi geçen alacaklarımız ne kadar?",
  "Nakit akışında risk var mı?",
];

type ErrorState = { message: string; code?: string; retryable: boolean };

function errorFromResponse(status: number, body: { error?: string; code?: string }): ErrorState {
  const message = body.error ?? "Sorunuz yanıtlanırken bir hata oluştu.";
  if (body.code === "AI_PLAN_REQUIRED") {
    return { message: "Bu özellik mevcut planınıza dahil değil. Devam etmek için planınızı yükseltin.", code: body.code, retryable: false };
  }
  if (body.code === "AI_QUOTA_EXCEEDED") {
    return { message: "Bu ayki AI kullanım kotanız doldu. Yeni dönemde veya plan yükseltmesiyle tekrar deneyebilirsiniz.", code: body.code, retryable: false };
  }
  if (body.code === "AI_PROVIDER_DISABLED") {
    return { message: "AI özelliği bu organizasyon için henüz etkin değil.", code: body.code, retryable: false };
  }
  if (body.code === "AI_PROVIDER_UNAVAILABLE") {
    return { message: "AI sağlayıcısına şu anda ulaşılamıyor. Lütfen birazdan tekrar deneyin.", code: body.code, retryable: true };
  }
  return { message, code: body.code, retryable: status >= 500 };
}

export function AskYapiFinPanel() {
  const [question, setQuestion] = useState("");
  const [status, setStatus] = useState<"idle" | "loading" | "success" | "error">("idle");
  const [result, setResult] = useState<AskYapiFinResult | null>(null);
  const [error, setError] = useState<ErrorState | null>(null);

  async function ask(q: string) {
    const trimmed = q.trim();
    if (!trimmed || status === "loading") return;
    setStatus("loading");
    setError(null);
    try {
      const res = await fetch("/api/ai/ask", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question: trimmed }),
      });
      const body = await res.json();
      if (!res.ok) {
        setError(errorFromResponse(res.status, body));
        setStatus("error");
        return;
      }
      setResult(body as AskYapiFinResult);
      setStatus("success");
    } catch {
      setError({ message: "Ağ bağlantısı hatası. Lütfen tekrar deneyin.", retryable: true });
      setStatus("error");
    }
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    void ask(question);
  }

  return (
    <div className="space-y-4">
      <form onSubmit={handleSubmit} className="rounded-2xl border border-border bg-card p-5 shadow-soft">
        <label htmlFor="ask-yapifin-question" className="text-sm font-semibold text-foreground">
          YapiFin&apos;e finansal bir soru sorun
        </label>
        <div className="mt-2.5 flex flex-wrap items-center gap-2">
          <input
            id="ask-yapifin-question"
            type="text"
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            placeholder="Örn. Bu ay toplam giderimiz ne kadar?"
            maxLength={400}
            className="h-10 min-w-0 flex-1 rounded-lg border border-border bg-background px-3 text-[13.5px] text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
          <Button type="submit" disabled={status === "loading" || question.trim().length < 3}>
            {status === "loading" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
            Sor
          </Button>
        </div>
        <div className="mt-3 flex flex-wrap gap-1.5">
          {EXAMPLE_QUESTIONS.map((q) => (
            <button
              key={q}
              type="button"
              onClick={() => {
                setQuestion(q);
                void ask(q);
              }}
              disabled={status === "loading"}
              className="rounded-full border border-border bg-muted/40 px-2.5 py-1 text-[11.5px] text-muted-foreground transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-60"
            >
              {q}
            </button>
          ))}
        </div>
      </form>

      {status === "error" && error && (
        <div className="flex items-start gap-3 rounded-2xl border border-destructive/20 bg-destructive/5 p-5">
          <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-destructive" />
          <div className="flex-1">
            <p className="text-sm font-medium text-destructive">{error.message}</p>
          </div>
          {error.retryable && (
            <Button variant="outline" onClick={() => ask(question)}>
              <RefreshCw className="h-3.5 w-3.5" />
              Tekrar dene
            </Button>
          )}
        </div>
      )}

      {status === "success" && result && result.status === "unsupported" && (
        <div className="flex items-start gap-3 rounded-2xl border border-border bg-card p-5 shadow-soft">
          <HelpCircle className="mt-0.5 h-5 w-5 shrink-0 text-muted-foreground" />
          <div>
            <p className="text-sm font-medium text-foreground">Bu soruyu şu anda yanıtlayamıyorum</p>
            <p className="mt-1 text-[13px] leading-relaxed text-muted-foreground">{result.reason}</p>
          </div>
        </div>
      )}

      {status === "success" && result && result.status === "answered" && <AnsweredResult result={result} />}
    </div>
  );
}

function AnsweredResult({ result }: { result: Extract<AskYapiFinResult, { status: "answered" }> }) {
  return (
    <div className="space-y-3">
      <div className="rounded-2xl border border-border bg-card p-5 shadow-soft">
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone="neutral">{result.periodLabel}</Badge>
          {result.projectName && <Badge tone="neutral">{result.projectName}</Badge>}
          <span
            className="ml-auto inline-flex items-center gap-1 text-[11px] font-medium text-primary"
            title={
              result.answer.isAiGenerated
                ? "Bu yanıt yapay zekâ tarafından üretildi; aşağıdaki veriler YapiFin'in kendi hesaplamalarıdır."
                : "AI yorumu şu anda üretilemedi; aşağıdaki metin YapiFin'in otomatik özetidir."
            }
          >
            <Sparkles className="h-3 w-3" />
            {result.answer.isAiGenerated ? "AI yanıtı" : "Otomatik özet"}
          </span>
        </div>
        <p className="mt-2.5 text-[14px] leading-relaxed text-foreground">{result.answer.text}</p>
      </div>

      {result.facts.length > 0 && (
        <div className="rounded-2xl border border-border bg-card p-5 shadow-soft">
          <div className="flex items-center gap-1.5 text-[12.5px] font-semibold text-muted-foreground">
            <Info className="h-3.5 w-3.5" />
            YapiFin verisi
          </div>
          <dl className="mt-3 grid gap-x-6 gap-y-2 sm:grid-cols-2">
            {result.facts.map((fact) => (
              <div key={fact.label} className="flex items-baseline justify-between gap-3 text-[13px]">
                <dt className="text-muted-foreground">{fact.label}</dt>
                <dd className="tnum font-medium text-foreground">{fact.value}</dd>
              </div>
            ))}
          </dl>
        </div>
      )}
    </div>
  );
}
