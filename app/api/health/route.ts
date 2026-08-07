import { NextResponse } from "next/server";
import { checkDatabase } from "@/lib/health/db-check";

/** Prisma sürücüsü Edge runtime'da çalışmaz. */
export const runtime = "nodejs";
// Statik optimizasyon/derleme zamanı önbelleklemesini engeller — her çağrı
// gerçek (veya kısa TTL'li önbelleklenmiş) bir DB kontrolü çalıştırmalıdır.
export const dynamic = "force-dynamic";

/**
 * YF-511 — `GET /api/health`.
 *
 * Tek, kimlik doğrulamasız, tenant verisine dokunmayan bir uç nokta olarak
 * hem liveness (süreç ayakta ve istek işleyebiliyor) hem de readiness (DB'ye
 * erişilebiliyor) sinyalini birlikte verir. Depoda bir orkestrasyon katmanı
 * (Kubernetes vb. ayrı liveness/readiness prob'ları gerektiren) bulunmadığı
 * için tek endpoint yeterlidir (bkz. docs/operations/SECURITY_HEADERS.md).
 *
 * Yanıt gövdesi kasıtlı olarak minimaldir: ortam değişkeni, sürüm, hostname,
 * SQL hatası, stack trace veya tenant verisi asla içermez.
 */
export async function GET() {
  const healthy = await checkDatabase();

  return NextResponse.json(
    { status: healthy ? "ok" : "error" },
    {
      status: healthy ? 200 : 503,
      headers: {
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      },
    },
  );
}
