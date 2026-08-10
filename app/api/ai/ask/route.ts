import { NextResponse, type NextRequest } from "next/server";
import { getSessionUser } from "@/lib/auth/session";
import { askYapiFin } from "@/server/services/ask-yapifin-service";
import { askYapiFinRequestSchema } from "@/lib/validation/ai";
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

export interface AskYapiFinErrorResponse {
  status: number;
  body: { error: string; code?: string };
}

/**
 * `POST`'tan ayrı, saf bir fonksiyon olarak dışa aktarılır ki her hata dalı
 * `getSessionUser`'ın gerektirdiği Next.js istek bağlamına ihtiyaç duymadan
 * doğrudan test edilebilsin (bkz. tests/ask-yapifin.test.ts, aynı desen
 * app/api/ai/insights/route.ts mapAiInsightsError için de kullanılır).
 */
export function mapAskYapiFinError(err: unknown): AskYapiFinErrorResponse {
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
  console.error("ai.ask.unexpected_error", err instanceof Error ? { name: err.name, message: err.message } : err);
  return { status: 500, body: { error: "Sorunuz yanıtlanırken beklenmeyen bir hata oluştu." } };
}

/**
 * YF-703 — "YapiFin'e Sor" yalnızca kullanıcı isteğiyle (POST) çalışır; bir
 * GET uç noktası KASITLI OLARAK eklenmedi — her çağrı bir AI kota
 * rezervasyonu tüketebilir (bkz. app/api/ai/insights/route.ts ile aynı gerekçe).
 */
export async function POST(request: NextRequest) {
  const user = await getSessionUser();
  if (!user) {
    return NextResponse.json({ error: "Oturum bulunamadı." }, { status: 401 });
  }

  const rawBody = await request.json().catch(() => null);
  const body = askYapiFinRequestSchema.safeParse(rawBody);
  if (!body.success) {
    return NextResponse.json({ error: body.error.issues[0]?.message ?? "Geçersiz istek gövdesi." }, { status: 400 });
  }

  const provider = createAiProviderFromConfig(resolveAiConfig(getEnv()));

  try {
    const result = await askYapiFin(user, body.data.question, { provider, idempotencyKey: body.data.idempotencyKey });
    return NextResponse.json(result);
  } catch (err) {
    const { status, body: errorBody } = mapAskYapiFinError(err);
    return NextResponse.json(errorBody, { status });
  }
}
