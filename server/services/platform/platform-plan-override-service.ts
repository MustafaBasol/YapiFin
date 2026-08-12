import type { Prisma, PlatformPlanOverrideStatus, StripeSubscriptionStatus } from "@prisma/client";
import { db } from "@/lib/db";
import { writeAuditLog } from "@/lib/audit";
import { notFound, conflict } from "@/server/services/errors";
import {
  lockOrganizationForEntitlement,
  getOrganizationLimitSummary,
  resolveLimitMax,
  LIMIT_LABELS,
  type EffectivePlan,
} from "@/lib/entitlements/entitlement-service";
import { getActiveAddonQuota } from "@/lib/entitlements/usage-addons";
import { LIMIT_IDS, type LimitId } from "@/lib/entitlements/capabilities";

/**
 * YF-819 — Platform Admin'in bir organizasyonun ticari plan durumunu
 * (`Organization.planId`) doğrudan değiştirdiği, Stripe abonelik yaşam
 * döngüsünden (YF-810) BAĞIMSIZ "destek geçersiz kılma" (support override)
 * katmanı.
 *
 * ## Yetki sınırı — İKİNCİ bir entitlement motoru İCAT EDİLMEZ
 * Gerçek yetenek/kota kararı HER ZAMAN `lib/entitlements/entitlement-service.ts`
 * (YF-802) tarafından verilir — bu dosya yalnızca HANGİ planın atanacağına
 * karar verir ve `Organization.planId`'yi yazar; tıpkı
 * `server/services/billing/webhook-service.ts`'in yaptığı gibi (o dosyanın
 * dosya başı "Bu dosya `Organization.planId`'yi mutasyona uğratan TEK
 * yerdir" notu artık "webhook VEYA bu dosya" olarak okunmalıdır). Girdi plan
 * HER ZAMAN kanonik `Plan` tablosuna (`isActive`) karşı doğrulanır —
 * istemciden serbest metin/JSON entitlement ASLA kabul edilmez.
 *
 * ## Eşzamanlılık
 * Her mutasyon `lockOrganizationForEntitlement` (mevcut `SELECT ... FOR
 * UPDATE` deseni, webhook-service.ts İLE AYNI) altında çalışır — bu, AYNI
 * organizasyon için eşzamanlı İKİ Platform Admin isteğini VEYA bir Platform
 * Admin isteğiyle çakışan bir Stripe webhook'unu serileştirir. İKİNCİ
 * savunma katmanı karşılaştır-ve-değiştir (compare-and-swap): çağıran,
 * sayfayı yüklediği/önizleme aldığı ANDAKİ plan kodunu (`expectedCurrentPlanCode`)
 * veya geçersiz kılma kimliğini (`expectedOverrideId`) taşımalıdır; kilit
 * altında yeniden okunan güncel durum bununla eşleşmezse istek `CONFLICT`
 * ile reddedilir — çift tıklama VEYA iki eşzamanlı Platform Admin isteği,
 * biri diğerini SESSİZCE EZMEDEN, ikincisi güvenle reddedilir.
 *
 * ## Stripe ile ilişki (Stripe otorite kalır)
 * Bu servis Stripe'ı ASLA çağırmaz/değiştirmez. Organizasyonun aktif bir
 * Stripe aboneliği varsa, bir SONRAKİ webhook grant olayı (ör. yenileme)
 * Stripe'ın planını yeniden uygulayarak override'ı fiilen SONLANDIRABİLİR —
 * bu KASITLIDIR (görev talimatı "Stripe remains authoritative for paid
 * subscription lifecycle"); `webhook-service.ts`'e bu görevde HİÇBİR dokunuş
 * YAPILMAZ.
 *
 * ## Downgrade güvenliği
 * Mevcut kayıtlar ASLA silinmez/arşivlenmez (`previewPlatformPlanChange`
 * yalnızca BİLGİLENDİRİR — `lib/entitlements/entitlement-service.ts`
 * `isOverLimit`/`canAddOne` İLE AYNI "engelleme yok, yalnızca yeni kayıt
 * engellenir" felsefesi korunur, bkz. o dosyanın modül başı notu).
 */

