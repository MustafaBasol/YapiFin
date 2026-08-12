import { NextResponse, type NextRequest } from "next/server";
import { getPlatformAdminSessionUser } from "@/lib/auth/platform-session";
import { previewPlatformPlanChange } from "@/server/services/platform/platform-plan-override-service";
import { ServiceError } from "@/server/services/errors";

export const runtime = "nodejs";

const STATUS_BY_CODE: Record<ServiceError["code"], number> = {
  VALIDATION: 400,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
};

/**
 * YF-819 — GET /api/platform/organizations/[id]/plan-preview?planCode=...
 *
 * Platform Admin org detay ekranındaki plan seçicisi, bir hedef plan
 * seçildiğinde bu route'u çağırarak (mutasyon YAPMADAN) etkiyi önizler —
 * `app/api/plans/route.ts` (tenant tarafı plan karşılaştırma) İLE AYNI
 * "salt okunur GET + `ServiceError` kod eşlemesi" deseni, ama
 * `getSessionUser` YERİNE `getPlatformAdminSessionUser` (YF-818 tamamen
 * ayrı yetki sınırı — bkz. lib/auth/platform-guard.ts).
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const admin = await getPlatformAdminSessionUser();
  if (!admin) {
    return NextResponse.json({ error: "Oturum bulunamadı." }, { status: 401 });
  }

  const { id } = await params;
  const planCode = request.nextUrl.searchParams.get("planCode");
  if (!planCode) {
    return NextResponse.json({ error: "planCode zorunludur." }, { status: 400 });
  }

  try {
    const preview = await previewPlatformPlanChange(id, planCode);
    return NextResponse.json(preview);
  } catch (err) {
    if (err instanceof ServiceError) {
      return NextResponse.json({ error: err.message }, { status: STATUS_BY_CODE[err.code] });
    }
    console.error(
      "platform.plan.preview.unexpected_error",
      err instanceof Error ? { name: err.name, message: err.message } : err,
    );
    return NextResponse.json({ error: "Plan önizlemesi alınırken beklenmeyen bir hata oluştu." }, { status: 500 });
  }
}
