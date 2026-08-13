import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { getSessionUser } from "@/lib/auth/session";
import { getManagementSummary } from "@/server/services/management-summary-service";
import { AiEntitlementError } from "@/server/services/ai-usage-reporting-service";
import { ServiceError } from "@/server/services/errors";
import { AiError } from "@/lib/ai";
import { resolveAiConfig } from "@/lib/ai/config";
import { createAiProviderFromConfig } from "@/lib/ai/providers/resolve";
import { getEnv } from "@/lib/env";

export const runtime = "nodejs";

const STATUS_BY_CODE: Record<ServiceError["code"], number> = {
  VALIDATION: 400,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
};

const requestBodySchema = z.object({
  idempotencyKey: z.string().min(1).max(200).optional(),
  /**
   * Proje düzeyi özet. Yetkisiz/başka organizasyona ait bir kimlik HATA
   * DEĞİLDİR — kanonik rapor sözleşmesi gereği filtre düşer ve özet aktörün
   * kendi kapsamında üretilir (bkz. dashboard-service.ts
   * `resolveActorReportScope`); istenen projenin verisi hiçbir durumda
   * sızmaz.
   */
  projectId: z.string().min(1).max(200).optional(),
});

export interface ManagementSummaryErrorResponse {
  status: number;
  body: { error: string; code?: string };
}

/**
 * Sunucu hatasını uç kullanıcıya gösterilecek HTTP durum/koda çevirir —
 * `POST`'tan ayrı, saf bir fonksiyon olarak dışa aktarılır ki her hata dalı
 * `getSessionUser`'ın gerektirdiği Next.js istek bağlamına ihtiyaç duymadan
 * doğrudan test edilebilsin (bkz. app/api/ai/insights/route.ts ile aynı
 * örüntü).
 */
export function mapManagementSummaryError(err: unknown): ManagementSummaryErrorResponse {
  if (err instanceof AiEntitlementError) {
    const status = err.code === "FORBIDDEN" ? 403 : 409;
    return { status, body: { error: err.message, code: err.reasonCode } };
  }
  if (err instanceof AiError) {
    if (err.category === "not_configured") {
      return { status: 503, body: { error: "AI özelliği bu organizasyon için yapılandırılmamış.", code: "AI_PROVIDER_DISABLED" } };
    }
    if (err.category === "quota_exceeded") {
      return { status: 409, body: { error: "AI kullanım kotanız doldu.", code: "AI_QUOTA_EXCEEDED" } };
    }
    // "timeout" | "provider_error" | "invalid_response" | "unauthorized_context" — geçici sağlayıcı sorunu, yeniden denenebilir.
    return {
      status: 503,
      body: { error: "AI sağlayıcısına şu anda ulaşılamıyor. Lütfen daha sonra tekrar deneyin.", code: "AI_PROVIDER_UNAVAILABLE" },
    };
  }
  if (err instanceof ServiceError) {
    return { status: STATUS_BY_CODE[err.code], body: { error: err.message } };
  }
  console.error(
    "ai.management_summary.unexpected_error",
    err instanceof Error ? { name: err.name, message: err.message } : err,
  );
  return { status: 500, body: { error: "Yönetim özeti üretilirken beklenmeyen bir hata oluştu." } };
}

/**
 * YF-704 — Özet yalnızca kullanıcı isteğiyle (POST) üretilir; bir GET uç
 * noktası KASITLI OLARAK eklenmedi — GET önbellek/prefetch/bot taraması
 * tarafından sessizce tetiklenebilir ve her tetiklenme bir AI kota
 * rezervasyonu tüketir (bkz. app/api/ai/insights/route.ts, aynı gerekçe).
 */
export async function POST(request: NextRequest) {
  const user = await getSessionUser();
  if (!user) {
    return NextResponse.json({ error: "Oturum bulunamadı." }, { status: 401 });
  }

  const rawBody = await request.json().catch(() => ({}));
  const body = requestBodySchema.safeParse(rawBody);
  if (!body.success) {
    return NextResponse.json({ error: "Geçersiz istek gövdesi." }, { status: 400 });
  }

  const provider = createAiProviderFromConfig(resolveAiConfig(getEnv()));

  try {
    const result = await getManagementSummary(user, {
      provider,
      idempotencyKey: body.data.idempotencyKey,
      projectId: body.data.projectId,
    });
    return NextResponse.json(result);
  } catch (err) {
    const { status, body: errorBody } = mapManagementSummaryError(err);
    return NextResponse.json(errorBody, { status });
  }
}
