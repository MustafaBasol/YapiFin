import type { StripeEnvironment } from "@prisma/client";
import { db } from "@/lib/db";
import { writeAuditLog } from "@/lib/audit";
import { canManageOrganizationSettings } from "@/lib/permissions";
import { conflict, forbidden, ServiceError } from "@/server/services/errors";
import { getEnv } from "@/lib/env";
import { lockOrganizationForEntitlement } from "@/lib/entitlements/entitlement-service";
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
 * ## Mükerrer deneme / idempotency / eşzamanlılık (YF-809 hotfix)
 *
 * Üç katmanlıdır:
 *
 * 1. **Organizasyon satır kilidi (atomik, Stripe'a gidilmeden ÖNCE):**
 *    `reserveCheckoutAttempt` çağrısı, `lockOrganizationForEntitlement` ile
 *    AYNI `SELECT ... FOR UPDATE` desenini kullanarak (bkz.
 *    server/services/ai-usage-reporting-service.ts checkQuota) organizasyon
 *    satırını kilitler ve BU KİLİT ALTINDA `OrganizationCheckoutAttempt`
 *    satırını `RESERVED` durumuna yazar. Bir organizasyon için TÜM eşzamanlı
 *    çağrılar bu kilitte SIRAYLA işlenir — Stripe'a gidip gitmeyeceği kararı
 *    her zaman en güncel, tutarlı DB durumuna göre verilir. FARKLI bir
 *    plan/aralık için hâlâ aktif (süresi dolmamış) bir rezervasyon/deneme
 *    varsa istek burada, Stripe'a HİÇ gidilmeden `CONFLICT` ile reddedilir.
 * 2. **Stripe tarafı:** deterministik idempotency anahtarı
 *    (`buildCheckoutIdempotencyKey` — organizasyon+ortam+plan+aralık'tan
 *    türetilir). AYNI niyetli eşzamanlı/art arda istekler (rezervasyon
 *    devralınarak) gateway'e AYNI anahtarla gider; Stripe AYNI Checkout
 *    Session'ı döner, ikinci bir oturum OLUŞTURMAZ. Anahtar zaman bileşeni
 *    TAŞIMAZ; bu kasıtlıdır — Stripe'ın idempotency önbelleği ve Checkout
 *    Session'ın kendi süresi (`expires_at`) her ikisi de ~24 saatte dolar, bu
 *    yüzden satır BAYATLADIĞINDA (bkz. `expiresAt`) AYNI anahtarla yeni bir
 *    istek Stripe'ta güvenle YENİ bir oturum üretir.
 * 3. **Commit/release "fencing" (Stripe yanıtından SONRA):** gateway çağrısı
 *    transaction DIŞINDA (kilit tutulmadan) yapılır; dönüşte
 *    `commitCheckoutAttempt`/`releaseCheckoutAttempt`, rezervasyonu HÂLÂ
 *    kendisinin sahip olduğunu `attemptCount` eşleşmesiyle doğrular (bkz.
 *    `AiUsageLedger` row-identity guard AYNI deseni) — geç kalan bir yanıt,
 *    o sırada devralınmış YENİ bir rezervasyonu asla ezmez.
 *
 * **Sağlayıcı hatası / çökme kurtarma:** gateway çağrısı başarısız olursa
 * rezervasyon HEMEN serbest bırakılır (bkz. `releaseCheckoutAttempt`) —
 * organizasyon kalıcı olarak engellenmez. Süreç, rezervasyon ile Stripe
 * yanıtı arasında ÇÖKERSE (ne commit ne release çalışır), satır `RESERVED`
 * kalır; `reservationExpiresAt` (bkz. `CHECKOUT_RESERVATION_TTL_MS`) bounded
 * bir TTL sonra bayat sayılır ve bir SONRAKİ istek (AYNI veya FARKLI
 * plan/aralık için) satırı güvenle devralır.
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

/**
 * Bir `RESERVED` rezervasyonun, Stripe yanıtı beklenirken çökme durumunda
 * dahi sonsuza dek organizasyonu ENGELLEMEMESİ için bounded kurtarma
 * penceresi. Tipik bir Stripe çağrısı saniyeler sürer (bkz.
 * lib/billing/stripe-gateway.ts `REQUEST_TIMEOUT_MS` = 15sn) — 2 dakika bu
 * süreye bolca pay bırakır, ama bir süreç çökmesini sonsuza dek AÇIK
 * bırakmaz.
 */
export const CHECKOUT_RESERVATION_TTL_MS = 2 * 60 * 1000;

/**
 * 3+ eşzamanlı istek AYNI organizasyon/rezervasyon satırını kilitlemeye
 * (`FOR UPDATE` veya eşzamanlı `UPDATE`) çalıştığında, PostgreSQL'in
 * multixact bekleme kuyruğu nadiren gerçek bir deadlock (`40P01`) rapor
 * edebilir — bu, satır kilidi + ardından yazma deseninin BİLİNEN, beklenen
 * bir PostgreSQL davranışıdır (bkz. server/services/ai-usage-reporting-service.ts
 * `SERIALIZATION_CONFLICT_MAX_ATTEMPTS` AYNI kurtarma deseni — orada
 * `Serializable` izolasyonun `40001` yazma çakışması için, burada varsayılan
 * izolasyonun satır kilidi kuyruğunun `40P01` deadlock'u için). Kaybeden
 * taraf burada sınırlı sayıda YENİDEN DENER — her deneme YENİ, tamamen taze
 * bir transaction'dır ve mevcut (artık güncel) durumu doğru okur.
 */
const LOCK_CONFLICT_MAX_ATTEMPTS = 5;

function isTransientLockConflict(err: unknown): boolean {
  let current: unknown = err;
  for (let hop = 0; hop < 5 && current; hop++) {
    const code = (current as { code?: string } | null)?.code;
    if (code === "P2034") return true;
    const metaCode = (current as { meta?: { code?: string } } | null)?.meta?.code;
    if (metaCode === "40P01" || metaCode === "40001") return true;
    const message = current instanceof Error ? current.message : "";
    if (message.includes("deadlock detected") || message.includes("could not serialize access")) return true;
    current = current instanceof Error ? (current as Error & { cause?: unknown }).cause : undefined;
  }
  return false;
}

async function withLockConflictRetry<T>(fn: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (isTransientLockConflict(err) && attempt < LOCK_CONFLICT_MAX_ATTEMPTS) continue;
      throw err;
    }
  }
}

