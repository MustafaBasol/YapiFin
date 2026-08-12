import { db } from "@/lib/db";
import { registerOwnerAndOrganization } from "@/server/services/organization-service";
import { DEFAULT_PLANS } from "@/lib/entitlements/plan-defaults";
import type { CapabilityId, LimitId } from "@/lib/entitlements/capabilities";
import type { SessionUser } from "@/lib/auth/session";
import type { RegisterOwnerInput } from "@/lib/validation/auth";
import type { Prisma, StripeEnvironment, UserRole } from "@prisma/client";
import type {
  AddonCheckoutSessionRef,
  CreateAddonCheckoutSessionParams,
  CreateBillingPortalSessionParams,
  CreateCheckoutSessionParams,
  CreateStripeCustomerParams,
  StripeBillingPortalSessionRef,
  StripeChargeRef,
  StripeCheckoutSessionRef,
  StripeDisputeRef,
  StripeGateway,
  StripeRefundRef,
  StripeSubscriptionRef,
} from "@/lib/billing/stripe-gateway";

let counter = 0;
function unique(prefix: string) {
  counter += 1;
  return `${prefix}-${Date.now()}-${counter}`;
}

export async function createOwnerOrg(overrides: Partial<RegisterOwnerInput> = {}) {
  const suffix = unique("org");
  const input: RegisterOwnerInput = {
    firstName: "Ayşe",
    lastName: "Yılmaz",
    email: `${suffix}@example.com`,
    phone: "",
    password: "Sifre1234",
    organizationName: `Test İnşaat ${suffix}`,
    city: "İstanbul",
    district: "Kadıköy",
    taxOffice: "",
    taxNumber: "",
    ...overrides,
  };

  const { userId, organizationId } = await registerOwnerAndOrganization(input);
  const owner = await toSessionUser(userId);
  return { organizationId, owner };
}

export async function toSessionUser(userId: string): Promise<SessionUser> {
  const user = await db.user.findUniqueOrThrow({ where: { id: userId }, include: { organization: true } });
  return {
    id: user.id,
    organizationId: user.organizationId,
    firstName: user.firstName,
    lastName: user.lastName,
    email: user.email,
    role: user.role,
    status: user.status,
    emailVerifiedAt: user.emailVerifiedAt,
    organizationName: user.organization.tradeName ?? user.organization.name,
  };
}

export async function createOrgUser(organizationId: string, role: UserRole, overrides: { email?: string } = {}) {
  const suffix = unique("user");
  const user = await db.user.create({
    data: {
      organizationId,
      firstName: "Test",
      lastName: role,
      email: overrides.email ?? `${suffix}@example.com`,
      passwordHash: "unused",
      role,
      status: "ACTIVE",
      emailVerifiedAt: new Date(),
    },
  });
  return toSessionUser(user.id);
}

