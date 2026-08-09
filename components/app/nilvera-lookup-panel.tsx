"use client";

import { useState } from "react";
import { Loader2, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  INTEGRATION_ERROR_CATEGORY_META,
  NORMALIZED_DOCUMENT_STATUS_META,
} from "@/components/app/integration-meta";

/**
 * YF-605-D-UI — Nilvera SANDBOX salt-okunur mükellef/belge durumu sorgu
 * paneli (görev talimatı "Supported operations ONLY: 1. Taxpayer lookup,
 * 2. E-document status lookup"). Nilvera'ya HİÇBİR doğrudan tarayıcı
 * çağrısı yapmaz — yalnızca `/api/integrations/connections/[id]/lookups/*`
 * ince uç noktalarını çağırır (bkz. o rotalardaki yorum).
 */

interface TaxpayerLookupResult {
  identifier: string;
  isEDocumentTaxpayer: boolean;
  supportedDocumentType: string | null;
}

interface DocumentStatusLookupResult {
  externalDocumentId: string;
  status: string;
  providerStatusCode: string | null;
  lastKnownProviderTimestamp: string | null;
}

type LookupOutcome<T> =
  | { kind: "success"; result: T }
  | { kind: "provider_error"; category: string; summary: string }
  | { kind: "request_error"; message: string };

async function postLookup<T>(url: string, body: Record<string, string>): Promise<LookupOutcome<T>> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    return { kind: "request_error", message: "Sunucuya ulaşılamadı, bağlantınızı kontrol edin." };
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return { kind: "request_error", message: "Sunucu yanıtı okunamadı." };
  }

  if (!response.ok) {
    const message =
      payload && typeof payload === "object" && "error" in payload && typeof (payload as { error?: unknown }).error === "string"
        ? (payload as { error: string }).error
        : "İstek başarısız oldu.";
    return { kind: "request_error", message };
  }

  const body_ = payload as { ok: boolean; result?: T; category?: string; summary?: string };
  if (body_.ok && body_.result) {
    return { kind: "success", result: body_.result };
  }
  return { kind: "provider_error", category: body_.category ?? "UNKNOWN", summary: body_.summary ?? "Sorgu başarısız oldu." };
}

function ProviderErrorAlert({ category, summary }: { category: string; summary: string }) {
  const meta = INTEGRATION_ERROR_CATEGORY_META[category] ?? { label: category, tone: "neutral" as const };
  return (
    <div className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">
      <span className="font-medium">{meta.label}.</span> {summary}
    </div>
  );
}

function RequestErrorAlert({ message }: { message: string }) {
  return <p role="alert" className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">{message}</p>;
}

function TaxpayerLookupForm({ connectionId, disabled }: { connectionId: string; disabled: boolean }) {
  const [identifier, setIdentifier] = useState("");
  const [pending, setPending] = useState(false);
  const [outcome, setOutcome] = useState<LookupOutcome<TaxpayerLookupResult> | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setPending(true);
    setOutcome(null);
    const result = await postLookup<TaxpayerLookupResult>(
      `/api/integrations/connections/${connectionId}/lookups/taxpayer`,
      { identifier },
    );
    setOutcome(result);
    setPending(false);
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-3">
      <div className="space-y-1.5">
        <Label htmlFor="taxpayer-identifier">Vergi/kimlik numarası (VKN/TCKN)</Label>
        <div className="flex gap-2">
          <Input
            id="taxpayer-identifier"
            name="identifier"
            inputMode="numeric"
            placeholder="Örn. 34918613960"
            value={identifier}
            onChange={(e) => setIdentifier(e.target.value)}
            disabled={disabled || pending}
            required
          />
          <Button type="submit" size="md" disabled={disabled || pending} className="shrink-0 gap-2">
            {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
            Sorgula
          </Button>
        </div>
      </div>

      {outcome?.kind === "request_error" && <RequestErrorAlert message={outcome.message} />}
      {outcome?.kind === "provider_error" && <ProviderErrorAlert category={outcome.category} summary={outcome.summary} />}
      {outcome?.kind === "success" && (
        <div className="rounded-lg border border-border bg-muted/40 px-3 py-2 text-sm">
          <div className="flex items-center gap-2">
            <Badge tone={outcome.result.isEDocumentTaxpayer ? "success" : "neutral"}>
              {outcome.result.isEDocumentTaxpayer ? "GİB e-belge mükellefi" : "GİB e-belge mükellefi değil"}
            </Badge>
          </div>
          {outcome.result.isEDocumentTaxpayer && (
            <p className="mt-1.5 text-muted-foreground">
              Desteklenen belge türü: {outcome.result.supportedDocumentType ?? "Bilinmiyor"}
            </p>
          )}
        </div>
      )}
    </form>
  );
}

