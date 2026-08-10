import type { StripeEnvironment } from "@prisma/client";
import { db } from "@/lib/db";
import { writeAuditLog } from "@/lib/audit";
import { canManageOrganizationSettings } from "@/lib/permissions";
import { conflict, forbidden, ServiceError } from "@/server/services/errors";
import { getEnv } from "@/lib/env";
import {
  CANONICAL_BILLING_PLAN_CODES,
  BILLING_INTERVALS,
  getStripeConfig,
  resolveStripePriceForPlan,
  type BillingInterval,
} from "@/lib/billing/stripe-config";
import { resolveStripeGateway } from "@/lib/billing/stripe-gateway";
import { ensureOrganizationStripeCustomer } from "@/server/services/billing/stripe-customer-service";
import type { SessionUser } from "@/lib/auth/session";

/**
 * YF-809 — Kendi kendine (self-service) Stripe Checkout başlatma servisi.
 *
 * ## Mimari sözleşme (YF-808 ile AYNI, değiştirilemez)
 *
 * Stripe yalnızca **ödeme/faturalama sağlayıcısıdır**. Bu servis Stripe'ta bir
 * Checkout Session OLUŞTURUR — hiçbir koşulda `Organization.planId`'ye
 * DOKUNMAZ ve hiçbir yetenek/kota KAZANDIRMAZ. Abonelik/entitlement
 * doğruluğunun TEK kaynağı YF-810 webhook senkronizasyonu olacaktır (bkz.
 * docs/architecture/YF-809_STRIPE_CHECKOUT.md §7); tarayıcının Checkout'tan
 * dönmesi (`success_url`) BUNU TETİKLEMEZ (bkz.
 * app/(app)/settings/plan/checkout/success/page.tsx — yalnızca "onay
 * bekleniyor" durumu gösterir).
 *
 * ## Girdi güveni
 *
 * İstemciden yalnızca kanonik `planCode` + `billingInterval` kabul edilir.
 * Stripe Price ID, tutar, para birimi, Stripe Customer ID, `organizationId`
 * veya dönüş URL'i istemciden ASLA alınmaz/güvenilmez — fiyat
 * `resolveStripePriceForPlan()` ile sunucu tarafında kanonik katalogdan
 * çözülür, müşteri `ensureOrganizationStripeCustomer()` ile oturumdan
 * türetilir, dönüş URL'leri sabit uygulama yapılandırmasından üretilir (bkz.
 * `buildSuccessUrl`/`buildCancelUrl`).
 *
 * ## Yetki
 *
 * Yalnızca **OWNER** (`canManageOrganizationSettings`) — YF-808'in Stripe
 * müşterisi oluşturma yetki sınırıyla AYNI (ödeme başlatmak, organizasyonun
 * ödeme sağlayıcısı kimliğini yönetmekle aynı hassasiyet seviyesindedir).
 *
 * ## Mükerrer deneme / idempotency
 *
 * İki katmanlıdır (YF-808'deki müşteri oluşturma ile AYNI desen):
 *
 * 1. **Stripe tarafı:** deterministik idempotency anahtarı
 *    (`buildCheckoutIdempotencyKey` — organizasyon+ortam+plan+aralık'tan
 *    türetilir). Aynı planı hızlı art arda tıklamak Stripe'ta AYNI Checkout
 *    Session'ı döner, ikinci bir oturum OLUŞTURMAZ. Anahtar zaman bileşeni
 *    TAŞIMAZ; bu kasıtlıdır — Stripe'ın idempotency önbelleği ve Checkout
 *    Session'ın kendi süresi (`expires_at`) her ikisi de ~24 saatte dolar, bu
 *    yüzden satır BAYATLADIĞINDA (bkz. aşağıdaki `expiresAt` mantığı) AYNI
 *    anahtarla yeni bir istek Stripe'ta güvenle YENİ bir oturum üretir.
 * 2. **Veritabanı tarafı:** `OrganizationCheckoutAttempt.organizationId`
 *    birincil anahtardır — bir organizasyonun aynı anda yalnızca TEK açık
 *    denemesi olabilir. Check-then-insert yarışı yoktur: `create` P2002 ile
 *    çakışırsa, çakışan satır yalnızca AYNI plan/aralık/ortamı taşıyorsa
 *    (kendi tekrarımız) veya süresi dolmuşsa güncellenir; aksi halde
 *    (organizasyon FARKLI bir plan için zaten açık bir denemeye sahipse)
 *    istek `CONFLICT` ile reddedilir.
 *
 * **Bilinen sınır:** ön-kontrol (Stripe çağrısından ÖNCEKİ okuma) ile DB
 * yazımı arasında, aynı organizasyon için FARKLI planlarda gerçekten
 * eşzamanlı iki istek teorik olarak her ikisi de birer Stripe Checkout
 * Session'ı oluşturabilir (yalnızca biri DB'de izlenir, diğeri Stripe
 * tarafında 24 saat içinde kendiliğinden sona erer). Bu, dağıtık kilit
 * gerektirmeyen, bilinçli olarak minimal bir tasarım kararıdır: bir Checkout
 * Session tek başına HİÇBİR ücret/abonelik oluşturmaz (yalnızca kullanıcı
 * ödemeyi tamamlarsa ve YF-810 webhook'u işlerse gerçek olur) — bkz. görev
 * talimatı "avoid creating multiple sessions for the SAME intended purchase"
 * (bu, AYNI plan için idempotency anahtarıyla tam olarak çözülür).
 */