export async function cleanDatabase() {
  await db.$transaction([
    // YF-819 — `PlatformPlanOverride.platformAdminId`/`.organizationId`/`.planId`
    // `onDelete: Restrict`tir (bkz. prisma/schema.prisma) — bu yüzden
    // aşağıdaki `platformAdmin`/`organization`/`plan` temizliklerinden ÖNCE
    // silinmelidir.
    db.platformPlanOverride.deleteMany(),
    // YF-818 — Platform Admin kimlik/oturum tabloları organizasyona FK ile
    // bağlı DEĞİLDİR (bilinçli olarak tamamen ayrı kimlik sistemi, bkz.
    // lib/auth/platform-session.ts dosya başı notu) — yine de testler arası
    // sızıntıyı önlemek için burada temizlenir. Session, admin'e FK ile
    // bağlı olduğundan (onDelete: Cascade) önce silinir.
    db.platformAdminSession.deleteMany(),
    db.platformAdmin.deleteMany(),
    db.auditLog.deleteMany(),
    // YF-803 — ek/top-up kota bağışları (organizasyonlardan önce silinir).
    db.usageAddonGrant.deleteMany(),
    db.aiUsageLedger.deleteMany(),
    db.documentExtraction.deleteMany(),
    // YF-810 — webhook olay defteri + abonelik durumu (organizasyonlardan önce silinir).
    db.stripeWebhookEvent.deleteMany(),
    db.organizationStripeSubscription.deleteMany(),
    // YF-809 — açık Checkout denemeleri (organizasyonlardan önce silinir).
    db.organizationCheckoutAttempt.deleteMany(),
    // YF-808 — Stripe müşteri eşlemeleri (organizasyonlardan önce silinir).
    db.organizationStripeCustomer.deleteMany(),
    db.integrationOutboundOperation.deleteMany(),
    db.integrationEventLog.deleteMany(),
    db.integrationCredential.deleteMany(),
    db.integrationConnection.deleteMany(),
    db.bankImportRow.deleteMany(),
    db.bankImportBatch.deleteMany(),
    db.accountMovement.deleteMany(),
    db.accountTransfer.deleteMany(),
    db.settlement.deleteMany(),
    db.progressPaymentExtraWorkItem.deleteMany(),
    db.progressPayment.deleteMany(),
    db.projectBudgetItem.deleteMany(),
    db.financialTransaction.deleteMany(),
    db.projectMember.deleteMany(),
    db.project.deleteMany(),
    db.transactionCategory.deleteMany(),
    db.financialAccount.deleteMany(),
    db.customer.deleteMany(),
    db.supplier.deleteMany(),
    db.invitation.deleteMany(),
    db.emailVerificationToken.deleteMany(),
    db.passwordResetToken.deleteMany(),
    db.session.deleteMany(),
    db.user.deleteMany(),
    db.organization.deleteMany(),
    // YF-802 — testlerin oluşturduğu geçici planlar (bkz. createTestPlan)
    // temizlenir; migration'ın tohumladığı varsayılan planlar (STARTER/
    // PROFESSIONAL/ENTERPRISE) her zaman korunur — organizasyonlar
    // yukarıda zaten silindiği için FK çakışması olmaz.
    db.plan.deleteMany({ where: { code: { notIn: DEFAULT_PLANS.map((p) => p.code) } } }),
  ]);
}

/** YF-819 — testler için gerçek bir `PlatformAdmin` satırı oluşturur (audit `platformAdminId` FK'si gerçek bir satırı ZORUNLU kılar, sabit/uydurma bir id KULLANILAMAZ). */
export async function createPlatformAdmin(overrides: { email?: string; name?: string } = {}) {
  const suffix = unique("platform-admin");
  return db.platformAdmin.create({
    data: {
      email: overrides.email ?? `${suffix}@example.com`,
      passwordHash: "unused",
      name: overrides.name ?? "Test Platform Admin",
      status: "ACTIVE",
    },
  });
}

/** YF-802 — bir organizasyonu belirtilen (varsayılan veya test amaçlı) plana bağlar. */
export async function setOrganizationPlan(organizationId: string, planCode: string) {
  const plan = await db.plan.findUniqueOrThrow({ where: { code: planCode } });
  await db.organization.update({ where: { id: organizationId }, data: { planId: plan.id } });
  return plan;
}

/** YF-802 — sınır/yetenek testleri için özel limit/capability kombinasyonlarına sahip geçici bir plan oluşturur. */
export async function createTestPlan(overrides: {
  code?: string;
  name?: string;
  limits?: Partial<Record<LimitId, number | null>>;
  capabilities?: Partial<Record<CapabilityId, boolean>>;
  isActive?: boolean;
}) {
  const suffix = unique("plan");
  return db.plan.create({
    data: {
      code: overrides.code ?? `TEST-${suffix}`,
      name: overrides.name ?? "Test Planı",
      limits: (overrides.limits ?? {}) as Prisma.InputJsonValue,
      capabilities: (overrides.capabilities ?? {}) as Prisma.InputJsonValue,
      isActive: overrides.isActive ?? true,
    },
  });
}

