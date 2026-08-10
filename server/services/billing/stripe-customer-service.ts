import type { StripeEnvironment } from "@prisma/client";
import { db } from "@/lib/db";
import { writeAuditLog } from "@/lib/audit";
import { canManageOrganizationSettings, canViewOrganizationSettings } from "@/lib/permissions";
import { conflict, forbidden, notFound } from "@/server/services/errors";
import { BillingProviderError } from "@/lib/billing/errors";
import { getStripeConfig } from "@/lib/billing/stripe-config";
import { resolveStripeGateway } from "@/lib/billing/stripe-gateway";
import type { SessionUser } from "@/lib/auth/session";

/**
 * YF-808 — Organizasyon ↔ Stripe Customer eşlemesinin TEK servis noktası.
 *
 * ## Tenant izolasyonu
 *
 * `organizationId` **yalnızca** doğrulanmış oturumdan (`SessionUser`) türetilir.
 * Bu modüldeki hiçbir fonksiyon istemciden `organizationId`, Stripe Customer
 * ID, Product ID veya Price ID KABUL ETMEZ — bu yüzden fonksiyon imzaları
 * bilinçli olarak yalnızca `actor: SessionUser` alır (bkz.
 * tests/billing-stripe-customer.test.ts "istemci girdisi" bölümü).
 *
 * ## Yetki ile ilişkisi (YF-802 ayrımı)
 *
 * Bu servis bir Stripe müşterisi oluşturur/okur. Bu işlem hiçbir yetenek,
 * kota veya erişim HAKKI VERMEZ; `Organization.planId`'ye DOKUNMAZ. Uygulama
 * erişimi her zaman `lib/entitlements/entitlement-service.ts` (YF-802)
 * tarafından, yalnızca YapiFin `Plan` modelinden çözülür.
 *
 * ## Eşzamanlılık / idempotency
 *
 * İki katmanlı korumadır:
 *
 * 1. **Stripe tarafı:** deterministik idempotency anahtarı
 *    (`buildCustomerIdempotencyKey`) — aynı organizasyon+ortam için yapılan
 *    her `customers.create` çağrısı Stripe'ta AYNI müşteriyi döndürür,
 *    yeniden deneme/eşzamanlı istek ikinci bir müşteri OLUŞTURMAZ.
 * 2. **Veritabanı tarafı (doğruluk kaynağı):**
 *    `@@unique([organizationId, environment])`. "Bu organizasyonun müşterisi
 *    var mı" sorusunun cevabı her zaman budur; check-then-insert yarışı
 *    yoktur — P2002 yakalanır ve kazanan satır yeniden okunur (bkz.
 *    settlement-service.ts / provider-lifecycle-service.ts aynı desen).
 */

/**
 * Deterministik ve çarpışmasız: aynı organizasyon + aynı Stripe ortamı her
 * zaman aynı anahtarı üretir; farklı ortamlar ise ASLA aynı anahtarı
 * paylaşmaz (test/live karışmasının engellenmesi). Stripe idempotency
 * anahtarları 255 karakterle sınırlıdır — cuid tabanlı `organizationId` ile
 * bu sınırın çok altında kalınır.
 */
export function buildCustomerIdempotencyKey(organizationId: string, environment: StripeEnvironment): string {
  return `yapifin:${environment.toLowerCase()}:customer:${organizationId}`;
}

export interface OrganizationStripeCustomerMapping {
  readonly organizationId: string;
  readonly environment: StripeEnvironment;
  readonly stripeCustomerId: string;
  /** Bu çağrıda yeni oluşturulduysa `true`; mevcut eşleme yeniden kullanıldıysa `false`. */
  readonly created: boolean;
}

function toMapping(
  row: { organizationId: string; environment: StripeEnvironment; stripeCustomerId: string },
  created: boolean,
): OrganizationStripeCustomerMapping {
  return Object.freeze({
    organizationId: row.organizationId,
    environment: row.environment,
    stripeCustomerId: row.stripeCustomerId,
    created,
  });
}

function findMapping(organizationId: string, environment: StripeEnvironment) {
  return db.organizationStripeCustomer.findUnique({
    where: { organizationId_environment: { organizationId, environment } },
    select: { organizationId: true, environment: true, stripeCustomerId: true },
  });
}

/**
 * Çağıranın KENDİ organizasyonu için geçerli Stripe ortamındaki eşlemeyi
 * okur; yoksa `null` döner. Başka bir organizasyonun eşlemesine erişmenin
 * hiçbir yolu yoktur (sorgu her zaman oturumdaki `organizationId` ile
 * scope edilir).
 */
