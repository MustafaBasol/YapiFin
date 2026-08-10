import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import Stripe from "stripe";
import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { cleanDatabase } from "./helpers";
import { resetEnvCacheForTests } from "@/lib/env";
import { resetStripeConfigCacheForTests } from "@/lib/billing/stripe-config";
import { resetStripeGatewayForTests } from "@/lib/billing/stripe-gateway";

/**
 * YF-810 — `POST /api/billing/stripe/webhook` ROTA katmanı: ham gövde (raw
 * body) imza doğrulaması, eksik/geçersiz imza, eksik yapılandırma (fail-closed),
 * HTTP durum kodları. İş mantığı (`processStripeWebhookEvent`) zaten
 * `tests/billing-subscription-sync.test.ts`'te AYRI test edilmiştir — burada
 * yalnızca gerçek Stripe SDK'sının `webhooks.constructEvent`'i (saf yerel
 * kriptografi, AĞ ÇAĞRISI YAPMAZ) ile bu route'un doğru bağlandığı doğrulanır.
 *
 * Testler kasıtlı olarak yalnızca `UNHANDLED` olarak projekte edilen bir
 * Stripe olay türü ("price.updated") kullanır — böylece `resolveStripeGateway()`
 * GERÇEK (sahte formatlı ama gerçek) gateway'i döndürse dahi
 * `processStripeWebhookEvent` hiçbir Stripe ağ çağrısı (`retrieveSubscription`
 * vb.) TETİKLEMEZ; testler tamamen ÇEVRİMDIŞI çalışır.
 */

function fakeSecretKey(mode: "test" | "live"): string {
  return ["sk", mode, "0000000000000000000000FAKE"].join("_");
}
function fakeWebhookSecret(): string {
  return ["whsec", "0000000000000000000000000000FAKEWEBHOOK"].join("_");
}

const TEST_SECRET_KEY = fakeSecretKey("test");
const TEST_WEBHOOK_SECRET = fakeWebhookSecret();

function setStripeEnv(overrides: Record<string, string | undefined> = {}) {
  const values: Record<string, string | undefined> = {
    STRIPE_SECRET_KEY: TEST_SECRET_KEY,
    STRIPE_WEBHOOK_SECRET: TEST_WEBHOOK_SECRET,
    STRIPE_ENVIRONMENT: undefined,
    NEXT_PUBLIC_APP_URL: "https://app.example.com",
    ...overrides,
  };
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  resetEnvCacheForTests();
  resetStripeConfigCacheForTests();
}

let originalEnv: Record<string, string | undefined>;

const { POST } = await import("@/app/api/billing/stripe/webhook/route");

beforeAll(async () => {
  await cleanDatabase();
});

beforeEach(() => {
  originalEnv = { ...process.env };
  setStripeEnv();
});

afterEach(async () => {
  resetStripeGatewayForTests();
  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnv)) delete process.env[key];
  }
  Object.assign(process.env, originalEnv);
  resetEnvCacheForTests();
  resetStripeConfigCacheForTests();
  await cleanDatabase();
});

afterAll(async () => {
  await db.$disconnect();
});

/** Ele alınmayan (`UNHANDLED`'a projekte edilen), zararsız bir olay payload'ı — bkz. dosya başı not. */
function unhandledEventPayload(id = "evt_route_test_1"): string {
  return JSON.stringify({
    id,
    object: "event",
    type: "price.updated",
    created: Math.floor(Date.now() / 1000),
    livemode: false,
    data: { object: { id: "price_x", object: "price" } },
  });
}

function requestWith(opts: { body: string; signature?: string | null }): NextRequest {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (opts.signature !== null) headers["stripe-signature"] = opts.signature ?? "";
  return new NextRequest(new URL("http://localhost/api/billing/stripe/webhook"), {
    method: "POST",
    headers,
    body: opts.body,
  });
}

