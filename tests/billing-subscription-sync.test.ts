import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { cleanDatabase, createFakeStripeGateway, createOrgUser, createOwnerOrg, setOrganizationPlan } from "./helpers";
import { resetEnvCacheForTests } from "@/lib/env";
import { resetStripeConfigCacheForTests } from "@/lib/billing/stripe-config";
import { resetStripeGatewayForTests, setStripeGatewayForTests, type StripeSubscriptionRef, type StripeWebhookEventRef } from "@/lib/billing/stripe-gateway";
import { ensureOrganizationStripeCustomer } from "@/server/services/billing/stripe-customer-service";
import {
  processStripeWebhookEvent,
  reconcileOrganizationStripeSubscription,
} from "@/server/services/billing/webhook-service";
import { getEffectivePlan } from "@/lib/entitlements/entitlement-service";

/**
 * YF-810 — webhook olay işleme (idempotency, sıra-dışı koruma, tenant
 * izolasyonu, entitlement senkronizasyonu) ve mutabakat (reconciliation)
 * servis-katmanı testleri.
 *
 * İmza doğrulaması (`gateway.constructWebhookEvent`) ve HTTP route katmanı
 * `tests/billing-webhook-route.test.ts`'te AYRI test edilir — burada
 * `processStripeWebhookEvent`/`reconcileOrganizationStripeSubscription`
 * doğrudan çağrılır (imza doğrulaması ATLANIR, bu bilinçlidir: bu dosya
 * yalnızca İŞ MANTIĞINI test eder). Gerçek Stripe kimlik bilgisi/ağ çağrısı
 * GEREKMEZ — `setStripeGatewayForTests` ile deterministik bir sahte gateway
 * (bkz. tests/helpers.ts `createFakeStripeGateway` YF-810 genişletmesi) takılır.
 */

function fakeSecretKey(mode: "test" | "live"): string {
  return ["sk", mode, "0000000000000000000000FAKE"].join("_");
}

const TEST_SECRET_KEY = fakeSecretKey("test");

