import { NextResponse, type NextRequest } from "next/server";
import { getStripeWebhookSecret } from "@/lib/billing/stripe-config";
import { resolveStripeGateway } from "@/lib/billing/stripe-gateway";
import { BillingConfigError, BillingProviderError } from "@/lib/billing/errors";
import { processStripeWebhookEvent } from "@/server/services/billing/webhook-service";

export const runtime = "nodejs";

/**
 * YF-810 — Stripe webhook uç noktası.
 *
 * ## Ham gövde (raw body) zorunluluğu
 *
 * Stripe imza doğrulaması (`stripe-signature` başlığı) ham, BAYT-BAYT
 * DEĞİŞTİRİLMEMİŞ istek gövdesi üzerinden hesaplanır. `request.text()`
 * kullanılır — `request.json()` ASLA ÖNCE çağrılmaz/ayrıştırılmaz (Next.js
 * App Router route handler'ları varsayılan olarak gövdeyi ÖNCEDEN
 * ayrıştırmaz, bu yüzden ekstra bir `bodyParser: false` yapılandırması
 * GEREKMEZ — eski Pages Router deseninden farklıdır).
 *
 * ## Fail-closed yapılandırma
 *
 * `STRIPE_WEBHOOK_SECRET` tanımlı değilse istek İŞLENMEZ (500) — sessizce
 * "başarılı" dönülmez (bu, Stripe panelinde/loglarında GÖRÜNÜR bir hata
 * bırakır, ki eksik yapılandırma FARK EDİLSİN).
 *
 * ## İmza doğrulama
 *
 * Eksik/geçersiz `stripe-signature` başlığı HER ZAMAN 400 ile reddedilir —
 * hiçbir işlem YAPILMAZ, hiçbir veritabanı yazımı OLUŞMAZ.
 *
 * ## Stripe yeniden deneme (retry) güvenliği
 *
 * `processStripeWebhookEvent` idempotenttir (bkz. o modülün dosya başı
 * notu) — bu route bir istisna fırlatıldığında 500 döner (Stripe'ın
 * otomatik yeniden denemesini TETİKLER, bu GÜVENLİDİR); işlem zaten
 * tamamlanmış bir olayın YENİDEN teslimatı ise `processStripeWebhookEvent`
 * `DUPLICATE` döner ve 200 ile yanıtlanır (yeniden deneme DURDURULUR).
 *
 * ## Loglama
 *
 * Hiçbir sır (webhook sırrı, Stripe gizli anahtarı) veya ham tam payload
 * ASLA loglanmaz — yalnızca olay türü/kimliği gibi sır İÇERMEYEN kısa
 * alanlar (bkz. `lib/billing/errors.ts` `redactBillingSecrets` ile AYNI
 * disiplin).
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const signatureHeader = request.headers.get("stripe-signature");
  if (!signatureHeader) {
    return NextResponse.json({ error: "stripe-signature başlığı eksik." }, { status: 400 });
  }

  let webhookSecret: string;
  try {
    webhookSecret = getStripeWebhookSecret();
  } catch (err) {
    if (err instanceof BillingConfigError) {
      console.error(JSON.stringify({ level: "error", event: "billing.webhook.config_missing" }));
      return NextResponse.json({ error: "Webhook uç noktası yapılandırılmamış." }, { status: 500 });
    }
    throw err;
  }

  const rawBody = await request.text();

  let gateway;
  try {
    gateway = resolveStripeGateway();
  } catch (err) {
    if (err instanceof BillingConfigError) {
      console.error(JSON.stringify({ level: "error", event: "billing.webhook.config_missing" }));
      return NextResponse.json({ error: "Ödeme sağlayıcısı yapılandırılmamış." }, { status: 500 });
    }
    throw err;
  }

  let event;
  try {
    event = gateway.constructWebhookEvent(rawBody, signatureHeader, webhookSecret);
  } catch (err) {
    if (err instanceof BillingProviderError) {
      console.error(
        JSON.stringify({ level: "error", event: "billing.webhook.signature_invalid", category: err.category }),
      );
      return NextResponse.json({ error: "Webhook imzası doğrulanamadı." }, { status: 400 });
    }
    throw err;
  }

  try {
    const result = await processStripeWebhookEvent(event);
    console.log(
      JSON.stringify({
        level: "info",
        event: "billing.webhook.processed",
        stripeEventId: event.id,
        eventType: event.type,
        outcome: result.outcome,
      }),
    );
    return NextResponse.json({ received: true, outcome: result.outcome }, { status: 200 });
  } catch {
    console.error(
      JSON.stringify({
        level: "error",
        event: "billing.webhook.processing_failed",
        stripeEventId: event.id,
        eventType: event.type,
      }),
    );
    // 500 — Stripe bu olayı GÜVENLE yeniden dener (bkz. dosya başı not).
    return NextResponse.json({ error: "Webhook işlenirken bir hata oluştu." }, { status: 500 });
  }
}
