import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { getSessionUser } from "@/lib/auth/session";
import { getAiInsights } from "@/server/services/ai-insights-service";
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

const requestBodySchema = z.object({ idempotencyKey: z.string().min(1).max(200).optional() });

export interface AiInsightsErrorResponse {
  status: number;
  body: { error: string; code?: string };
}

/**
 * Sunucu hatasını uç kullanıcıya gösterilecek HTTP durum/koda çevirir —
 * `POST`'tan ayrı, saf bir fonksiyon olarak dışa aktarılır ki her hata dalı
 * `getSessionUser`'ın gerektirdiği Next.js istek bağlamına (cookies/headers)
 * ihtiyaç duymadan doğrudan test edilebilsin (bkz. tests/ai-insights.test.ts
 * "kullanıcıya gösterilen hata eşlemesi").
 */
export function mapAiInsightsError(err: unknown): AiInsightsErrorResponse {
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
  console.error("ai.insights.unexpected_error", err instanceof Error ? { name: err.name, message: err.message } : err);
  return { status: 500, body: { error: "İçgörüler üretilirken beklenmeyen bir hata oluştu." } };
}

/**
 * YF-702 — İçgörüler yalnızca kullanıcı isteğiyle (POST) üretilir; bir GET
 * uç noktası KASITLI OLARAK eklenmedi — GET önbellek/prefetch/bot taraması
 * tarafından sessizce tetiklenebilir ve her tetiklenme bir AI kota rezervasyonu
 * tüketir (bkz. lib/ai/credits.ts). Üretim bir yan etkidir (kota tüketimi),
 * bu yüzden yalnızca açık bir kullanıcı eylemiyle (ör. "İçgörüleri Üret"
 * düğmesi) tetiklenmelidir.
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
  const idempotencyKey = body.data.idempotencyKey;

  const provider = createAiProviderFromConfig(resolveAiConfig(getEnv()));

  try {
    const result = await getAiInsights(user, { provider, idempotencyKey });
    return NextResponse.json(result);
  } catch (err) {
    const { status, body: errorBody } = mapAiInsightsError(err);
    return NextResponse.json(errorBody, { status });
  }
}