type Tx = Prisma.TransactionClient;

/** Organizasyon plansızken `expectedCurrentPlanCode`/görüntüleme için kullanılan sentinel — `entitlement-service.ts` `NO_PLAN.code` İLE AYNI değer. */
export const NO_PLAN_CODE = "NONE";

const STRIPE_MANAGED_STATUSES: readonly StripeSubscriptionStatus[] = ["ACTIVE", "TRIALING", "PAST_DUE", "INCOMPLETE"];

export type PlanBillingSource = "STRIPE_MANAGED" | "MANUAL";

/**
 * Bir Stripe abonelik durumundan faturalama kaynağını sınıflandırır — saf
 * fonksiyon, `platform-organization-service.ts`teki org detay servisi de
 * (zaten çektiği `subscription` satırıyla, İKİNCİ bir sorgu AÇMADAN) bunu
 * reuse eder. Yalnızca UI/impact-preview'da "bu bir destek override'ı mı
 * yoksa Stripe'ın kendisini mi değiştiriyorsunuz" ayrımını netleştirmek
 * içindir, hiçbir entitlement kararını ETKİLEMEZ.
 */
export function classifyPlanBillingSource(subscriptionStatus: StripeSubscriptionStatus | null): PlanBillingSource {
  if (subscriptionStatus && STRIPE_MANAGED_STATUSES.includes(subscriptionStatus)) return "STRIPE_MANAGED";
  return "MANUAL";
}

async function resolveBillingSource(organizationId: string): Promise<PlanBillingSource> {
  const subscription = await db.organizationStripeSubscription.findUnique({
    where: { organizationId },
    select: { status: true },
  });
  return classifyPlanBillingSource(subscription?.status ?? null);
}

export interface PlatformPlanOverrideSummary {
  id: string;
  planCode: string;
  planName: string;
  reason: string;
  status: PlatformPlanOverrideStatus;
  expiresAt: Date | null;
  createdAt: Date;
  platformAdminName: string;
}

function toSummary(row: {
  id: string;
  reason: string;
  status: PlatformPlanOverrideStatus;
  expiresAt: Date | null;
  createdAt: Date;
  plan: { code: string; name: string };
  platformAdmin: { name: string };
}): PlatformPlanOverrideSummary {
  return {
    id: row.id,
    planCode: row.plan.code,
    planName: row.plan.name,
    reason: row.reason,
    status: row.status,
    expiresAt: row.expiresAt,
    createdAt: row.createdAt,
    platformAdminName: row.platformAdmin.name,
  };
}

/** Bir organizasyonun (varsa) GÜNCEL aktif geçersiz kılmasını döner — salt okunur, org detay sayfasında ve önizlemede kullanılır. */
export async function getActivePlatformPlanOverride(organizationId: string): Promise<PlatformPlanOverrideSummary | null> {
  const row = await db.platformPlanOverride.findFirst({
    where: { organizationId, status: "ACTIVE" },
    orderBy: { createdAt: "desc" },
    include: { plan: { select: { code: true, name: true } }, platformAdmin: { select: { name: true } } },
  });
  return row ? toSummary(row) : null;
}

/** Yalnızca aktif kanonik planları döner — geçersiz kılma formundaki plan seçicisi buradan beslenir (ikinci bir liste İCAT EDİLMEZ, doğrudan `Plan` tablosu). */
export async function listActiveCanonicalPlans(): Promise<Array<{ code: string; name: string }>> {
  return db.plan.findMany({ where: { isActive: true }, orderBy: { createdAt: "asc" }, select: { code: true, name: true } });
}

