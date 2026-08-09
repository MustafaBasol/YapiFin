import { NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth/session";
import { lookupDocumentStatus } from "@/server/services/integrations/provider-lifecycle-service";
import { ServiceError } from "@/server/services/errors";
import { documentStatusLookupRequestSchema } from "@/lib/validation/integration";

export const runtime = "nodejs";

const STATUS_BY_CODE: Record<ServiceError["code"], number> = {
  VALIDATION: 400,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
};

/**
 * YF-605-D-UI — `POST /api/integrations/connections/[id]/lookups/document-status`.
 *
 * `lookupTaxpayer` rotasıyla AYNI desen (bkz. o dosyadaki yorum) —
 * provider-nötr, ince, kimlik doğrulamalı. Adaptör/servis katmanı
 * yalnızca `NILVERA` + `SANDBOX` bağlantılarında yeteneği bildirir; başka
 * bir sağlayıcı/ortam `VALIDATION` ile `{ ok:false }` döner (giden
 * gönderim/iptal kapasitesi bu uç nokta üzerinden HİÇBİR ZAMAN tetiklenmez).
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await getSessionUser();
  if (!user) {
    return NextResponse.json({ error: "Oturum bulunamadı." }, { status: 401 });
  }

  const { id } = await params;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Geçersiz istek gövdesi." }, { status: 400 });
  }

  const parsed = documentStatusLookupRequestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Form geçersiz" }, { status: 400 });
  }

  try {
    const result = await lookupDocumentStatus(user, {
      connectionId: id,
      externalDocumentId: parsed.data.externalDocumentId,
    });
    return NextResponse.json(result, { status: 200 });
  } catch (err) {
    if (err instanceof ServiceError) {
      return NextResponse.json({ error: err.message }, { status: STATUS_BY_CODE[err.code] });
    }
    console.error(
      "integrations.document_status_lookup.unexpected_error",
      err instanceof Error ? { name: err.name, message: err.message } : err,
    );
    return NextResponse.json({ error: "Belge durumu sorgusu sırasında beklenmeyen bir hata oluştu." }, { status: 500 });
  }
}
