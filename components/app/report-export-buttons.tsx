"use client";

import { useState } from "react";
import { FileSpreadsheet, FileText, Loader2 } from "lucide-react";

/**
 * YF-405 — Excel/PDF dışa aktarma düğmeleri. Yalnızca zaten doğrulanmış,
 * geçerli filtre seçimlerini (`params`) sunucuya iletir — hiçbir zaman
 * rapor satırı/toplamı istemciden gönderilmez (bkz. server tarafı her
 * zaman DB'den yeniden türetir). Büyük ikili dosya istemci bileşeninde
 * üretilmez; yalnızca sunucudan gelen `Blob` indirilir.
 */
export function ReportExportButtons({
  endpoint,
  params,
}: {
  endpoint: string;
  params: Record<string, string | undefined | null>;
}) {
  const [pending, setPending] = useState<"xlsx" | "pdf" | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function handleExport(format: "xlsx" | "pdf") {
    if (pending) return;
    setPending(format);
    setError(null);
    try {
      const query = new URLSearchParams();
      query.set("format", format);
      for (const [key, value] of Object.entries(params)) {
        if (value) query.set(key, value);
      }
      const res = await fetch(`${endpoint}?${query.toString()}`);
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.error ?? "Dışa aktarma başarısız oldu.");
      }
      const blob = await res.blob();
      const disposition = res.headers.get("Content-Disposition") ?? "";
      const match = /filename="([^"]+)"/.exec(disposition);
      const filename = match?.[1] ?? `yapifin-rapor.${format}`;

      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Dışa aktarma başarısız oldu.");
    } finally {
      setPending(null);
    }
  }

  return (
    <div className="flex flex-col items-end gap-1.5">
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => handleExport("xlsx")}
          disabled={pending !== null}
          aria-label="Excel'e aktar"
          className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-border bg-card px-3 text-[13px] font-medium text-foreground shadow-sm transition-opacity hover:bg-muted disabled:cursor-not-allowed disabled:opacity-60"
        >
          {pending === "xlsx" ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileSpreadsheet className="h-4 w-4" />}
          Excel&apos;e Aktar
        </button>
        <button
          type="button"
          onClick={() => handleExport("pdf")}
          disabled={pending !== null}
          aria-label="PDF indir"
          className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-border bg-card px-3 text-[13px] font-medium text-foreground shadow-sm transition-opacity hover:bg-muted disabled:cursor-not-allowed disabled:opacity-60"
        >
          {pending === "pdf" ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileText className="h-4 w-4" />}
          PDF İndir
        </button>
      </div>
      {error && (
        <p role="alert" className="rounded-lg bg-destructive/10 px-3 py-1.5 text-[12px] text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
