import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth/session";
import { getAiUsageSummary } from "@/server/services/ai-usage-service";
import { ServiceError } from "@/server/services/errors";

export const runtime = "nodejs";

const STATUS_BY_CODE: Record<ServiceError["code"], number> = {
  VALIDATION: 400,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
};

export async function GET() {
  const user = await getSessionUser();
  if (!user) {
    return NextResponse.json({ error: "Oturum bulunamadı." }, { status: 401 });
  }

  try {
    const summary = await getAiUsageSummary(user);
    return NextResponse.json(summary);
  } catch (err) {
    if (err instanceof ServiceError) {
      return NextResponse.json({ error: err.message }, { status: STATUS_BY_CODE[err.code] });
    }
    console.error("ai.usage.unexpected_error", err instanceof Error ? { name: err.name, message: err.message } : err);
    return NextResponse.json({ error: "AI kullanım özeti alınırken beklenmeyen bir hata oluştu." }, { status: 500 });
  }
}