const CHECKOUT_AUDIT_ACTION = "billing.checkout.create";

/**
 * Deterministik ve çarpışmasız — bkz. dosya başı not (§ idempotency).
 * `buildCustomerIdempotencyKey` (YF-808) ile AYNI desen.
 */
export function buildCheckoutIdempotencyKey(
  organizationId: string,
  environment: StripeEnvironment,
  planCode: string,
  billingInterval: BillingInterval,
): string {
  return `yapifin:${environment.toLowerCase()}:checkout:${organizationId}:${planCode}:${billingInterval.toLowerCase()}`;
}

/**
 * Sunucu tarafında, sabit uygulama yapılandırmasından üretilir — istemciden
 * hiçbir dönüş URL'i kabul edilmez (görev talimatı "Do not accept arbitrary
 * return URLs from the client"). `{CHECKOUT_SESSION_ID}` Stripe'ın kendi
 * yer tutucusudur — Stripe tarafından değiştirilir, `encodeURIComponent`
 * UYGULANMAZ (bkz. Stripe Checkout dokümantasyonu).
 */
function buildSuccessUrl(): string {
  const base = getEnv().NEXT_PUBLIC_APP_URL.replace(/\/+$/, "");
  return `${base}/settings/plan/checkout/success?session_id={CHECKOUT_SESSION_ID}`;
}

function buildCancelUrl(): string {
  const base = getEnv().NEXT_PUBLIC_APP_URL.replace(/\/+$/, "");
  return `${base}/settings/plan/checkout/cancel`;
}

export interface CreateCheckoutSessionInput {
  readonly planCode: string;
  readonly billingInterval: BillingInterval;
}

export interface PlanCheckoutSession {
  readonly checkoutUrl: string;
}

interface AttemptWriteData {
  readonly organizationId: string;
  readonly environment: StripeEnvironment;
  readonly planCode: string;
  readonly billingInterval: BillingInterval;
  readonly stripeCheckoutSessionId: string;
  readonly stripeCustomerId: string;
  readonly idempotencyKey: string;
  readonly createdById: string;
  readonly expiresAt: Date;
}

async function persistCheckoutAttempt(data: AttemptWriteData) {
  const auditAfter = {
    planCode: data.planCode,
    billingInterval: data.billingInterval,
    environment: data.environment,
    stripeCheckoutSessionId: data.stripeCheckoutSessionId,
  };

  try {
    return await db.$transaction(async (tx) => {
      const row = await tx.organizationCheckoutAttempt.create({ data });
      await writeAuditLog(tx, {
        organizationId: data.organizationId,
        actorId: data.createdById,
        action: CHECKOUT_AUDIT_ACTION,
        entityType: "OrganizationCheckoutAttempt",
        entityId: data.organizationId,
        after: auditAfter,
      });
      return row;
    });
  } catch (err) {
    if ((err as { code?: string })?.code !== "P2002") throw err;

    // Yarış: organizasyonun satırı zaten var. Yalnızca AYNI plan/aralık/ortamı
    // taşıyorsa (kendi tekrarımız — hızlı çift tıklama), süresi dolmuşsa VEYA
    // FARKLI bir Stripe ortamına aitse (bkz. dosya başı not — bir dağıtımın
    // yalnızca TEK Stripe ortamı olabilir, bu yüzden başka bir ortama ait bir
    // satır operasyonel olarak anlamsızdır ve her zaman üzerine yazılabilir,
    // `OrganizationStripeCustomer`'ın `environment` sütunlu unique kısıtından
    // FARKLI olarak bu tablo `organizationId`'yi TEK birincil anahtar aldığı
    // için ortam karşılaştırması burada elle yapılır) üzerine yazılır; aksi
    // halde organizasyonun GERÇEKTEN farklı bir açık denemesi var demektir —
    // fail-closed reddedilir.
    const now = new Date();
    return db.$transaction(async (tx) => {
      const updated = await tx.organizationCheckoutAttempt.updateMany({
        where: {
          organizationId: data.organizationId,
          OR: [
            { expiresAt: { lt: now } },
            { environment: { not: data.environment } },
            { planCode: data.planCode, billingInterval: data.billingInterval, environment: data.environment },
          ],
        },
        data,
      });
      if (updated.count === 0) {
        throw conflict(
          "Devam eden başka bir ödeme işleminiz var. Lütfen önce onu tamamlayın ya da birkaç dakika içinde tekrar deneyin.",
        );
      }
      await writeAuditLog(tx, {
        organizationId: data.organizationId,
        actorId: data.createdById,
        action: CHECKOUT_AUDIT_ACTION,
        entityType: "OrganizationCheckoutAttempt",
        entityId: data.organizationId,
        after: auditAfter,
      });
      return tx.organizationCheckoutAttempt.findUniqueOrThrow({ where: { organizationId: data.organizationId } });
    });
  }
}