function DocumentStatusLookupForm({ connectionId, disabled }: { connectionId: string; disabled: boolean }) {
  const [externalDocumentId, setExternalDocumentId] = useState("");
  const [pending, setPending] = useState(false);
  const [outcome, setOutcome] = useState<LookupOutcome<DocumentStatusLookupResult> | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setPending(true);
    setOutcome(null);
    const result = await postLookup<DocumentStatusLookupResult>(
      `/api/integrations/connections/${connectionId}/lookups/document-status`,
      { externalDocumentId },
    );
    setOutcome(result);
    setPending(false);
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-3">
      <div className="space-y-1.5">
        <Label htmlFor="document-external-id">Belge referans kimliği (ETTN/UUID)</Label>
        <div className="flex gap-2">
          <Input
            id="document-external-id"
            name="externalDocumentId"
            placeholder="Örn. 3c1a2f0e-...-9d4b"
            value={externalDocumentId}
            onChange={(e) => setExternalDocumentId(e.target.value)}
            disabled={disabled || pending}
            required
          />
          <Button type="submit" size="md" disabled={disabled || pending} className="shrink-0 gap-2">
            {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
            Sorgula
          </Button>
        </div>
      </div>

      {outcome?.kind === "request_error" && <RequestErrorAlert message={outcome.message} />}
      {outcome?.kind === "provider_error" && <ProviderErrorAlert category={outcome.category} summary={outcome.summary} />}
      {outcome?.kind === "success" && (
        <div className="rounded-lg border border-border bg-muted/40 px-3 py-2 text-sm">
          <div className="flex items-center gap-2">
            <Badge tone={(NORMALIZED_DOCUMENT_STATUS_META[outcome.result.status]?.tone as never) ?? "neutral"}>
              {NORMALIZED_DOCUMENT_STATUS_META[outcome.result.status]?.label ?? outcome.result.status}
            </Badge>
            {outcome.result.providerStatusCode && (
              <span className="text-xs text-muted-foreground">Sağlayıcı kodu: {outcome.result.providerStatusCode}</span>
            )}
          </div>
          <p className="mt-1.5 text-muted-foreground">
            Son bilinen sağlayıcı zaman damgası: {outcome.result.lastKnownProviderTimestamp ?? "Bilinmiyor"}
          </p>
        </div>
      )}
    </form>
  );
}

export function NilveraLookupPanel({
  connectionId,
  credentialConfigured,
}: {
  connectionId: string;
  credentialConfigured: boolean;
}) {
  return (
    <div className="space-y-5">
      {!credentialConfigured && (
        <p className="rounded-lg bg-warning/15 px-3 py-2 text-sm text-warning-foreground">
          Sorgu çalıştırmadan önce bu bağlantı için kimlik bilgisi tanımlanmalıdır.
        </p>
      )}
      <div>
        <h3 className="text-sm font-semibold text-foreground">Mükellef sorgulama</h3>
        <p className="mt-0.5 text-xs text-muted-foreground">
          VKN/TCKN&apos;nin GİB e-belge mükellefi olup olmadığını ve desteklenen belge türünü sorgular.
        </p>
        <div className="mt-2">
          <TaxpayerLookupForm connectionId={connectionId} disabled={!credentialConfigured} />
        </div>
      </div>

      <div>
        <h3 className="text-sm font-semibold text-foreground">E-belge durumu sorgulama</h3>
        <p className="mt-0.5 text-xs text-muted-foreground">
          Bir belgenin sandbox ortamındaki normalize edilmiş durumunu (PENDING/ACCEPTED/REJECTED/ERROR/UNKNOWN) sorgular.
        </p>
        <div className="mt-2">
          <DocumentStatusLookupForm connectionId={connectionId} disabled={!credentialConfigured} />
        </div>
      </div>
    </div>
  );
}
