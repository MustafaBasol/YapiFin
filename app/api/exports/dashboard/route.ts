import { NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth/session";
import { exportDashboard, requireExportFormat } from "@/server/services/report-export-service";
import { buildExportResponse, errorToResponse } from "@/server/exports/http";

/** `exceljs`/`pdfmake`/`Buffer` ve dosya sistemi tabanlı yazı tipi çözümlemesi Edge'de çalışmaz. */
export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const user = await getSessionUser();
  if (!user) {
    return NextResponse.json({ error: "Oturum bulunamadı." }, { status: 401 });
  }

  try {
    const format = requireExportFormat(request.nextUrl.searchParams.get("format") ?? undefined);
    const rawParams = Object.fromEntries(request.nextUrl.searchParams.entries());
    const file = await exportDashboard(user, format, rawParams);
    return buildExportResponse(file);
  } catch (err) {
    return errorToResponse(err);
  }
}
