import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { cleanDatabase, createFakeStripeGateway, createOwnerOrg } from "./helpers";
import { resetEnvCacheForTests } from "@/lib/env";
import { resetStripeConfigCacheForTests } from "@/lib/billing/stripe-config";
import {
  resetStripeGatewayForTests,
  setStripeGatewayForTests,
  type StripeDisputeRef,
  type StripeWebhookEventRef,
} from "@/lib/billing/stripe-gateway";
import { ensureOrganizationStripeCustomer } from "@/server/services/billing/stripe-customer-service";
import { processStripeWebhookEvent } from "@/server/services/billing/webhook-service";
import { reconcileDispute, reconcileOpenOrganizationDisputes } from "@/server/services/billing/dispute-service";
import { checkLimit } from "@/lib/entitlements/entitlement-service";
import { hasActiveDisputeRestriction } from "@/lib/billing/dispute-policy";
import { assertNotBillingRestricted } from "@/lib/billing/billing-restriction-policy";
import { createProject } from "@/server/services/project-service";
import { ServiceError } from "@/server/services/errors";
import type { SessionUser } from "@/lib/auth/session";

/**
 * YF-815 — Stripe uyuşmazlık (dispute/chargeback) webhook işleme + risk
 * politikası + merkezi entitlement kısıtlama servis-katmanı testleri.
 * `tests/billing-subscription-sync.test.ts` (YF-810) ile AYNI kalıp: imza
 * doğrulaması ATLANIR, gerçek Stripe kimlik bilgisi/ağ çağrısı GEREKMEZ.
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
  return `evt_dispute_test_${eventSequence}`;
}

const NOW_SECONDS = Math.floor(Date.now() / 1000);

function disputeEvent(overrides: { type?: string; disputeId: string; createdAt?: number }): StripeWebhookEventRef {
  return {
    kind: "DISPUTE",
    id: nextEventId(),
    type: overrides.type ?? "charge.dispute.created",
    createdAt: overrides.createdAt ?? NOW_SECONDS,
    disputeId: overrides.disputeId,
  };
}

async function setUpOrgWithCustomer() {
  const { owner, organizationId } = await createOwnerOrg();
  const fake = createFakeStripeGateway();
  setStripeGatewayForTests(fake.gateway);
  const customer = await ensureOrganizationStripeCustomer(owner);
  return { owner, organizationId, fake, stripeCustomerId: customer.stripeCustomerId };
}

function disputeRef(overrides: Partial<StripeDisputeRef> & { id: string; customerId: string | null }): StripeDisputeRef {
  return {
    status: "needs_response",
    amount: 5000,
    currency: "try",
    chargeId: `ch_${overrides.id}`,
    paymentIntentId: null,
    reason: "fraudulent",
    createdAt: NOW_SECONDS,
    ...overrides,
  };
}

describe("YF-815 — uyuşmazlık yaşam döngüsü ve risk durumu", () => {
  it("dispute created (needs_response) → FLAGGED, tenant verisi/erişimi HENÜZ ETKİLENMEZ", async () => {
    const { organizationId, fake, stripeCustomerId } = await setUpOrgWithCustomer();
    const dispute = disputeRef({ id: "dp_created", customerId: stripeCustomerId });
    fake.setDispute(dispute);

    const event = disputeEvent({ disputeId: dispute.id });
    const result = await processStripeWebhookEvent(event);
    expect(result.outcome).toBe("PROCESSED");

    const row = await db.stripeDispute.findUniqueOrThrow({
      where: { environment_stripeDisputeId: { environment: "TEST", stripeDisputeId: dispute.id } },
    });
    expect(row.status).toBe("NEEDS_RESPONSE");
    expect(row.riskState).toBe("FLAGGED");
    expect(row.organizationId).toBe(organizationId);

    // FLAGGED HENÜZ engelleyici değildir — yeni ücretli kullanım (proje
    // oluşturma vb.) HÂLÂ mümkündür.
    await expect(assertNotBillingRestricted(db, organizationId)).resolves.toBeUndefined();

    const auditCount = await db.auditLog.count({ where: { organizationId, action: "billing.dispute.opened" } });
    expect(auditCount).toBe(1);
  });

  it("dispute updated (under_review) → durum güncellenir, riskState HÂLÂ FLAGGED", async () => {
    const { fake, stripeCustomerId, organizationId } = await setUpOrgWithCustomer();
    const dispute = disputeRef({ id: "dp_updated", customerId: stripeCustomerId, status: "needs_response" });
    fake.setDispute(dispute);
    await processStripeWebhookEvent(disputeEvent({ type: "charge.dispute.created", disputeId: dispute.id }));

    fake.setDispute({ ...dispute, status: "under_review" });
    await processStripeWebhookEvent(disputeEvent({ type: "charge.dispute.updated", disputeId: dispute.id }));

    const row = await db.stripeDispute.findUniqueOrThrow({
      where: { environment_stripeDisputeId: { environment: "TEST", stripeDisputeId: dispute.id } },
    });
    expect(row.status).toBe("UNDER_REVIEW");
    expect(row.riskState).toBe("FLAGGED");

    const auditCount = await db.auditLog.count({
      where: { organizationId, action: { in: ["billing.dispute.opened", "billing.dispute.status_changed"] } },
    });
    expect(auditCount).toBe(2); // opened + status_changed — mükerrer DEĞİL.
  });

  it("dispute lost → RESTRICTED, merkezi faturalama kısıtlama gate'i YENİ ücretli kullanımı ENGELLER (tenant verisi SİLİNMEZ)", async () => {
    const { organizationId, owner, fake, stripeCustomerId } = await setUpOrgWithCustomer();

    // Kısıtlama ÖNCESİ mevcut bir proje oluşturulur — dispute SONRASI hâlâ OKUNABİLİR olduğunu kanıtlamak için.
    const existingProject = await db.project.create({
      data: { organizationId, code: "PRJ-DISPUTE-TEST", name: "Mevcut Proje" },
    });

    const dispute = disputeRef({ id: "dp_lost", customerId: stripeCustomerId, status: "needs_response" });
    fake.setDispute(dispute);
    await processStripeWebhookEvent(disputeEvent({ type: "charge.dispute.created", disputeId: dispute.id }));

    fake.setDispute({ ...dispute, status: "lost" });
    await processStripeWebhookEvent(disputeEvent({ type: "charge.dispute.closed", disputeId: dispute.id }));

    const row = await db.stripeDispute.findUniqueOrThrow({
      where: { environment_stripeDisputeId: { environment: "TEST", stripeDisputeId: dispute.id } },
    });
    expect(row.status).toBe("LOST");
    expect(row.riskState).toBe("RESTRICTED");

    // Merkezi faturalama kısıtlama gate'i (bkz. lib/billing/dispute-policy.ts,
    // kompozisyon için lib/billing/billing-restriction-policy.ts):
    expect(await hasActiveDisputeRestriction(db, organizationId)).toBe(true);
    await expect(assertNotBillingRestricted(db, organizationId)).rejects.toBeInstanceOf(ServiceError);

    // Gerçek bir çağrı noktasında (server/services/project-service.ts
    // `createProject`) DA ENGELLENİR — plan bunu aksi halde İZİN VERİYOR olsa DAHİ.
    await expect(
      createProject(owner as SessionUser, { code: "PRJ-BLOCKED", name: "Engellenmeli" } as never),
    ).rejects.toBeInstanceOf(ServiceError);

    // Salt-okunur yol (`checkLimit`) ETKİLENMEZ — "preserve read access".
    const limitCheck = await checkLimit(db, organizationId, "projects.active");
    expect(limitCheck.canAddOne).toBe(true); // Kısıtlama gate'i yalnızca ASSERT (engelleme) yolundadır.

    // Tenant verisi SİLİNMEZ — organizasyon ve mevcut kayıtlar erişilebilir kalır.
    const org = await db.organization.findUniqueOrThrow({ where: { id: organizationId } });
    expect(org.id).toBe(organizationId);
    const project = await db.project.findUnique({ where: { id: existingProject.id } });
    expect(project).not.toBeNull();
  });

  it("dispute won → CLEARED, kısıtlama (varsa) KALDIRILIR", async () => {
    const { organizationId, fake, stripeCustomerId } = await setUpOrgWithCustomer();
    const dispute = disputeRef({ id: "dp_won", customerId: stripeCustomerId, status: "needs_response" });
    fake.setDispute(dispute);
    await processStripeWebhookEvent(disputeEvent({ type: "charge.dispute.created", disputeId: dispute.id }));

    fake.setDispute({ ...dispute, status: "lost" });
    await processStripeWebhookEvent(disputeEvent({ type: "charge.dispute.updated", disputeId: dispute.id }));
    expect(await hasActiveDisputeRestriction(db, organizationId)).toBe(true);

    // Stripe'ta düzeltme/itiraz sonucu "won" a döner (nadir ama olası).
    fake.setDispute({ ...dispute, status: "won" });
    await processStripeWebhookEvent(disputeEvent({ type: "charge.dispute.updated", disputeId: dispute.id }));

    const row = await db.stripeDispute.findUniqueOrThrow({
      where: { environment_stripeDisputeId: { environment: "TEST", stripeDisputeId: dispute.id } },
    });
    expect(row.riskState).toBe("CLEARED");
    expect(await hasActiveDisputeRestriction(db, organizationId)).toBe(false);
  });

  it("dispute closed (warning_closed) → CLEARED", async () => {
    const { fake, stripeCustomerId } = await setUpOrgWithCustomer();
    const dispute = disputeRef({ id: "dp_warning_closed", customerId: stripeCustomerId, status: "warning_closed" });
    fake.setDispute(dispute);
    await processStripeWebhookEvent(disputeEvent({ type: "charge.dispute.closed", disputeId: dispute.id }));

    const row = await db.stripeDispute.findUniqueOrThrow({
      where: { environment_stripeDisputeId: { environment: "TEST", stripeDisputeId: dispute.id } },
    });
    expect(row.riskState).toBe("CLEARED");
  });

  it("mükerrer uyuşmazlık olayı: ikinci teslimat İKİNCİ bir audit kaydı ÜRETMEZ", async () => {
    const { organizationId, fake, stripeCustomerId } = await setUpOrgWithCustomer();
    const dispute = disputeRef({ id: "dp_dup", customerId: stripeCustomerId });
    fake.setDispute(dispute);

    const event = disputeEvent({ disputeId: dispute.id });
    const first = await processStripeWebhookEvent(event);
    expect(first.outcome).toBe("PROCESSED");
    const second = await processStripeWebhookEvent(event); // AYNI stripeEventId.
    expect(second.outcome).toBe("DUPLICATE");

    const auditCount = await db.auditLog.count({ where: { organizationId, action: "billing.dispute.opened" } });
    expect(auditCount).toBe(1);
  });
});

describe("YF-815 — uyuşmazlık tenant izolasyonu", () => {
  it("bilinmeyen/eşlemesi olmayan müşteriye ait uyuşmazlık güvenle YOK SAYILIR", async () => {
    const fake = createFakeStripeGateway();
    setStripeGatewayForTests(fake.gateway);
    const dispute = disputeRef({ id: "dp_unknown_customer", customerId: "cus_completely_unknown" });
    fake.setDispute(dispute);

    const result = await processStripeWebhookEvent(disputeEvent({ disputeId: dispute.id }));
    expect(result.outcome).toBe("IGNORED");

    const rowCount = await db.stripeDispute.count();
    expect(rowCount).toBe(0);
  });

  it("cross-tenant koruması: başka bir organizasyona ait bir uyuşmazlık kimliğiyle mutabakat VARLIĞI SIZDIRMAZ", async () => {
    const orgA = await setUpOrgWithCustomer();
    const { owner: ownerB } = await createOwnerOrg();
    await ensureOrganizationStripeCustomer(ownerB); // B'nin de kendi Stripe müşteri eşlemesi olmalı ki mutabakat NOT_FOUND yerine gerçek fail-closed yolu (customer mismatch) test edilsin.

    const dispute = disputeRef({ id: "dp_cross_tenant", customerId: orgA.stripeCustomerId });
    orgA.fake.setDispute(dispute);
    await processStripeWebhookEvent(disputeEvent({ disputeId: dispute.id }));

    // B'nin sahibi, A'nın uyuşmazlık kimliğiyle mutabakat DENER.
    const result = await reconcileDispute(ownerB, dispute.id);
    expect(result.found).toBe(false); // VARLIĞI bile sızdırılmaz.
  });
});

describe("YF-815 — uyuşmazlık mutabakatı (reconciliation)", () => {
  it("kaçırılmış webhook: bilinen bir stripeDisputeId ile manuel mutabakat ilk kez doğru durumu üretir", async () => {
    const { fake, stripeCustomerId, owner, organizationId } = await setUpOrgWithCustomer();
    const dispute = disputeRef({ id: "dp_missed", customerId: stripeCustomerId, status: "lost" });
    fake.setDispute(dispute);

    const result = await reconcileDispute(owner, dispute.id);
    expect(result.found).toBe(true);
    expect(result.riskState).toBe("RESTRICTED");

    await expect(assertNotBillingRestricted(db, organizationId)).rejects.toBeInstanceOf(ServiceError);
  });

  it("açık yerel uyuşmazlıkların süpürülmesi (sweep) idempotenttir", async () => {
    const { organizationId, fake, stripeCustomerId } = await setUpOrgWithCustomer();
    const dispute = disputeRef({ id: "dp_sweep", customerId: stripeCustomerId, status: "needs_response" });
    fake.setDispute(dispute);
    await processStripeWebhookEvent(disputeEvent({ disputeId: dispute.id }));

    fake.setDispute({ ...dispute, status: "lost" });
    const firstSweep = await reconcileOpenOrganizationDisputes(organizationId, "TEST");
    expect(firstSweep).toBe(1);

    const row = await db.stripeDispute.findUniqueOrThrow({
      where: { environment_stripeDisputeId: { environment: "TEST", stripeDisputeId: dispute.id } },
    });
    expect(row.status).toBe("LOST");

    // Artık terminal — ikinci süpürme kapsam DIŞINDADIR (kapsam sınırı testi).
    const secondSweep = await reconcileOpenOrganizationDisputes(organizationId, "TEST");
    expect(secondSweep).toBe(0);
  });
});

describe("YF-815 — finansal sınır (görev talimatı kritik sınır)", () => {
  it("uyuşmazlık işlemleri SIFIR proje FinancialTransaction kaydı üretir", async () => {
    const { organizationId, fake, stripeCustomerId } = await setUpOrgWithCustomer();
    const dispute = disputeRef({ id: "dp_fin_boundary", customerId: stripeCustomerId, status: "lost" });
    fake.setDispute(dispute);
    await processStripeWebhookEvent(disputeEvent({ disputeId: dispute.id }));

    const financialTransactionCount = await db.financialTransaction.count({ where: { organizationId } });
    expect(financialTransactionCount).toBe(0);
  });
});
