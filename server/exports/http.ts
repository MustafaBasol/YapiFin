import { NextResponse } from "next/server";
import { ServiceError } from "@/server/services/errors";
import type { ExportFile } from "@/server/services/report-export-service";

/**
 * YF-405 — Route handler'ların ortak HTTP katmanı. `ServiceError.code`'u
 * HTTP durum koduna eşler; beklenmeyen hatalarda asla stack trace veya
 * iç hata mesajı istemciye sızdırılmaz (bkz. görev talimatları "Do not
 * expose stack traces in failed export responses").
 */
const STATUS_BY_CODE: Record<ServiceError["code"], number> = {
  VALIDATION: 400,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
};

export function errorToResponse(err: unknown): NextResponse {
  if (err instanceof ServiceError) {
    return NextResponse.json({ error: err.message }, { status: STATUS_BY_CODE[err.code] });
  }
  // Yalnızca hata mesajı/adı loglanır — finansal veri veya kullanıcı verisi
  // hiçbir zaman loglanmaz (bkz. görev talimatları "Do not log exported
  // financial data"); istemciye ise stack trace/iç mesaj asla sızdırılmaz.
  console.error("export.unexpected_error", err instanceof Error ? { name: err.name, message: err.message } : err);
  return NextResponse.json({ error: "Rapor dışa aktarılırken beklenmeyen bir hata oluştu." }, { status: 500 });
}

const CONTENT_TYPE_BY_EXT: Record<"xlsx" | "pdf", string> = {
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pdf: "application/pdf",
};

export function buildExportResponse(file: ExportFile): NextResponse {
  const ext = file.filename.endsWith(".pdf") ? "pdf" : "xlsx";
  return new NextResponse(new Uint8Array(file.buffer), {
    status: 200,
    headers: {
      "Content-Type": CONTENT_TYPE_BY_EXT[ext],
      "Content-Disposition": file.contentDisposition,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