/**
 * Bir ACTIVE geçersiz kılmayı REVOKED/EXPIRED durumuna taşır ve
 * `Organization.planId`yi geçersiz kılmadan ÖNCEki plana (`previousPlanId`)
 * GERİ DÖNDÜRÜR. Hedef plan artık yok/pasifse fail-closed olarak `null`a
 * (plansız) düşer — `entitlement-service.ts` `NO_PLAN` felsefesiyle AYNI.
 * Çağıranın ZATEN açık olan kilitli transaction'ı İÇİNDE çalışır.
 */
async function revertOverride(
  tx: Tx,
  organizationId: string,
  override: { id: string; previousPlanId: string | null },
  opts: {
    newStatus: "REVOKED" | "EXPIRED";
    revokedById: string | null;
    action: string;
    reasonNote: string;
    ipAddress?: string | null;
    userAgent?: string | null;
  },
): Promise<void> {
  let revertPlanId: string | null = null;
  if (override.previousPlanId) {
    const prevPlan = await tx.plan.findUnique({ where: { id: override.previousPlanId }, select: { id: true, isActive: true } });
    if (prevPlan && prevPlan.isActive) revertPlanId = prevPlan.id;
  }

  const org = await tx.organization.findUniqueOrThrow({ where: { id: organizationId }, select: { planId: true } });

  await tx.platformPlanOverride.update({
    where: { id: override.id },
    data: { status: opts.newStatus, revokedAt: new Date(), revokedById: opts.revokedById },
  });
  await tx.organization.update({ where: { id: organizationId }, data: { planId: revertPlanId } });

  await writeAuditLog(tx, {
    organizationId,
    actorId: null,
    platformAdminId: opts.revokedById,
    action: opts.action,
    entityType: "Organization",
    entityId: organizationId,
    before: { planId: org.planId },
    after: { planId: revertPlanId, overrideId: override.id, reason: opts.reasonNote },
    ipAddress: opts.ipAddress ?? null,
    userAgent: opts.userAgent ?? null,
  });
}

/** Süresi dolmuş bir ACTIVE override varsa TEMBEL/lazy olarak revert eder. Yeni bir arka plan/cron işi İCAT EDİLMEZ — bkz. modül başı notu. */
async function reconcileExpiredOverrideWithinTx(tx: Tx, organizationId: string): Promise<void> {
  const override = await tx.platformPlanOverride.findFirst({
    where: { organizationId, status: "ACTIVE", expiresAt: { lte: new Date() } },
  });
  if (!override) return;
  await revertOverride(tx, organizationId, override, {
    newStatus: "EXPIRED",
    revokedById: null,
    action: "platform.plan.override_expired_reconciled",
    reasonNote: "Süre doldu — otomatik mutabakat (sonraki okuma/işlem sırasında tembel/lazy uygulanır).",
  });
}

/** Kendi kilitli transaction'ını açan dış giriş noktası — org detay sayfası GÖRÜNTÜLENİRKEN çağrılır (bkz. platform-organization-service.ts). */
export async function reconcileExpiredPlatformPlanOverride(organizationId: string): Promise<void> {
  await db.$transaction(async (tx) => {
    await lockOrganizationForEntitlement(tx, organizationId);
    await reconcileExpiredOverrideWithinTx(tx, organizationId);
  });
}

export interface PlatformPlanImpactLimit {
  limitId: LimitId;
  label: string;
  used: number;
  currentMax: number | null;
  targetMax: number | null;
  wouldExceed: boolean;
}

export interface PlatformPlanChangePreview {
  organizationId: string;
  currentPlanCode: string;
  currentPlanName: string;
  targetPlanCode: string;
  targetPlanName: string;
  billingSource: PlanBillingSource;
  activeOverride: PlatformPlanOverrideSummary | null;
  limits: PlatformPlanImpactLimit[];
  isDowngradeRisk: boolean;
}