interface ReserveInput {
  readonly organizationId: string;
  readonly environment: StripeEnvironment;
  readonly planCode: string;
  readonly billingInterval: BillingInterval;
  readonly idempotencyKey: string;
  readonly stripeCustomerId: string;
  readonly createdById: string;
}

interface ReserveResult {
  readonly attemptCount: number;
}

/**
 * Stripe'a gidilmeden ÖNCE, organizasyon satır kilidi altında ATOMİK olarak
 * bir `RESERVED` deneme ayırır (bkz. dosya başı "Eşzamanlılık" notu). Yalnızca
 * FARKLI bir plan/aralık için hâlâ aktif bir deneme varsa `CONFLICT` fırlatır
 * — bu her zaman gateway çağrısından önce olur, hiçbir Stripe isteği
 * göndermeden.
 */
async function reserveCheckoutAttempt(input: ReserveInput): Promise<ReserveResult> {
  return withLockConflictRetry(() => runReservationTransaction(input));
}

async function runReservationTransaction(input: ReserveInput): Promise<ReserveResult> {
  const { organizationId, environment, planCode, billingInterval, idempotencyKey, stripeCustomerId, createdById } = input;

  return db.$transaction(async (tx) => {
    // Bu organizasyon için TÜM eşzamanlı checkout rezervasyon denemelerini
    // serileştirir (bkz. lib/entitlements/entitlement-service.ts
    // lockOrganizationForEntitlement, AYNI desen ai-usage-reporting-service.ts
    // checkQuota ile) — kilit serbest kalana kadar hiçbir rakip transaction bu
    // organizasyon için karar veremez.
    await lockOrganizationForEntitlement(tx, organizationId);

    const now = new Date();
    const existing = await tx.organizationCheckoutAttempt.findUnique({ where: { organizationId } });

    if (existing) {
      const sameEnvironment = existing.environment === environment;
      const sameIntent = sameEnvironment && existing.idempotencyKey === idempotencyKey;
      const stillActive =
        existing.status === "RESERVED"
          ? existing.reservationExpiresAt > now
          : existing.expiresAt !== null && existing.expiresAt > now;

      if (!sameIntent && sameEnvironment && stillActive) {
        // FARKLI plan/aralık için hâlâ aktif bir deneme var — fail-closed
        // reddedilir, Stripe'a HİÇ gidilmez.
        throw conflict(
          "Devam eden başka bir ödeme işleminiz var. Lütfen önce onu tamamlayın ya da birkaç dakika içinde tekrar deneyin.",
        );
      }
      // Aksi halde: AYNI niyet (hızlı çift tıklama/tekrar — bkz. sameIntent),
      // bayat (süresi dolmuş) rezervasyon/deneme VEYA FARKLI bir Stripe
      // ortamına ait bayat satır (bir dağıtımın tek ortamı olabilir) — satır
      // güvenle devralınır. `attemptCount` aşağıdaki commit/release adımının
      // "fencing" anahtarıdır.
    }

    const attemptCount = (existing?.attemptCount ?? 0) + 1;
    const reservationExpiresAt = new Date(now.getTime() + CHECKOUT_RESERVATION_TTL_MS);

    await tx.organizationCheckoutAttempt.upsert({
      where: { organizationId },
      create: {
        organizationId,
        environment,
        planCode,
        billingInterval,
        status: "RESERVED",
        stripeCustomerId,
        idempotencyKey,
        createdById,
        attemptCount,
        reservationExpiresAt,
      },
      update: {
        environment,
        planCode,
        billingInterval,
        status: "RESERVED",
        stripeCustomerId,
        idempotencyKey,
        createdById,
        attemptCount,
        reservationExpiresAt,
        stripeCheckoutSessionId: null,
        expiresAt: null,
      },
    });

    return { attemptCount };
  });
}

