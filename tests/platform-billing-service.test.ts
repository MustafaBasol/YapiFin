import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { cleanDatabase, createOwnerOrg } from "./helpers";
import { getPlatformOrganizationBillingOperations } from "@/server/services/platform/platform-billing-service";

/**
 * YF-820 — `getPlatformOrganizationBillingOperations`
 * (server/services/platform/platform-billing-service.ts) salt-okunur
 * toplulaştırma testleri: yaşam döngüsü zaman çizelgesi (AuditLog filtresi),
 * webhook teşhisi, iade/uyuşmazlık/bildirim listeleri — sıralama, sınırlı
 * (bounded) sonuç seti, tenant izolasyonu ve ham payload SIZDIRMAMA.
 */

beforeAll(async () => {
  await cleanDatabase();
});

afterEach(async () => {
  await cleanDatabase();
});

afterAll(async () => {
  await db.$disconnect();
});

describe("YF-820 — getPlatformOrganizationBillingOperations", () => {
  it("boş bir organizasyon için tüm listeleri boş döner", async () => {
    const { organizationId } = await createOwnerOrg();
    const result = await getPlatformOrganizationBillingOperations(organizationId);
    expect(result.lifecycleEvents).toEqual([]);
    expect(result.webhookEvents).toEqual([]);
    expect(result.refunds).toEqual([]);
    expect(result.disputes).toEqual([]);
    expect(result.notifications).toEqual([]);
  });

  it("yaşam döngüsü zaman çizelgesi yalnızca faturalama audit eylemlerini, en yeniden en eskiye sıralı döner", async () => {
    const { organizationId } = await createOwnerOrg();
    await db.auditLog.create({
      data: { organizationId, action: "billing.subscription.entitlement_granted", entityType: "Organization", entityId: organizationId },
    });
    await db.auditLog.create({
      data: { organizationId, action: "billing.dunning.grace_started", entityType: "OrganizationStripeSubscription", entityId: organizationId },
    });
    // Faturalama İLE İLGİSİZ bir audit kaydı — zaman çizelgesinde GÖRÜNMEMELİ.
    await db.auditLog.create({
      data: { organizationId, action: "project.created", entityType: "Project", entityId: "irrelevant" },
    });

    const result = await getPlatformOrganizationBillingOperations(organizationId);
    expect(result.lifecycleEvents).toHaveLength(2);
    expect(result.lifecycleEvents[0].action).toBe("billing.dunning.grace_started");
    expect(result.lifecycleEvents[1].action).toBe("billing.subscription.entitlement_granted");
    // Proje detayları (beforeJson/afterJson) YANSITILMAZ — yalnızca eylem/tür/zaman/aktör.
    expect(result.lifecycleEvents[0]).not.toHaveProperty("beforeJson");
    expect(result.lifecycleEvents[0]).not.toHaveProperty("afterJson");
  });

  it("webhook olayları SINIRLI (bounded) ve stripeCreatedAt'e göre en yeniden en eskiye döner", async () => {
    const { organizationId } = await createOwnerOrg();
    const base = Date.now();
    for (let i = 0; i < 25; i += 1) {
      await db.stripeWebhookEvent.create({
        data: {
          stripeEventId: `evt_bounded_${i}`,
          environment: "TEST",
          eventType: "customer.subscription.updated",
          organizationId,
          status: "PROCESSED",
          stripeCreatedAt: new Date(base + i * 1000),
        },
      });
    }

    const result = await getPlatformOrganizationBillingOperations(organizationId);
    expect(result.webhookEvents.length).toBeLessThanOrEqual(20); // Sınırsız geçmiş TARANMAZ.
    expect(result.webhookEvents[0].stripeEventId).toBe("evt_bounded_24"); // En yeni önce.
    // Ham webhook gövdesi/imzası hiçbir zaman şemada YOKTUR — dönen alan seti güvenli/sabittir.
    expect(Object.keys(result.webhookEvents[0]).sort()).toEqual(
      ["attempts", "errorSummary", "eventType", "id", "processedAt", "receivedAt", "status", "stripeCreatedAt", "stripeEventId"].sort(),
    );
  });

  it("iadeler ve uyuşmazlıklar organizasyona göre SCOPE'LANIR (tenant izolasyonu)", async () => {
    const { organizationId: orgA } = await createOwnerOrg();
    const { organizationId: orgB } = await createOwnerOrg();

    await db.stripeRefund.create({
      data: {
        organizationId: orgA,
        environment: "TEST",
        stripeRefundId: "re_org_a",
        stripeChargeId: "ch_org_a",
        status: "SUCCEEDED",
        amount: 10000,
        currency: "try",
      },
    });
    await db.stripeRefund.create({
      data: {
        organizationId: orgB,
        environment: "TEST",
        stripeRefundId: "re_org_b",
        stripeChargeId: "ch_org_b",
        status: "SUCCEEDED",
        amount: 20000,
        currency: "try",
      },
    });
    await db.stripeDispute.create({
      data: {
        organizationId: orgA,
        environment: "TEST",
        stripeDisputeId: "dp_org_a",
        stripeChargeId: "ch_org_a_dispute",
        status: "LOST",
        riskState: "RESTRICTED",
        amount: 5000,
        currency: "try",
      },
    });

    const resultA = await getPlatformOrganizationBillingOperations(orgA);
    expect(resultA.refunds).toHaveLength(1);
    expect(resultA.refunds[0].stripeRefundId).toBe("re_org_a");
    expect(resultA.disputes).toHaveLength(1);
    expect(resultA.disputes[0].stripeDisputeId).toBe("dp_org_a");

    const resultB = await getPlatformOrganizationBillingOperations(orgB);
    expect(resultB.refunds).toHaveLength(1);
    expect(resultB.refunds[0].stripeRefundId).toBe("re_org_b");
    expect(resultB.disputes).toHaveLength(0); // Org B'nin HİÇBİR uyuşmazlığı yok — Org A'nınki SIZMAZ.
  });

  it("bildirimler türü/durumu/teslim denemeleriyle birlikte listelenir", async () => {
    const { organizationId } = await createOwnerOrg();
    await db.billingNotification.create({
      data: {
        organizationId,
        type: "PAYMENT_FAILED_GRACE_STARTED",
        episodeKey: new Date().toISOString(),
        status: "SENT",
        recipientCount: 1,
        attemptCount: 1,
        sentAt: new Date(),
      },
    });
    await db.billingNotification.create({
      data: {
        organizationId,
        type: "GRACE_EXPIRED_RESTRICTED",
        episodeKey: new Date(Date.now() - 60_000).toISOString(),
        status: "FAILED",
        attemptCount: 2,
        lastError: "SMTP_TIMEOUT",
      },
    });

    const result = await getPlatformOrganizationBillingOperations(organizationId);
    expect(result.notifications).toHaveLength(2);
    const failed = result.notifications.find((n) => n.status === "FAILED");
    expect(failed?.lastError).toBe("SMTP_TIMEOUT");
    expect(failed?.attemptCount).toBe(2);
  });
});