export async function getOrganizationStripeCustomer(
  actor: SessionUser,
): Promise<OrganizationStripeCustomerMapping | null> {
  if (!canViewOrganizationSettings(actor.role)) throw forbidden();

  const { environment } = getStripeConfig();
  const row = await findMapping(actor.organizationId, environment);
  return row ? toMapping(row, false) : null;
}

/**
 * Çağıranın organizasyonu için Stripe müşterisini **oluştur-veya-yeniden-kullan**.
 * Tekrar çağrılması güvenlidir ve ikinci bir Stripe müşterisi üretmez.
 *
 * Yetki: yalnızca OWNER (`canManageOrganizationSettings`) — organizasyonun
 * ödeme sağlayıcısı kimliğini oluşturmak, mevcut "organizasyon ayarlarını
 * yönetme" sınırıyla aynı seviyededir. ADMIN yalnızca okuyabilir
 * (`getOrganizationStripeCustomer`).
 */
export async function ensureOrganizationStripeCustomer(
  actor: SessionUser,
): Promise<OrganizationStripeCustomerMapping> {
  if (!canManageOrganizationSettings(actor.role)) throw forbidden();

  // Fail-closed: Stripe yapılandırılmamış/tutarsızsa burada BillingConfigError
  // ile durulur — sessizce devam edilmez.
  const { environment } = getStripeConfig();
  // İstemciden ASLA alınmaz.
  const organizationId = actor.organizationId;

  const existing = await findMapping(organizationId, environment);
  if (existing) return toMapping(existing, false);

  const organization = await db.organization.findUnique({
    where: { id: organizationId },
    select: { id: true, name: true, tradeName: true, email: true },
  });
  if (!organization) throw notFound("Organizasyon bulunamadı");

  const idempotencyKey = buildCustomerIdempotencyKey(organizationId, environment);
  const gateway = resolveStripeGateway();

  let customer;
  try {
    customer = await gateway.createCustomer({
      organizationId,
      name: organization.tradeName ?? organization.name,
      email: organization.email ?? null,
      idempotencyKey,
    });
  } catch (err) {
    // Eşzamanlı ikinci bir istek aynı anahtarla Stripe'ta hâlâ uçuşta olabilir.
    // Bu durumda kazanan istek satırı yazmış olabilir — önce onu arıyoruz.
    if (err instanceof BillingProviderError && err.category === "IDEMPOTENCY_CONFLICT") {
      const raced = await findMapping(organizationId, environment);
      if (raced) return toMapping(raced, false);
      throw conflict(
        "Faturalama kaydı şu anda başka bir istek tarafından oluşturuluyor, lütfen birazdan tekrar deneyin",
      );
    }
    throw err;
  }

  try {
    const row = await db.$transaction(async (tx) => {
      const created = await tx.organizationStripeCustomer.create({
        data: {
          organizationId,
          environment,
          stripeCustomerId: customer.id,
          idempotencyKey,
          createdById: actor.id,
        },
        select: { id: true, organizationId: true, environment: true, stripeCustomerId: true },
      });
      await writeAuditLog(tx, {
        organizationId,
        actorId: actor.id,
        action: "billing.stripe_customer.create",
        entityType: "OrganizationStripeCustomer",
        entityId: created.id,
        // Yalnızca sır OLMAYAN, kısa tanımlayıcılar — gizli anahtar/webhook
        // sırrı hiçbir zaman audit log'a yazılmaz.
        after: { environment, stripeCustomerId: created.stripeCustomerId },
      });
      return created;
    });
    return toMapping(row, true);
  } catch (err) {
    if ((err as { code?: string })?.code === "P2002") {
      // Yarışı başka bir istek kazandı: Stripe idempotency anahtarı aynı
      // olduğu için o istek de AYNI müşteriyi yazmıştır — mükerrer müşteri
      // oluşmaz.
      const raced = await findMapping(organizationId, environment);
      if (raced) return toMapping(raced, false);
      // Buraya düşmek, aynı Stripe müşterisinin BAŞKA bir organizasyona
      // bağlı olduğu anlamına gelir (`@@unique([environment, stripeCustomerId])`)
      // — fail-closed reddedilir, asla başka tenant'ın kaydı döndürülmez.
      throw conflict("Bu Stripe müşterisi başka bir organizasyona bağlı");
    }
    throw err;
  }
}