interface CommitInput {
  readonly organizationId: string;
  readonly attemptCount: number;
  readonly planCode: string;
  readonly billingInterval: BillingInterval;
  readonly environment: StripeEnvironment;
  readonly stripeCheckoutSessionId: string;
  readonly expiresAt: Date;
  readonly createdById: string;
}

/**
 * Stripe başarıyla yanıt verdikten SONRA rezervasyonu `COMPLETED`'e taşır.
 * `attemptCount` eşleşmezse (satır başka bir deneme tarafından zaten
 * devralınmış/geri kazanılmıştır) sessizce atlar — bkz. dosya başı "fencing"
 * notu ve server/services/ai-usage-reporting-service.ts
 * `warnFinalizationSuperseded` AYNI deseni. Bu durumda dahi Stripe'ın
 * döndürdüğü URL çağırana doğru şekilde döner; yalnızca bu DB yazımı atlanır.
 */
async function commitCheckoutAttempt(input: CommitInput): Promise<void> {
  const { organizationId, attemptCount, planCode, billingInterval, environment, stripeCheckoutSessionId, expiresAt, createdById } =
    input;

  await withLockConflictRetry(() =>
    db.$transaction(async (tx) => {
      const result = await tx.organizationCheckoutAttempt.updateMany({
        where: { organizationId, attemptCount, status: "RESERVED" },
        data: { status: "COMPLETED", stripeCheckoutSessionId, expiresAt },
      });
      if (result.count === 0) {
        console.warn(
          JSON.stringify({
            level: "warn",
            event: "billing.checkout.commit_skipped_superseded",
            organizationId,
            attemptCount,
            stripeCheckoutSessionId,
          }),
        );
        return;
      }
      await writeAuditLog(tx, {
        organizationId,
        actorId: createdById,
        action: CHECKOUT_AUDIT_ACTION,
        entityType: "OrganizationCheckoutAttempt",
        entityId: organizationId,
        after: { planCode, billingInterval, environment, stripeCheckoutSessionId },
      });
    }),
  );
}

/**
 * Stripe çağrısı BAŞARISIZ olduğunda rezervasyonu serbest bırakır —
 * organizasyon kalıcı olarak engellenmez (bkz. dosya başı "Sağlayıcı hatası"
 * notu). `attemptCount` fencing'i burada da geçerlidir: geç kalan bir hata
 * yanıtı, o sırada devralınmış YENİ bir rezervasyonu asla siler.
 */
async function releaseCheckoutAttempt(organizationId: string, attemptCount: number): Promise<void> {
  await withLockConflictRetry(() =>
    db.organizationCheckoutAttempt.deleteMany({
      where: { organizationId, attemptCount, status: "RESERVED" },
    }),
  );
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
  const idempotencyKey = buildCheckoutIdempotencyKey(organizationId, environment, input.planCode, input.billingInterval);

  // Atomik rezervasyon: organizasyonun FARKLI bir plan/aralık için zaten
  // aktif bir denemesi varsa, Stripe'a HİÇ gidilmeden burada `CONFLICT` ile
  // reddedilir (bkz. dosya başı "Eşzamanlılık" notu — organizasyon satır
  // kilidi altında atomik karar, check-then-insert yarışı YOKTUR).
  const { attemptCount } = await reserveCheckoutAttempt({
    organizationId,
    environment,
    planCode: input.planCode,
    billingInterval: input.billingInterval,
    idempotencyKey,
    stripeCustomerId: customer.stripeCustomerId,
    createdById: actor.id,
  });

  const gateway = resolveStripeGateway();
  let session;
  try {
    session = await gateway.createCheckoutSession({
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
  } catch (err) {
    // Sağlayıcı çağrısı başarısız oldu — rezervasyon HEMEN serbest bırakılır
    // ki organizasyon kalıcı olarak engellenmesin (bkz. dosya başı "Sağlayıcı
    // hatası / çökme kurtarma" notu).
    await releaseCheckoutAttempt(organizationId, attemptCount);
    throw err;
  }

  await commitCheckoutAttempt({
    organizationId,
    attemptCount,
    planCode: input.planCode,
    billingInterval: input.billingInterval,
    environment,
    stripeCheckoutSessionId: session.id,
    expiresAt: new Date(session.expiresAt * 1000),
    createdById: actor.id,
  });

  return { checkoutUrl: session.url };
}
