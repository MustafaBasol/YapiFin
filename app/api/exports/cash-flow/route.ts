import { NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth/session";
import { exportCashFlow, requireExportFormat } from "@/server/services/report-export-service";
import { buildExportResponse, errorToResponse } from "@/server/exports/http";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const user = await getSessionUser();
  if (!user) {
    return NextResponse.json({ error: "Oturum bulunamadı." }, { status: 401 });
  }

  try {
    const format = requireExportFormat(request.nextUrl.searchParams.get("format") ?? undefined);
    const rawParams = Object.fromEntries(request.nextUrl.searchParams.entries());
    const file = await exportCashFlow(user, format, rawParams);
    return buildExportResponse(file);
  } catch (err) {
    return errorToResponse(err);
  }
}