/**
 * Bir plan değişikliğinin ETKİSİNİ, hiçbir yazma yapmadan önizler.
 * Nicel limit hesaplaması `lib/entitlements/entitlement-service.ts`in
 * dışa açtığı `resolveLimitMax` (saf fonksiyon) + `getOrganizationLimitSummary`
 * (GÜNCEL kullanım) + `getActiveAddonQuota` (YF-803 ek kota) primitiflerinin
 * BİRLEŞİMİDİR — o dosyaya HİÇBİR yeni fonksiyon eklenmez, yalnızca mevcut
 * (organizasyonun GÜNCEL planı için tasarlanmış) primitifler VARSAYIMSAL bir
 * hedef plan için yeniden bileşimlenir (ikinci bir entitlement motoru
 * DEĞİLDİR — aynı tek kaynak, farklı bir girdiyle çağrılır).
 */
export async function previewPlatformPlanChange(organizationId: string, targetPlanCode: string): Promise<PlatformPlanChangePreview> {
  const [org, targetPlan, billingSource, activeOverride, limitSummary] = await Promise.all([
    db.organization.findUnique({ where: { id: organizationId }, include: { plan: true } }),
    db.plan.findUnique({ where: { code: targetPlanCode } }),
    resolveBillingSource(organizationId),
    getActivePlatformPlanOverride(organizationId),
    getOrganizationLimitSummary(db, organizationId),
  ]);
  if (!org) throw notFound("Organizasyon bulunamadı");
  if (!targetPlan || !targetPlan.isActive) throw notFound("Geçersiz veya pasif plan. Yalnızca kanonik, aktif planlar atanabilir.");

  const targetEffective: EffectivePlan = {
    id: targetPlan.id,
    code: targetPlan.code,
    name: targetPlan.name,
    capabilities: (targetPlan.capabilities as Record<string, unknown>) ?? {},
    limits: (targetPlan.limits as Record<string, unknown>) ?? {},
  };

  const limits = await Promise.all(
    LIMIT_IDS.map(async (limitId): Promise<PlatformPlanImpactLimit> => {
      const current = limitSummary[limitId];
      const includedMax = resolveLimitMax(targetEffective, limitId);
      const targetMax = includedMax === null ? null : includedMax + (await getActiveAddonQuota(db, organizationId, limitId));
      return {
        limitId,
        label: LIMIT_LABELS[limitId],
        used: current.used,
        currentMax: current.max,
        targetMax,
        wouldExceed: targetMax !== null && current.used > targetMax,
      };
    }),
  );

  return {
    organizationId,
    currentPlanCode: org.plan?.code ?? NO_PLAN_CODE,
    currentPlanName: org.plan?.name ?? "Plansız",
    targetPlanCode: targetPlan.code,
    targetPlanName: targetPlan.name,
    billingSource,
    activeOverride,
    limits,
    isDowngradeRisk: limits.some((l) => l.wouldExceed),
  };
}

export interface ApplyPlatformPlanOverrideInput {
  organizationId: string;
  targetPlanCode: string;
  reason: string;
  expiresAt: Date | null;
  /** CAS anahtarı — bkz. modül başı "eşzamanlılık" notu. Plansız organizasyon için `NO_PLAN_CODE`. */
  expectedCurrentPlanCode: string;
  platformAdminId: string;
  ipAddress: string | null;
  userAgent: string | null;
}

export interface ApplyPlatformPlanOverrideResult {
  overrideId: string;
  planCode: string;
  planName: string;
}

/**
 * YENİ bir geçersiz kılma uygular. Aynı organizasyon için önceden ACTIVE bir
 * geçersiz kılma varsa `SUPERSEDED` olarak işaretlenir (geçmiş kayıt SİLİNMEZ)
 * — bir organizasyonun en fazla BİR aktif geçersiz kılması olabilir.
 */