describe("YF-810 — POST /api/billing/stripe/webhook", () => {
  it("geçerli imza: 200 döner ve olayı işler (idempotency defterine yazar)", async () => {
    const payload = unhandledEventPayload("evt_valid_sig_1");
    const signature = Stripe.webhooks.generateTestHeaderString({ payload, secret: TEST_WEBHOOK_SECRET });

    const res = await POST(requestWith({ body: payload, signature }));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.received).toBe(true);

    const row = await db.stripeWebhookEvent.findUnique({ where: { stripeEventId: "evt_valid_sig_1" } });
    expect(row).not.toBeNull();
    expect(row!.status).toBe("IGNORED");
  });

  it("eksik stripe-signature başlığı: 400 döner, HİÇBİR işlem yapılmaz", async () => {
    const payload = unhandledEventPayload("evt_missing_sig_1");
    const res = await POST(requestWith({ body: payload, signature: null }));
    expect(res.status).toBe(400);

    const row = await db.stripeWebhookEvent.findUnique({ where: { stripeEventId: "evt_missing_sig_1" } });
    expect(row).toBeNull();
  });

  it("geçersiz (bozuk) imza: 400 döner, HİÇBİR işlem yapılmaz", async () => {
    const payload = unhandledEventPayload("evt_bad_sig_1");
    const res = await POST(requestWith({ body: payload, signature: "t=1,v1=deadbeef" }));
    expect(res.status).toBe(400);

    const row = await db.stripeWebhookEvent.findUnique({ where: { stripeEventId: "evt_bad_sig_1" } });
    expect(row).toBeNull();
  });

  it("YANLIŞ sırla üretilmiş imza: 400 döner (başka bir webhook uç noktasının imzası kabul EDİLMEZ)", async () => {
    const payload = unhandledEventPayload("evt_wrong_secret_1");
    const wrongSecretSignature = Stripe.webhooks.generateTestHeaderString({
      payload,
      secret: fakeWebhookSecret().replace("0", "1"),
    });

    const res = await POST(requestWith({ body: payload, signature: wrongSecretSignature }));
    expect(res.status).toBe(400);
  });

  it("ham gövde DEĞİŞTİRİLMİŞSE (imza artık eşleşmez): 400 döner", async () => {
    const originalPayload = unhandledEventPayload("evt_tampered_1");
    const signature = Stripe.webhooks.generateTestHeaderString({ payload: originalPayload, secret: TEST_WEBHOOK_SECRET });
    const tamperedPayload = originalPayload.replace("price.updated", "price.created");

    const res = await POST(requestWith({ body: tamperedPayload, signature }));
    expect(res.status).toBe(400);
  });

  it("STRIPE_WEBHOOK_SECRET yapılandırılmamışsa fail-closed 500 döner (sessizce başarılı DÖNMEZ)", async () => {
    setStripeEnv({ STRIPE_WEBHOOK_SECRET: undefined });
    const payload = unhandledEventPayload("evt_no_secret_1");

    const res = await POST(requestWith({ body: payload, signature: "t=1,v1=irrelevant" }));
    expect(res.status).toBe(500);

    const row = await db.stripeWebhookEvent.findUnique({ where: { stripeEventId: "evt_no_secret_1" } });
    expect(row).toBeNull();
  });

  it("aynı olay iki kez Stripe tarafından teslim edilirse (retry): ikinci teslimat da 200 döner ama mükerrer işlenmez", async () => {
    const payload = unhandledEventPayload("evt_route_retry_1");
    const signature = Stripe.webhooks.generateTestHeaderString({ payload, secret: TEST_WEBHOOK_SECRET });

    const first = await POST(requestWith({ body: payload, signature }));
    expect(first.status).toBe(200);
    const firstJson = await first.json();
    expect(firstJson.outcome).toBe("IGNORED");

    const second = await POST(requestWith({ body: payload, signature }));
    expect(second.status).toBe(200);
    const secondJson = await second.json();
    expect(secondJson.outcome).toBe("DUPLICATE");

    const rows = await db.stripeWebhookEvent.findMany({ where: { stripeEventId: "evt_route_retry_1" } });
    expect(rows).toHaveLength(1);
  });
});
