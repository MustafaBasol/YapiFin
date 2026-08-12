import { timingSafeEqual } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { getBillingSweepSecret } from "@/lib/billing/notification-policy";
import { BillingConfigError } from "@/lib/billing/errors";
import { sweepBillingNotifications } from "@/server/services/billing/billing-notification-sweep-service";

export const runtime = "nodejs";

/**
 * YF-821 — dunning grace-expiry sweep uç noktası.
 *
 * ## Neden bu uç nokta var
 *
 * `server/services/billing/billing-notification-sweep-service.ts` dosya
 * başı notu — bu kod tabanında gömülü bir zamanlayıcı YOKTUR. Bu route,
 * HARİCİ bir zamanlayıcının (işletim sistemi cron'u, barındırma
 * platformunun kendi zamanlayıcısı, vb. — hangisi olduğu bu koda BAĞIMLI
 * DEĞİLDİR) periyodik (önerilen: saatlik) olarak ÇAĞIRMASI GEREKEN, tek,
 * ince bir tetikleyicidir. Uygulama içinde HİÇBİR `setInterval`/`node-cron`
 * BAŞLATILMAZ (Next.js'in serverless/çok-instance dağıtım modelinde
 * güvenilir DEĞİLDİR).
 *
 * ## Yetkilendirme
 *
 * Kullanıcı oturumu/rol tabanlı DEĞİLDİR (harici zamanlayıcının bir
 * kullanıcı oturumu YOKTUR) — `app/api/billing/stripe/webhook/route.ts` İLE
 * AYNI "paylaşımlı sır" deseni: `Authorization: Bearer <BILLING_SWEEP_SECRET>`
 * başlığı sabit-zamanlı (`timingSafeEqual`) karşılaştırılır (zamanlama
 * saldırısı yüzey alanı minimize edilir). `BILLING_SWEEP_SECRET`
 * tanımlı değilse istek İŞLENMEZ (500) — sessizce "başarılı" DÖNÜLMEZ (bkz.
 * `app/api/billing/stripe/webhook/route.ts` "fail-closed yapılandırma" İLE
 * AYNI ilke).
 *
 * ## Neden POST (GET DEĞİL)
 *
 * Bu uç nokta yan etkili (e-posta gönderimi TETİKLER) — `GET` isteklerinin
 * önbelleğe alınabilir/yan-etkisiz olması beklenir, bu yüzden `POST` kullanılır.
 */
function isAuthorized(request: NextRequest, expectedSecret: string): boolean {
  const header = request.headers.get("authorization");
  if (!header || !header.startsWith("Bearer ")) return false;
  const provided = header.slice("Bearer ".length).trim();

  const providedBuffer = Buffer.from(provided);
  const expectedBuffer = Buffer.from(expectedSecret);
  // `timingSafeEqual` eşit uzunlukta buffer BEKLER — uzunluk farkı zaten
  // yanlış sırrı ifade eder, sabit-zamanlı karşılaştırmaya bile GEREK YOKTUR
  // (uzunluk zaten dışarıdan gözlemlenebilir bir sinyal DEĞİLDİR, HTTP
  // başlığı boyutu her zaman görünürdür).
  if (providedBuffer.length !== expectedBuffer.length) return false;
  return timingSafeEqual(providedBuffer, expectedBuffer);
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  let secret: string;
  try {
    secret = getBillingSweepSecret();
  } catch (err) {
    if (err instanceof BillingConfigError) {
      console.error(JSON.stringify({ level: "error", event: "billing.notification_sweep.config_missing" }));
      return NextResponse.json({ error: "Sweep uç noktası yapılandırılmamış." }, { status: 500 });
    }
    throw err;
  }

  if (!isAuthorized(request, secret)) {
    console.error(JSON.stringify({ level: "error", event: "billing.notification_sweep.unauthorized" }));
    return NextResponse.json({ error: "Yetkisiz." }, { status: 401 });
  }

  try {
    const result = await sweepBillingNotifications(new Date());
    console.log(
      JSON.stringify({
        level: "info",
        event: "billing.notification_sweep.completed",
        ...result,
      }),
    );
    return NextResponse.json(result, { status: 200 });
  } catch (err) {
    console.error(
      JSON.stringify({
        level: "error",
        event: "billing.notification_sweep.failed",
        message: err instanceof Error ? err.message : "unknown",
      }),
    );
    return NextResponse.json({ error: "Sweep işlenirken bir hata oluştu." }, { status: 500 });
  }
}