export async function applyPlatformPlanOverride(input: ApplyPlatformPlanOverrideInput): Promise<ApplyPlatformPlanOverrideResult> {
  const targetPlan = await db.plan.findUnique({
    where: { code: input.targetPlanCode },
    select: { id: true, code: true, name: true, isActive: true },
  });
  if (!targetPlan || !targetPlan.isActive) {
    throw notFound("Geçersiz veya pasif plan. Yalnızca kanonik, aktif planlar atanabilir.");
  }

  return db.$transaction(async (tx) => {
    await lockOrganizationForEntitlement(tx, input.organizationId);
    await reconcileExpiredOverrideWithinTx(tx, input.organizationId);

    const org = await tx.organization.findUnique({
      where: { id: input.organizationId },
      include: { plan: { select: { id: true, code: true } } },
    });
    if (!org) throw notFound("Organizasyon bulunamadı");

    const currentPlanCode = org.plan?.code ?? NO_PLAN_CODE;
    if (currentPlanCode !== input.expectedCurrentPlanCode) {
      throw conflict("Organizasyonun planı bu sırada değişmiş (başka bir işlem/webhook tarafından). Sayfayı yenileyip tekrar deneyin.");
    }
    if (org.plan?.id === targetPlan.id) {
      throw conflict(`Organizasyon zaten ${targetPlan.name} planında.`);
    }

    await tx.platformPlanOverride.updateMany({
      where: { organizationId: input.organizationId, status: "ACTIVE" },
      data: { status: "SUPERSEDED" },
    });

    const created = await tx.platformPlanOverride.create({
      data: {
        organizationId: input.organizationId,
        planId: targetPlan.id,
        previousPlanId: org.plan?.id ?? null,
        reason: input.reason,
        platformAdminId: input.platformAdminId,
        expiresAt: input.expiresAt,
      },
    });

    await tx.organization.update({ where: { id: input.organizationId }, data: { planId: targetPlan.id } });

    await writeAuditLog(tx, {
      organizationId: input.organizationId,
      actorId: null,
      platformAdminId: input.platformAdminId,
      action: "platform.plan.override_applied",
      entityType: "Organization",
      entityId: input.organizationId,
      before: { planId: org.plan?.id ?? null, planCode: currentPlanCode },
      after: {
        planId: targetPlan.id,
        planCode: targetPlan.code,
        overrideId: created.id,
        reason: input.reason,
        expiresAt: input.expiresAt,
      },
      ipAddress: input.ipAddress,
      userAgent: input.userAgent,
    });

    return { overrideId: created.id, planCode: targetPlan.code, planName: targetPlan.name };
  });
}

export interface RevokePlatformPlanOverrideInput {
  organizationId: string;
  /** CAS anahtarı — bkz. modül başı "eşzamanlılık" notu. */
  expectedOverrideId: string;
  reason: string;
  platformAdminId: string;
  ipAddress: string | null;
  userAgent: string | null;
}

/** Mevcut ACTIVE geçersiz kılmayı elle sonlandırır ve planı ÖNCEki plana geri döndürür (fail-closed: geçersiz/silinmişse plansıza döner). */
export async function revokePlatformPlanOverride(input: RevokePlatformPlanOverrideInput): Promise<void> {
  await db.$transaction(async (tx) => {
    await lockOrganizationForEntitlement(tx, input.organizationId);

    const override = await tx.platformPlanOverride.findFirst({
      where: { organizationId: input.organizationId, status: "ACTIVE" },
      orderBy: { createdAt: "desc" },
    });
    if (!override) throw notFound("Aktif bir platform planı geçersiz kılması bulunamadı.");
    if (override.id !== input.expectedOverrideId) {
      throw conflict("Geçersiz kılma bu sırada değişmiş (başka bir Platform Admin tarafından). Sayfayı yenileyip tekrar deneyin.");
    }

    await revertOverride(tx, input.organizationId, override, {
      newStatus: "REVOKED",
      revokedById: input.platformAdminId,
      action: "platform.plan.override_revoked",
      reasonNote: input.reason,
      ipAddress: input.ipAddress,
      userAgent: input.userAgent,
    });
  });
}