function setStripeEnv(overrides: Record<string, string | undefined> = {}) {
  const values: Record<string, string | undefined> = {
    STRIPE_SECRET_KEY: TEST_SECRET_KEY,
    STRIPE_ENVIRONMENT: undefined,
    NEXT_PUBLIC_APP_URL: "https://app.example.com",
    STRIPE_PRICE_STARTER_MONTHLY: "price_FAKEstarterM001",
    STRIPE_PRICE_STARTER_ANNUAL: "price_FAKEstarterA001",
    STRIPE_PRICE_PROFESSIONAL_MONTHLY: "price_FAKEprofessionalM001",
    STRIPE_PRICE_PROFESSIONAL_ANNUAL: "price_FAKEprofessionalA001",
    STRIPE_PRICE_BUSINESS_MONTHLY: "price_FAKEbusinessM001",
    STRIPE_PRICE_BUSINESS_ANNUAL: "price_FAKEbusinessA001",
    STRIPE_PRICE_ENTERPRISE: "CONTACT_SALES",
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
let eventSequence = 0;

beforeAll(async () => {
  await cleanDatabase();
});

beforeEach(() => {
  originalEnv = { ...process.env };
  setStripeEnv();
  eventSequence = 0;
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

function nextEventId(): string {
  eventSequence += 1;
  return `evt_test_${eventSequence}`;
}

const NOW_SECONDS = Math.floor(Date.now() / 1000);

function subscriptionRef(overrides: Partial<StripeSubscriptionRef> & { id: string; customerId: string }): StripeSubscriptionRef {
  return {
    status: "active",
    cancelAtPeriodEnd: false,
    priceId: "price_FAKEprofessionalM001",
    currentPeriodStart: NOW_SECONDS,
    currentPeriodEnd: NOW_SECONDS + 30 * 24 * 60 * 60,
    trialStart: null,
    trialEnd: null,
    canceledAt: null,
    endedAt: null,
    ...overrides,
  };
}

function subscriptionEvent(overrides: {
  type?: string;
  subscriptionId: string;
  customerId: string;
  createdAt?: number;
}): StripeWebhookEventRef {
  return {
    kind: "SUBSCRIPTION",
    id: nextEventId(),
    type: overrides.type ?? "customer.subscription.updated",
    createdAt: overrides.createdAt ?? NOW_SECONDS,
    subscriptionId: overrides.subscriptionId,
    customerId: overrides.customerId,
  };
}

function invoiceEvent(overrides: {
  type: "invoice.payment_succeeded" | "invoice.payment_failed";
  subscriptionId: string | null;
  customerId: string | null;
  invoiceId?: string;
  createdAt?: number;
}): StripeWebhookEventRef {
  return {
    kind: "INVOICE",
    id: nextEventId(),
    type: overrides.type,
    createdAt: overrides.createdAt ?? NOW_SECONDS,
    subscriptionId: overrides.subscriptionId,
    customerId: overrides.customerId,
    invoiceId: overrides.invoiceId ?? `in_test_${eventSequence}`,
    amountDue: 149900,
    currency: "try",
  };
}

async function setUpOrgWithCustomer() {
  const { owner, organizationId } = await createOwnerOrg();
  const fake = createFakeStripeGateway();
  setStripeGatewayForTests(fake.gateway);
  const customer = await ensureOrganizationStripeCustomer(owner);
  return { owner, organizationId, fake, stripeCustomerId: customer.stripeCustomerId };
}

describe("YF-810 — idempotency (mükerrer olay)", () => {
  it("aynı stripeEventId ikinci kez teslim edildiğinde ikinci kez işlenmez", async () => {
    const { organizationId, fake, stripeCustomerId } = await setUpOrgWithCustomer();
    // Kayıt anındaki varsayılan plan zaten PROFESSIONAL'dır (bkz.
    // lib/entitlements/plan-defaults.ts DEFAULT_ORGANIZATION_PLAN_CODE) —
    // audit log'un GERÇEK bir değişiklikte üretildiğini kanıtlamak için
    // FARKLI bir plana (STARTER) abone olunur.
    const sub = subscriptionRef({ id: "sub_dup_1", customerId: stripeCustomerId, priceId: "price_FAKEstarterM001" });
    fake.setSubscription(sub);

    const event = subscriptionEvent({ type: "customer.subscription.created", subscriptionId: sub.id, customerId: stripeCustomerId });

    const first = await processStripeWebhookEvent(event);
    expect(first.outcome).toBe("PROCESSED");
    const afterFirst = await db.organization.findUniqueOrThrow({ where: { id: organizationId } });

    // Stripe AYNI olayı yeniden teslim eder (retry/at-least-once) — AYNI event nesnesi TEKRAR işlenir.
    const second = await processStripeWebhookEvent(event);
    expect(second.outcome).toBe("DUPLICATE");

    const afterSecond = await db.organization.findUniqueOrThrow({ where: { id: organizationId } });
    expect(afterSecond.planId).toBe(afterFirst.planId);

    const auditCount = await db.auditLog.count({
      where: { organizationId, action: "billing.subscription.entitlement_granted" },
    });
    expect(auditCount).toBe(1); // İkinci teslimat İKİNCİ bir yan etki ÜRETMEDİ.

    const eventRows = await db.stripeWebhookEvent.findMany({ where: { stripeEventId: event.id } });
    expect(eventRows).toHaveLength(1); // Veritabanı düzeyinde tekillik.
  });

  it("bir önceki deneme FAILED ile sonuçlanmışsa yeniden teslimat GÜVENLE yeniden dener (webhook retry)", async () => {
    const { organizationId, fake, stripeCustomerId } = await setUpOrgWithCustomer();
    const sub = subscriptionRef({ id: "sub_retry_1", customerId: stripeCustomerId });
    fake.setSubscription(sub);
    const event = subscriptionEvent({ type: "customer.subscription.created", subscriptionId: sub.id, customerId: stripeCustomerId });

    // Bir önceki denemenin ÇÖKTÜĞÜNÜ simüle et (ör. süreç yazma sırasında sonlandı).
    await db.stripeWebhookEvent.create({
      data: {
        stripeEventId: event.id,
        environment: "TEST",
        eventType: event.type,
        organizationId,
        stripeCustomerId,
        stripeSubscriptionId: sub.id,
        stripeCreatedAt: new Date(event.createdAt * 1000),
        status: "FAILED",
        errorSummary: "Error",
        attempts: 1,
      },
    });

    const result = await processStripeWebhookEvent(event);
    expect(result.outcome).toBe("PROCESSED");

    const org = await db.organization.findUniqueOrThrow({ where: { id: organizationId } });
    const plan = await db.plan.findUniqueOrThrow({ where: { code: "PROFESSIONAL" } });
    expect(org.planId).toBe(plan.id);

    const row = await db.stripeWebhookEvent.findUniqueOrThrow({ where: { stripeEventId: event.id } });
    expect(row.status).toBe("PROCESSED");
    expect(row.attempts).toBe(2);
  });
});

describe("YF-810 — bilinmeyen Stripe müşterisi/aboneliği", () => {
  it("eşlemesi olmayan bir Stripe müşterisine ait olay güvenle YOK SAYILIR (hiçbir organizasyona yazılmaz)", async () => {
    setStripeGatewayForTests(createFakeStripeGateway().gateway);
    const event = subscriptionEvent({
      type: "customer.subscription.updated",
      subscriptionId: "sub_unknown_1",
      customerId: "cus_completely_unknown",
    });

    const result = await processStripeWebhookEvent(event);
    expect(result.outcome).toBe("IGNORED");

    const row = await db.stripeWebhookEvent.findUniqueOrThrow({ where: { stripeEventId: event.id } });
    expect(row.status).toBe("IGNORED");
    expect(row.organizationId).toBeNull();
  });
});

describe("YF-810 — tenant izolasyonu (çapraz-tenant koruma)", () => {
  it("Stripe'tan yeniden çekilen abonelik, beklenen müşteri kimliğiyle UYUŞMUYORSA hiçbir yazma yapılmaz", async () => {
    const orgA = await setUpOrgWithCustomer();
    // Aynı sahte gateway'i iki organizasyon için PAYLAŞ (gerçek senaryoda
    // ikinci bir organizasyonun Stripe müşterisi Stripe'ta AYRI bir kimliğe
    // sahip olur — burada kasıtlı olarak "yanlış" bir customerId'ye kayıtlı
    // bir abonelik simüle edilir).
    const otherOrg = await createOwnerOrg();

    // orgA'nın müşteri eşlemesi `orgA.stripeCustomerId`dir, ama Stripe'ta
    // GERÇEKTE dönen abonelik BAŞKA bir müşteriye (`otherOrg` senaryosunu
    // taklit eden rastgele bir ID) ait — bu, bir eşleme tutarsızlığı/olası
    // sızıntı sinyalidir.
    const sub = subscriptionRef({ id: "sub_mismatch_1", customerId: "cus_completely_different" });
    orgA.fake.setSubscription(sub);

    const event = subscriptionEvent({
      type: "customer.subscription.updated",
      subscriptionId: sub.id,
      customerId: orgA.stripeCustomerId, // Eşleme BUNUN üzerinden orgA'yı bulur.
    });

    const result = await processStripeWebhookEvent(event);
    expect(result.outcome).toBe("PROCESSED"); // Olay işlendi (fail-closed reddedilmedi) ama...

    const org = await db.organization.findUniqueOrThrow({ where: { id: orgA.organizationId } });
    // ...hiçbir plan grantlanmadı (organizasyonun planı DEĞİŞMEDİ) ve
    const initialPlan = await db.plan.findUniqueOrThrow({ where: { code: "PROFESSIONAL" } });
    expect(org.planId).toBe(initialPlan.id); // Kayıt anındaki varsayılan plan korunuyor — Stripe'tan gelen grant UYGULANMADI.

    const row = await db.organizationStripeSubscription.findUnique({ where: { organizationId: orgA.organizationId } });
    expect(row).toBeNull(); // Uyuşmazlık nedeniyle YEREL satır dahi YAZILMADI.

    void otherOrg;
  });
});

describe("YF-810 — abonelik yaşam döngüsü ve entitlement senkronizasyonu", () => {
  it("ACTIVE abonelik satın alınan planı grantlar", async () => {
    const { organizationId, fake, stripeCustomerId } = await setUpOrgWithCustomer();
    const sub = subscriptionRef({ id: "sub_active_1", customerId: stripeCustomerId, priceId: "price_FAKEstarterM001" });
    fake.setSubscription(sub);

    await processStripeWebhookEvent(
      subscriptionEvent({ type: "customer.subscription.created", subscriptionId: sub.id, customerId: stripeCustomerId }),
    );

    const org = await db.organization.findUniqueOrThrow({ where: { id: organizationId } });
    const starterPlan = await db.plan.findUniqueOrThrow({ where: { code: "STARTER" } });
    expect(org.planId).toBe(starterPlan.id);

    const row = await db.organizationStripeSubscription.findUniqueOrThrow({ where: { organizationId } });
    expect(row.status).toBe("ACTIVE");
    expect(row.planCode).toBe("STARTER");
    expect(row.lastGrantedPlanId).toBe(starterPlan.id);
  });

  it("TRIALING abonelik de plan grantlar (deneme erişimi tam erişimdir)", async () => {
    const { organizationId, fake, stripeCustomerId } = await setUpOrgWithCustomer();
    const sub = subscriptionRef({ id: "sub_trial_1", customerId: stripeCustomerId, status: "trialing", trialStart: NOW_SECONDS, trialEnd: NOW_SECONDS + 14 * 24 * 60 * 60 });
    fake.setSubscription(sub);

    await processStripeWebhookEvent(
      subscriptionEvent({ type: "customer.subscription.created", subscriptionId: sub.id, customerId: stripeCustomerId }),
    );

    const row = await db.organizationStripeSubscription.findUniqueOrThrow({ where: { organizationId } });
    expect(row.status).toBe("TRIALING");
    expect(row.lastGrantedPlanId).not.toBeNull();
  });

  it("PAST_DUE mevcut planı KORUR (nötr — grant/revoke tetiklemez)", async () => {
    const { organizationId, fake, stripeCustomerId } = await setUpOrgWithCustomer();
    const active = subscriptionRef({ id: "sub_pd_1", customerId: stripeCustomerId, priceId: "price_FAKEstarterM001" });
    fake.setSubscription(active);
    await processStripeWebhookEvent(
      subscriptionEvent({ type: "customer.subscription.created", subscriptionId: active.id, customerId: stripeCustomerId }),
    );
    const grantedPlanId = (await db.organization.findUniqueOrThrow({ where: { id: organizationId } })).planId;

    fake.setSubscription({ ...active, status: "past_due" });
    await processStripeWebhookEvent(
      subscriptionEvent({ type: "customer.subscription.updated", subscriptionId: active.id, customerId: stripeCustomerId }),
    );

    const org = await db.organization.findUniqueOrThrow({ where: { id: organizationId } });
    expect(org.planId).toBe(grantedPlanId); // Dokunulmadı.
    const row = await db.organizationStripeSubscription.findUniqueOrThrow({ where: { organizationId } });
    expect(row.status).toBe("PAST_DUE");
  });

  it("CANCEL_AT_PERIOD_END=true iken durum HÂLÂ active ise erişim KORUNUR", async () => {
    const { organizationId, fake, stripeCustomerId } = await setUpOrgWithCustomer();
    const sub = subscriptionRef({ id: "sub_cape_1", customerId: stripeCustomerId, cancelAtPeriodEnd: true });
    fake.setSubscription(sub);

    await processStripeWebhookEvent(
      subscriptionEvent({ type: "customer.subscription.updated", subscriptionId: sub.id, customerId: stripeCustomerId }),
    );

    const org = await db.organization.findUniqueOrThrow({ where: { id: organizationId } });
    expect(org.planId).not.toBeNull();
    const row = await db.organizationStripeSubscription.findUniqueOrThrow({ where: { organizationId } });
    expect(row.cancelAtPeriodEnd).toBe(true);
    expect(row.status).toBe("ACTIVE");
  });

  it.each(["canceled", "unpaid", "incomplete_expired", "paused"] as const)(
    "%s durumuna geçince, bu abonelik daha önce grantladıysa erişim GERİ ALINIR (veri SİLİNMEZ)",
    async (rawStatus) => {
      const { organizationId, fake, stripeCustomerId } = await setUpOrgWithCustomer();
      const active = subscriptionRef({ id: `sub_revoke_${rawStatus}`, customerId: stripeCustomerId });
      fake.setSubscription(active);
      await processStripeWebhookEvent(
        subscriptionEvent({ type: "customer.subscription.created", subscriptionId: active.id, customerId: stripeCustomerId }),
      );
      expect((await db.organization.findUniqueOrThrow({ where: { id: organizationId } })).planId).not.toBeNull();

      // Silinmeyeceğini kanıtlamak için organizasyona bir proje ekle.
      const project = await db.project.create({
        data: { organizationId, code: "PRJ-1", name: "Test Proje", status: "DRAFT" },
      });

      fake.setSubscription({ ...active, status: rawStatus, canceledAt: NOW_SECONDS, endedAt: NOW_SECONDS });
      await processStripeWebhookEvent(
        subscriptionEvent({ type: "customer.subscription.updated", subscriptionId: active.id, customerId: stripeCustomerId }),
      );

      const org = await db.organization.findUniqueOrThrow({ where: { id: organizationId } });
      expect(org.planId).toBeNull(); // Fail-closed "plansız" (NO_PLAN) — entitlement servisi hiçbir yetenek/kota vermez.

      const plan = await getEffectivePlan(db, organizationId);
      expect(plan.code).toBe("NONE");

      // Proje veri SİLİNMEDİ.
      const stillThere = await db.project.findUnique({ where: { id: project.id } });
      expect(stillThere).not.toBeNull();

      const auditLog = await db.auditLog.findFirst({
        where: { organizationId, action: "billing.subscription.entitlement_revoked" },
      });
      expect(auditLog).not.toBeNull();
    },
  );

  it("revoke GÜVENLİK koruması: plan bu abonelik DIŞINDA değiştirilmişse revoke ATLANIR", async () => {
    const { organizationId, fake, stripeCustomerId } = await setUpOrgWithCustomer();
    const active = subscriptionRef({ id: "sub_guard_1", customerId: stripeCustomerId });
    fake.setSubscription(active);
    await processStripeWebhookEvent(
      subscriptionEvent({ type: "customer.subscription.created", subscriptionId: active.id, customerId: stripeCustomerId }),
    );

    // Bir yönetici planı ELLE değiştirdi (webhook'un dışında).
    const businessPlan = await setOrganizationPlan(organizationId, "BUSINESS");

    fake.setSubscription({ ...active, status: "canceled" });
    await processStripeWebhookEvent(
      subscriptionEvent({ type: "customer.subscription.deleted", subscriptionId: active.id, customerId: stripeCustomerId }),
    );

    const org = await db.organization.findUniqueOrThrow({ where: { id: organizationId } });
    expect(org.planId).toBe(businessPlan.id); // EZİLMEDİ — elle atanan plan korunuyor.
  });

  it("fiyat kanonik kataloğa çözülemezse (ops sürüklenmesi) plan ASLA grantlanmaz", async () => {
    const { organizationId, fake, stripeCustomerId } = await setUpOrgWithCustomer();
    const sub = subscriptionRef({ id: "sub_unknown_price_1", customerId: stripeCustomerId, priceId: "price_UNTRACKED_manual" });
    fake.setSubscription(sub);

    await processStripeWebhookEvent(
      subscriptionEvent({ type: "customer.subscription.created", subscriptionId: sub.id, customerId: stripeCustomerId }),
    );

    const row = await db.organizationStripeSubscription.findUniqueOrThrow({ where: { organizationId } });
    expect(row.planCode).toBeNull();
    expect(row.reconciliationNote).not.toBeNull();
    expect(row.lastGrantedPlanId).toBeNull();
  });
});

describe("YF-810 — sıra-dışı (out-of-order) webhook koruması", () => {
  it("eski bir olay GEÇ işlense bile yerel durumu YENİ bir durumla ASLA EZMEZ (refetch-on-write)", async () => {
    const { organizationId, fake, stripeCustomerId } = await setUpOrgWithCustomer();
    const sub = subscriptionRef({ id: "sub_ooo_1", customerId: stripeCustomerId, status: "active" });
    fake.setSubscription(sub);

    // "Yeni" olay ÖNCE işlenir (ör. durum artık canceled).
    fake.setSubscription({ ...sub, status: "canceled" });
    const newerEvent = subscriptionEvent({
      type: "customer.subscription.updated",
      subscriptionId: sub.id,
      customerId: stripeCustomerId,
      createdAt: NOW_SECONDS + 100,
    });
    await processStripeWebhookEvent(newerEvent);

    // "Eski" olay SONRA (geç) teslim edilir — ama Stripe'tan yeniden çekilen
    // GÜNCEL durum HÂLÂ canceled'dır (fake gateway hâlâ canceled döner).
    const olderEvent = subscriptionEvent({
      type: "customer.subscription.updated",
      subscriptionId: sub.id,
      customerId: stripeCustomerId,
      createdAt: NOW_SECONDS - 100,
    });
    await processStripeWebhookEvent(olderEvent);

    const row = await db.organizationStripeSubscription.findUniqueOrThrow({ where: { organizationId } });
    expect(row.status).toBe("CANCELED"); // Eski olay YENİ durumu asla eskiye ÇEVİRMEDİ.
    // Gözlemlenebilirlik alanı monoton ileri kalır (eski olayın zaman damgasına GERİ GİTMEZ).
    expect(row.lastProcessedEventCreatedAt!.getTime()).toBe((NOW_SECONDS + 100) * 1000);
  });
});

describe("YF-810 — fatura ödeme durumu (platform faturalama, proje muhasebesinden AYRI)", () => {
  it("başarılı ödeme lastPaymentStatus=SUCCEEDED yazar ve HİÇBİR FinancialTransaction OLUŞTURMAZ", async () => {
    const { organizationId, fake, stripeCustomerId } = await setUpOrgWithCustomer();
    const sub = subscriptionRef({ id: "sub_inv_ok_1", customerId: stripeCustomerId });
    fake.setSubscription(sub);
    await processStripeWebhookEvent(
      subscriptionEvent({ type: "customer.subscription.created", subscriptionId: sub.id, customerId: stripeCustomerId }),
    );

    const result = await processStripeWebhookEvent(
      invoiceEvent({ type: "invoice.payment_succeeded", subscriptionId: sub.id, customerId: stripeCustomerId, invoiceId: "in_ok_1" }),
    );
    expect(result.outcome).toBe("PROCESSED");

    const row = await db.organizationStripeSubscription.findUniqueOrThrow({ where: { organizationId } });
    expect(row.lastPaymentStatus).toBe("SUCCEEDED");
    expect(row.lastInvoiceId).toBe("in_ok_1");

    const txCount = await db.financialTransaction.count({ where: { organizationId } });
    expect(txCount).toBe(0); // SaaS platform faturası proje muhasebesine ASLA SIZMADI.

    const auditLog = await db.auditLog.findFirst({ where: { organizationId, action: "billing.invoice.payment_succeeded" } });
    expect(auditLog).not.toBeNull();
  });

  it("başarısız ödeme lastPaymentStatus=FAILED yazar; abonelik past_due ise plan KORUNUR", async () => {
    const { organizationId, fake, stripeCustomerId } = await setUpOrgWithCustomer();
    const sub = subscriptionRef({ id: "sub_inv_fail_1", customerId: stripeCustomerId });
    fake.setSubscription(sub);
    await processStripeWebhookEvent(
      subscriptionEvent({ type: "customer.subscription.created", subscriptionId: sub.id, customerId: stripeCustomerId }),
    );
    const grantedPlanId = (await db.organization.findUniqueOrThrow({ where: { id: organizationId } })).planId;

    fake.setSubscription({ ...sub, status: "past_due" });
    await processStripeWebhookEvent(
      invoiceEvent({ type: "invoice.payment_failed", subscriptionId: sub.id, customerId: stripeCustomerId, invoiceId: "in_fail_1" }),
    );

    const row = await db.organizationStripeSubscription.findUniqueOrThrow({ where: { organizationId } });
    expect(row.lastPaymentStatus).toBe("FAILED");
    expect(row.status).toBe("PAST_DUE");

    const org = await db.organization.findUniqueOrThrow({ where: { id: organizationId } });
    expect(org.planId).toBe(grantedPlanId); // past_due nötrdür — grant KORUNDU.
  });

  it("aboneliğe bağlı olmayan fatura olayı YOK SAYILIR", async () => {
    const { fake, stripeCustomerId } = await setUpOrgWithCustomer();
    void fake;
    const result = await processStripeWebhookEvent(
      invoiceEvent({ type: "invoice.payment_succeeded", subscriptionId: null, customerId: stripeCustomerId }),
    );
    expect(result.outcome).toBe("IGNORED");
  });
});

describe("YF-810 — mutabakat (reconciliation)", () => {
  it("yerel satır hiç yoksa Stripe'taki abonelikleri listeleyip KEŞFEDER", async () => {
    const { owner, organizationId, fake, stripeCustomerId } = await setUpOrgWithCustomer();
    const sub = subscriptionRef({ id: "sub_reconcile_1", customerId: stripeCustomerId, priceId: "price_FAKEbusinessM001" });
    fake.setSubscription(sub);

    expect(await db.organizationStripeSubscription.findUnique({ where: { organizationId } })).toBeNull();

    const result = await reconcileOrganizationStripeSubscription(owner);
    expect(result.found).toBe(true);
    expect(result.planCode).toBe("BUSINESS");

    const org = await db.organization.findUniqueOrThrow({ where: { id: organizationId } });
    const businessPlan = await db.plan.findUniqueOrThrow({ where: { code: "BUSINESS" } });
    expect(org.planId).toBe(businessPlan.id);
  });

  it("art arda çağrılması İDEMPOTENTTİR (aynı sonucu üretir, mükerrer audit kaydı OLUŞTURMAZ)", async () => {
    const { owner, organizationId, fake, stripeCustomerId } = await setUpOrgWithCustomer();
    // Kayıt anındaki varsayılan plan zaten PROFESSIONAL'dır — audit log'un
    // GERÇEK bir değişiklikte üretildiğini kanıtlamak için FARKLI bir plana
    // (STARTER) abone olunur (bkz. yukarıdaki "sub_dup_1" testiyle AYNI gerekçe).
    const sub = subscriptionRef({ id: "sub_reconcile_2", customerId: stripeCustomerId, priceId: "price_FAKEstarterM001" });
    fake.setSubscription(sub);

    const first = await reconcileOrganizationStripeSubscription(owner);
    const second = await reconcileOrganizationStripeSubscription(owner);
    const third = await reconcileOrganizationStripeSubscription(owner);

    expect(first).toEqual(second);
    expect(second).toEqual(third);

    const auditCount = await db.auditLog.count({
      where: { organizationId, action: "billing.subscription.entitlement_granted" },
    });
    expect(auditCount).toBe(1); // Yalnızca GERÇEK bir değişiklik audit üretir — tekrar çağrılar üretmez.
  });

  it("organizasyonun Stripe müşterisi yoksa NOT_FOUND fırlatır", async () => {
    const { owner } = await createOwnerOrg();
    setStripeGatewayForTests(createFakeStripeGateway().gateway);
    await expect(reconcileOrganizationStripeSubscription(owner)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("yalnızca OWNER mutabakat başlatabilir", async () => {
    const { organizationId } = await setUpOrgWithCustomer();
    const admin = await createOrgUser(organizationId, "ADMIN");
    await expect(reconcileOrganizationStripeSubscription(admin)).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("müşterinin Stripe'ta HİÇ aboneliği yoksa nötr sonuç döner (hiçbir şey grantlanmaz)", async () => {
    const { owner } = await setUpOrgWithCustomer();
    const result = await reconcileOrganizationStripeSubscription(owner);
    expect(result.found).toBe(false);
  });
});
