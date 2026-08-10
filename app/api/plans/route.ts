import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth/session";
import { getPlanComparison } from "@/server/services/plan-comparison-service";
import { ServiceError } from "@/server/services/errors";

export const runtime = "nodejs";

const STATUS_BY_CODE: Record<ServiceError["code"], number> = {
  VALIDATION: 400,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
};

/**
 * YF-805 — GET /api/plans
 *
 * Kanonik dört planın (Starter/Professional/Business/Enterprise) karşılaştırma
 * verisi + çağıranın organizasyonunun güncel planı/kullanımı. Yalnızca
 * oturumdaki kullanıcının KENDİ `organizationId`'sini kullanır (istemciden
 * organizationId asla kabul edilmez) — bkz.
 * server/services/plan-comparison-service.ts getPlanComparison.
 */
export async function GET() {
  const user = await getSessionUser();
  if (!user) {
    return NextResponse.json({ error: "Oturum bulunamadı." }, { status: 401 });
  }

  try {
    const result = await getPlanComparison(user);
    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof ServiceError) {
      return NextResponse.json({ error: err.message }, { status: STATUS_BY_CODE[err.code] });
    }
    console.error("plans.compare.unexpected_error", err instanceof Error ? { name: err.name, message: err.message } : err);
    return NextResponse.json({ error: "Plan karşılaştırma verisi alınırken beklenmeyen bir hata oluştu." }, { status: 500 });
  }
}