/**
 * YF-808/YF-809 — `StripeGateway`'in TEK paylaşılan sahte (fake)
 * uygulaması. Hem müşteri oluşturma (YF-808) hem Checkout Session oluşturma
 * (YF-809) testlerinde kullanılır; Stripe'ın idempotency davranışını taklit
 * eder: aynı `idempotencyKey` ile yapılan ikinci çağrı YENİ bir kayıt
 * üretmez, ilkini döner.
 */
export function createFakeStripeGateway(environment: StripeEnvironment = "TEST") {
  const customersByIdempotencyKey = new Map<string, string>();
  const checkoutSessionsByIdempotencyKey = new Map<string, StripeCheckoutSessionRef>();
  const customerCalls: CreateStripeCustomerParams[] = [];
  const checkoutCalls: CreateCheckoutSessionParams[] = [];
  // YF-810 — abonelik durumu, testin `setSubscription`/`deleteSubscription`
  // ile doğrudan kontrol ettiği bir bellek-içi kayıt (Stripe'a HİÇ ağ
  // çağrısı yapılmaz). `webhook-service.ts`in `retrieveSubscription`/
  // `listSubscriptionsForCustomer` çağrıları bu haritadan okur — böylece
  // testler "Stripe'ın GÜNCEL gerçeği" senaryosunu (refetch-on-write
  // stratejisi, bkz. webhook-service.ts dosya başı not) doğrudan simüle
  // edebilir.
  const subscriptionsById = new Map<string, StripeSubscriptionRef>();
  // YF-813 — add-on (tek seferlik `payment` modu) Checkout Session'ları.
  // `subscriptionsById` ile AYNI gerekçe: `retrieveCheckoutSessionForAddon`
  // Stripe'a HİÇ ağ çağrısı yapmadan bu bellek-içi haritadan okur — testler
  // `setAddonCheckoutSession`/`markAddonCheckoutSessionPaid` ile "Stripe'ın
  // güncel gerçeğini" doğrudan kontrol eder (refetch-on-write stratejisi).
  const addonSessionsById = new Map<string, AddonCheckoutSessionRef>();
  const addonCheckoutSessionsByIdempotencyKey = new Map<string, StripeCheckoutSessionRef>();
  const addonCheckoutCalls: CreateAddonCheckoutSessionParams[] = [];
  // YF-815 — `subscriptionsById`/`addonSessionsById` ile AYNI gerekçe:
  // `retrieveRefund`/`retrieveCharge`/`retrieveDispute` Stripe'a HİÇ ağ
  // çağrısı yapmadan bu bellek-içi haritalardan okur — testler
  // `setRefund`/`setCharge`/`setDispute` ile "Stripe'ın güncel gerçeğini"
  // doğrudan kontrol eder (refetch-on-write stratejisi).
  const refundsById = new Map<string, StripeRefundRef>();
  const chargesById = new Map<string, StripeChargeRef>();
  const disputesById = new Map<string, StripeDisputeRef>();
  const billingPortalSessionCalls: CreateBillingPortalSessionParams[] = [];
  let customerSequence = 0;
  let checkoutSequence = 0;
  let addonCheckoutSequence = 0;

  const gateway: StripeGateway = {
    environment,
    async createCustomer(params) {
      customerCalls.push(params);
      const existing = customersByIdempotencyKey.get(params.idempotencyKey);
      if (existing) return { id: existing };
      customerSequence += 1;
      const id = `cus_fake_${environment.toLowerCase()}_${customerSequence}`;
      customersByIdempotencyKey.set(params.idempotencyKey, id);
      return { id };
    },
    async retrieveCustomer(customerId) {
      return [...customersByIdempotencyKey.values()].includes(customerId) ? { id: customerId } : null;
    },
    async createCheckoutSession(params) {
      checkoutCalls.push(params);
      const existing = checkoutSessionsByIdempotencyKey.get(params.idempotencyKey);
      if (existing) return existing;
      checkoutSequence += 1;
      const id = `cs_fake_${environment.toLowerCase()}_${checkoutSequence}`;
      const session: StripeCheckoutSessionRef = {
        id,
        url: `https://checkout.stripe.example/fake/${id}`,
        expiresAt: Math.floor(Date.now() / 1000) + 24 * 60 * 60,
      };
      checkoutSessionsByIdempotencyKey.set(params.idempotencyKey, session);
      return session;
    },
    async createAddonCheckoutSession(params) {
      addonCheckoutCalls.push(params);
      const existing = addonCheckoutSessionsByIdempotencyKey.get(params.idempotencyKey);
      if (existing) return existing;
      addonCheckoutSequence += 1;
      const id = `cs_addon_fake_${environment.toLowerCase()}_${addonCheckoutSequence}`;
      const session: StripeCheckoutSessionRef = {
        id,
        url: `https://checkout.stripe.example/fake-addon/${id}`,
        expiresAt: Math.floor(Date.now() / 1000) + 24 * 60 * 60,
      };
      addonCheckoutSessionsByIdempotencyKey.set(params.idempotencyKey, session);
      // Varsayılan: henüz ÖDENMEMİŞ (bkz. dosya başı not) — testler ödeme
      // onayını `markAddonCheckoutSessionPaid` ile AYRICA simüle eder; bu,
      // "Checkout redirect alone -> no grant" senaryosunun varsayılan/güvenli
      // durumudur.
      addonSessionsById.set(id, {
        id,
        mode: "payment",
        customerId: params.customerId,
        paymentStatus: "unpaid",
        priceId: params.priceId,
        paymentIntentId: `pi_fake_${id}`,
        clientReferenceId: params.organizationId,
        addonKeyMetadata: params.addonKey,
      });
      return session;
    },
    async retrieveCheckoutSessionForAddon(sessionId) {
      return addonSessionsById.get(sessionId) ?? null;
    },
    async retrieveSubscription(subscriptionId) {
      return subscriptionsById.get(subscriptionId) ?? null;
    },
    async listSubscriptionsForCustomer(customerId, limit = 3) {
      return [...subscriptionsById.values()].filter((s) => s.customerId === customerId).slice(0, limit);
    },
    async retrieveRefund(refundId) {
      return refundsById.get(refundId) ?? null;
    },
    async retrieveCharge(chargeId) {
      return chargesById.get(chargeId) ?? null;
    },
    async retrieveDispute(disputeId) {
      return disputesById.get(disputeId) ?? null;
    },
    // YF-814 — Stripe'a HİÇ ağ çağrısı yapmadan sabit, deterministik bir sahte
    // portal URL'si döner (bkz. `billingPortalSessionCalls` — testler yalnızca
    // ÇAĞRILDIĞINI/parametrelerini doğrular, gerçek Stripe entegrasyonu
    // BURADA test EDİLMEZ).
    async createBillingPortalSession(params: CreateBillingPortalSessionParams): Promise<StripeBillingPortalSessionRef> {
      billingPortalSessionCalls.push(params);
      return { url: `https://billing.stripe.example/fake-portal/${params.customerId}` };
    },
    constructWebhookEvent() {
      // Servis-katmanı testleri `processStripeWebhookEvent`'i doğrudan,
      // imza doğrulamasını ATLAYARAK çağırır (bkz. tests/billing-webhook.test.ts
      // dosya başı not) — bu sahte gateway'de bu metodun ÇAĞRILMASI bir test
      // tasarım hatasıdır.
      throw new Error("createFakeStripeGateway: constructWebhookEvent kullanılmamalıdır");
    },
  };

  return {
    gateway,
    customerCalls,
    checkoutCalls,
    /** Stripe'ta gerçekten kaç ayrı müşteri oluştuğu (idempotency sonrası). */
    get distinctCustomerCount() {
      return new Set(customersByIdempotencyKey.values()).size;
    },
    /** Stripe'ta gerçekten kaç ayrı Checkout Session oluştuğu (idempotency sonrası). */
    get distinctCheckoutSessionCount() {
      return new Set([...checkoutSessionsByIdempotencyKey.values()].map((s) => s.id)).size;
    },
    /** YF-810 — `retrieveSubscription`/`listSubscriptionsForCustomer`'ın bu ID için döneceği "Stripe'ın güncel gerçeğini" ayarlar/günceller. */
    setSubscription(sub: StripeSubscriptionRef) {
      subscriptionsById.set(sub.id, sub);
    },
    /** YF-810 — bir aboneliği Stripe'tan "artık bulunamıyor" (resource_missing) durumuna getirir. */
    deleteSubscription(subscriptionId: string) {
      subscriptionsById.delete(subscriptionId);
    },
    addonCheckoutCalls,
    /** Stripe'ta gerçekten kaç ayrı add-on Checkout Session oluştuğu (idempotency sonrası). */
    get distinctAddonCheckoutSessionCount() {
      return new Set([...addonCheckoutSessionsByIdempotencyKey.values()].map((s) => s.id)).size;
    },
    /** YF-813 — `retrieveCheckoutSessionForAddon`'ın bu ID için döneceği "Stripe'ın güncel gerçeğini" doğrudan ayarlar/günceller (ör. tenant-mismatch/bilinmeyen-fiyat senaryoları). */
    setAddonCheckoutSession(session: AddonCheckoutSessionRef) {
      addonSessionsById.set(session.id, session);
    },
    /** Kolaylık: `createAddonCheckoutSession` ile oluşturulmuş bir Session'ı "ödendi" (paid) durumuna taşır — webhook/mutabakat "başarılı ödeme" senaryosunu simüle eder. */
    markAddonCheckoutSessionPaid(sessionId: string) {
      const existing = addonSessionsById.get(sessionId);
      if (!existing) throw new Error(`markAddonCheckoutSessionPaid: bilinmeyen session: ${sessionId}`);
      addonSessionsById.set(sessionId, { ...existing, paymentStatus: "paid" });
    },
    /** YF-815 — `retrieveRefund`'ın bu ID için döneceği "Stripe'ın güncel gerçeğini" ayarlar/günceller. */
    setRefund(refund: StripeRefundRef) {
      refundsById.set(refund.id, refund);
    },
    /** YF-815 — `retrieveCharge`'ın bu ID için döneceği "Stripe'ın güncel gerçeğini" ayarlar/günceller (tam/kısmi iade ayrımı için, bkz. `StripeChargeRef` dosya başı notu). */
    setCharge(charge: StripeChargeRef) {
      chargesById.set(charge.id, charge);
    },
    /** YF-815 — `retrieveDispute`'ın bu ID için döneceği "Stripe'ın güncel gerçeğini" ayarlar/günceller. */
    setDispute(dispute: StripeDisputeRef) {
      disputesById.set(dispute.id, dispute);
    },
    /** YF-814 — `createBillingPortalSession`'ın ÇAĞRILDIĞI/hangi parametrelerle çağrıldığını doğrulamak için. */
    billingPortalSessionCalls,
  };
}