/**
 * Çağıranın organizasyonu için, seçilen kanonik plan + faturalama aralığında
 * bir Stripe Checkout Session (subscription modu) oluşturur ve barındırmalı
 * ödeme sayfasının URL'ini döner.
 *
 * **Bu fonksiyon ÇAĞRILMASI hiçbir yetenek/kota/plan KAZANDIRMAZ** — bkz.
 * dosya başı mimari sözleşme notu.
 */
export async function createPlanCheckoutSession(
  actor: SessionUser,
  input: CreateCheckoutSessionInput,
): Promise<PlanCheckoutSession> {
  if (!canManageOrganizationSettings(actor.role)) {
    throw forbidden("Yalnızca firma sahibi ödeme işlemi başlatabilir");
  }

  // İstemciden gelen ham girdi burada kanonik allowlist'e karşı doğrulanır —
  // bilinmeyen/kurcalanmış bir değer, ops-yapılandırma hatasından (aşağıdaki
  // BillingConfigError, ki o güvenli/genel bir mesaja düşer) AYRI olarak,
  // net bir kullanıcı hatası olarak reddedilir.
  if (!CANONICAL_BILLING_PLAN_CODES.includes(input.planCode)) {
    throw new ServiceError("Geçersiz plan kodu");
  }
  if (!BILLING_INTERVALS.includes(input.billingInterval)) {
    throw new ServiceError("Geçersiz faturalama aralığı");
  }

  // Fail-closed: yapılandırılmamış/tutarsız Stripe kurulumunda veya
  // yapılandırılmamış bir plan/aralık fiyatında burada BillingConfigError
  // fırlatılır (server action katmanı bunu genel, güvenli bir hataya çevirir
  // — bkz. lib/action-error.ts toActionError).
  const price = resolveStripePriceForPlan(input.planCode, input.billingInterval);
  if (price.kind === "CONTACT_SALES" || !price.priceId) {
    throw new ServiceError(
      "Bu plan için kendi kendine ödeme başlatılamaz. Lütfen satış ekibimizle iletişime geçin.",
    );
  }

  // OWNER-only + fail-closed yapılandırma kontrolü burada TEKRAR uygulanır
  // (bkz. server/services/billing/stripe-customer-service.ts) — istemciden
  // gelen hiçbir organizationId/Stripe kimliği kabul edilmez.
  const customer = await ensureOrganizationStripeCustomer(actor);

  const { environment } = getStripeConfig();
  const organizationId = actor.organizationId;
  const now = new Date();

  // Ön-kontrol: organizasyonun FARKLI bir plan/aralık için zaten açık bir
  // denemesi varsa, Stripe'a hiç gitmeden erken reddedilir (bkz. dosya başı
  // "Bilinen sınır" notu — bu, DB yazımındaki P2002-yakalama ile birlikte iki
  // katmanlı bir korumadır, tek başına mutlak değildir).
  const existingAttempt = await db.organizationCheckoutAttempt.findUnique({ where: { organizationId } });
  if (
    existingAttempt &&
    existingAttempt.environment === environment &&
    existingAttempt.expiresAt > now &&
    (existingAttempt.planCode !== input.planCode || existingAttempt.billingInterval !== input.billingInterval)
  ) {
    throw conflict(
      "Devam eden başka bir ödeme işleminiz var. Lütfen önce onu tamamlayın ya da birkaç dakika içinde tekrar deneyin.",
    );
  }

  const idempotencyKey = buildCheckoutIdempotencyKey(organizationId, environment, input.planCode, input.billingInterval);
  const gateway = resolveStripeGateway();

  const session = await gateway.createCheckoutSession({
    organizationId,
    customerId: customer.stripeCustomerId,
    priceId: price.priceId,
    planCode: input.planCode,
    billingInterval: input.billingInterval,
    successUrl: buildSuccessUrl(),
    cancelUrl: buildCancelUrl(),
    idempotencyKey,
    allowPromotionCodes: false,
  });

  await persistCheckoutAttempt({
    organizationId,
    environment,
    planCode: input.planCode,
    billingInterval: input.billingInterval,
    stripeCheckoutSessionId: session.id,
    stripeCustomerId: customer.stripeCustomerId,
    idempotencyKey,
    createdById: actor.id,
    expiresAt: new Date(session.expiresAt * 1000),
  });

  return { checkoutUrl: session.url };
}
