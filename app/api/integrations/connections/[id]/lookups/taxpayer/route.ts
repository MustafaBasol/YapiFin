import { NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth/session";
import { lookupTaxpayer } from "@/server/services/integrations/provider-lifecycle-service";
import { ServiceError } from "@/server/services/errors";
import { taxpayerLookupRequestSchema } from "@/lib/validation/integration";

export const runtime = "nodejs";

const STATUS_BY_CODE: Record<ServiceError["code"], number> = {
  VALIDATION: 400,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
};

/**
 * YF-605-D-UI — `POST /api/integrations/connections/[id]/lookups/taxpayer`.
 *
 * İnce, kimlik doğrulamalı uç nokta: tüm yetki/tenant/yetenek/adaptör
 * mantığı `provider-lifecycle-service.ts`'deki `lookupTaxpayer` içindedir
 * (görev talimatı "Prefer thin authenticated routes calling existing
 * service methods" / "Do not duplicate Nilvera HTTP client logic in
 * UI/API routes"). Yanıt gövdesi zaten sağlayıcı-nötr ve sır içermez (bkz.
 * `TaxpayerLookupResult` / `classifyProviderError`).
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

  const parsed = taxpayerLookupRequestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Form geçersiz" }, { status: 400 });
  }

  try {
    const result = await lookupTaxpayer(user, { connectionId: id, identifier: parsed.data.identifier });
    return NextResponse.json(result, { status: 200 });
  } catch (err) {
    if (err instanceof ServiceError) {
      return NextResponse.json({ error: err.message }, { status: STATUS_BY_CODE[err.code] });
    }
    console.error(
      "integrations.taxpayer_lookup.unexpected_error",
      err instanceof Error ? { name: err.name, message: err.message } : err,
    );
    return NextResponse.json({ error: "Mükellef sorgusu sırasında beklenmeyen bir hata oluştu." }, { status: 500 });
  }
}