/**
 * YF-809 hotfix — `createCheckoutSession` çağrıldığı anda (senkron olarak
 * `checkoutCalls`'a eklenir) bekleyen, ancak `resolveNext`/`rejectNext`
 * ÇAĞRILANA kadar sonuçlanmayan bir sahte gateway. Reel eşzamanlılık
 * senaryolarını (bkz. tests/billing-checkout.test.ts "YF-809 hotfix —
 * eşzamanlılık") kanıtlamak için kullanılır: rezervasyon (DB) her zaman
 * gateway çağrısından ÖNCE tamamlandığı için, `checkoutCalls.length` gerçek
 * bir isteğin gateway'e ULAŞTIĞININ deterministik kanıtıdır — sabit bir
 * `sleep` yerine bu koşul beklenir (bkz. `waitFor`).
 */
export function createDeferredStripeGateway(environment: StripeEnvironment = "TEST") {
  const checkoutCalls: CreateCheckoutSessionParams[] = [];
  const pending: Array<{
    resolve: (session: StripeCheckoutSessionRef) => void;
    reject: (err: unknown) => void;
  }> = [];
  let sequence = 0;

  const gateway: StripeGateway = {
    environment,
    async createCustomer(params) {
      return { id: `cus_fake_deferred_${environment.toLowerCase()}_${params.organizationId}` };
    },
    async retrieveCustomer(customerId) {
      return { id: customerId };
    },
    createCheckoutSession(params) {
      checkoutCalls.push(params);
      return new Promise<StripeCheckoutSessionRef>((resolve, reject) => {
        pending.push({ resolve, reject });
      });
    },
    async retrieveSubscription() {
      return null;
    },
    async listSubscriptionsForCustomer() {
      return [];
    },
    // YF-813 — bu sahte gateway yalnızca PLAN checkout eşzamanlılık
    // senaryolarını (bkz. dosya başı not) test eder; add-on akışları bunu
    // kullanmaz, bu yüzden burada ertelenmez (deferred) — basit, senkron bir
    // pass-through yeterlidir (arayüz sözleşmesini karşılamak için gerekir).
    async createAddonCheckoutSession(params) {
      return {
        id: `cs_addon_fake_deferred_${environment.toLowerCase()}_${params.organizationId}`,
        url: `https://checkout.stripe.example/fake-addon-deferred/${params.organizationId}`,
        expiresAt: Math.floor(Date.now() / 1000) + 24 * 60 * 60,
      };
    },
    async retrieveCheckoutSessionForAddon() {
      return null;
    },
    async retrieveRefund() {
      return null;
    },
    async retrieveCharge() {
      return null;
    },
    async retrieveDispute() {
      return null;
    },
    async createBillingPortalSession(params) {
      return { url: `https://billing.stripe.example/fake-portal-deferred/${params.customerId}` };
    },
    constructWebhookEvent() {
      throw new Error("createDeferredStripeGateway: constructWebhookEvent kullanılmamalıdır");
    },
  };

  return {
    gateway,
    checkoutCalls,
    get pendingCount() {
      return pending.length;
    },
    /** En eski bekleyen `createCheckoutSession` çağrısını BAŞARIYLA sonlandırır. */
    resolveNext(overrides: Partial<StripeCheckoutSessionRef> = {}) {
      const next = pending.shift();
      if (!next) throw new Error("createDeferredStripeGateway: bekleyen bir createCheckoutSession çağrısı yok");
      sequence += 1;
      const id = `cs_fake_deferred_${environment.toLowerCase()}_${sequence}`;
      next.resolve({
        id,
        url: `https://checkout.stripe.example/fake-deferred/${id}`,
        expiresAt: Math.floor(Date.now() / 1000) + 24 * 60 * 60,
        ...overrides,
      });
    },
    /** En eski bekleyen `createCheckoutSession` çağrısını BAŞARISIZ sonlandırır. */
    rejectNext(err: unknown) {
      const next = pending.shift();
      if (!next) throw new Error("createDeferredStripeGateway: bekleyen bir createCheckoutSession çağrısı yok");
      next.reject(err);
    },
  };
}

/**
 * Sabit bir `sleep` YERİNE, gerçek bir koşul GERÇEKLEŞENE kadar kısa
 * aralıklarla yoklar (poll) — yarış senaryolarını deterministik biçimde
 * sıralamak için (bkz. `createDeferredStripeGateway` dosya başı notu).
 * Koşul, zaman aşımı içinde gerçekleşmezse fırlatır (test'i sessizce
 * geçirmez).
 */
export async function waitFor(condition: () => boolean, timeoutMs = 5000, intervalMs = 5): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("waitFor: koşul zaman aşımı içinde gerçekleşmedi");
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}
