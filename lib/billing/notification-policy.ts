import type { Prisma, PrismaClient } from "@prisma/client";
import { getEnv } from "@/lib/env";
import { BillingConfigError } from "@/lib/billing/errors";

/**
 * YF-821 — dunning/grace-period (YF-814) e-posta bildirimlerinin ürün
 * politikası: hatırlatma penceresi + alıcı çözümlemesi.
 *
 * `lib/billing/dunning-policy.ts` `GRACE_PERIOD_DURATION_DAYS` İLE AYNI ilke:
 * mevcut bir iş kuralı bulunmadığından makul bir varsayılan seçildi ve TEK,
 * açıkça belgelenmiş bir sabit olarak burada merkezileştirildi (görev
 * talimatı "choose a sensible product default... and centralize the value
 * and document it as product policy"). Değiştirilmesi gerekirse TEK
 * değişiklik noktası burasıdır.
 */
export const GRACE_REMINDER_HOURS_BEFORE_EXPIRY = 48;
const GRACE_REMINDER_WINDOW_MS = GRACE_REMINDER_HOURS_BEFORE_EXPIRY * 60 * 60 * 1000;

type Client = PrismaClient | Prisma.TransactionClient;

/**
 * `gracePeriodEndsAt` şu andan itibaren hatırlatma penceresi İÇİNDE mi
 * (henüz dolmamış AMA `GRACE_REMINDER_HOURS_BEFORE_EXPIRY` içinde) — saf
 * (pure), `lib/billing/dunning-policy.ts` `computePaymentFailureState` İLE
 * AYNI "mutlak zaman damgasını çağrı anındaki saatle karşılaştır" ilkesi
 * (hiçbir önbelleğe alınmış durum yok, deterministik test edilebilir).
 */
export function isWithinGraceReminderWindow(gracePeriodEndsAt: Date, now: Date): boolean {
  const msRemaining = gracePeriodEndsAt.getTime() - now.getTime();
  return msRemaining > 0 && msRemaining <= GRACE_REMINDER_WINDOW_MS;
}

let cachedSweepSecret: string | null = null;

/**
 * `lib/billing/stripe-config.ts` `getStripeWebhookSecret` İLE AYNI
 * fail-closed felsefesi: yalnızca sweep route'u ÇAĞRILDIĞINDA değerlendirilir
 * (uygulama başlangıcını/ilgisiz route'ları ETKİLEMEZ). Eksikse
 * `BillingConfigError` fırlatır — route bunu asla sessizce atlamaz (bkz.
 * app/api/internal/billing/dunning-sweep/route.ts).
 */
export function getBillingSweepSecret(): string {
  if (cachedSweepSecret) return cachedSweepSecret;
  const secret = getEnv().billingSweepSecret;
  if (!secret) {
    throw new BillingConfigError("BILLING_SWEEP_SECRET yapılandırılmamış — dunning sweep uç noktası kullanılamaz.");
  }
  cachedSweepSecret = secret;
  return cachedSweepSecret;
}

/** Yalnızca testler için — `lib/billing/stripe-config.ts` `resetStripeConfigCacheForTests` İLE AYNI desen. Uygulama kod yolunun hiçbir yerinden çağrılmaz. */
export function resetBillingSweepSecretCacheForTests(): void {
  cachedSweepSecret = null;
}

export interface BillingNotificationRecipient {
  readonly userId: string;
  readonly email: string;
  readonly firstName: string;
}

/**
 * Faturalama bildirimlerinin alıcılarını SUNUCU tarafında, organizasyondan
 * çözer — istemciden hiçbir e-posta adresi ASLA kabul edilmez (görev
 * talimatı "Resolve recipients server-side... Do not accept arbitrary email
 * addresses from browser input"). Politika: yalnızca AKTİF OWNER rolündeki
 * kullanıcılar — mevcut mimaride TÜM faturalama mutasyonları
 * (`lib/permissions.ts` `canManageOrganizationSettings`) zaten SADECE OWNER'a
 * açıktır (Customer Portal oturumu açma, abonelik mutabakatı, vb.) — bu
 * bildirim alıcı sınırı, o KURULU yetki sınırıyla BİREBİR aynı hizadadır; yeni
 * bir "faturalama yetkilisi" rolü İCAT EDİLMEZ (görev talimatı "optionally
 * other explicitly billing-authorized admin roles only if existing
 * architecture supports it" — desteklemiyor, bu yüzden eklenmedi). E-posta
 * büyük/küçük harf duyarsız tekilleştirilir (aynı adres farklı büyük/küçük
 * harfle iki kez KAYITLI olsa bile tek bildirim alır).
 */
export async function resolveBillingNotificationRecipients(
  client: Client,
  organizationId: string,
): Promise<readonly BillingNotificationRecipient[]> {
  const owners = await client.user.findMany({
    where: { organizationId, role: "OWNER", status: "ACTIVE" },
    select: { id: true, email: true, firstName: true },
    orderBy: { createdAt: "asc" },
  });

  const seen = new Set<string>();
  const recipients: BillingNotificationRecipient[] = [];
  for (const owner of owners) {
    const key = owner.email.trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    recipients.push({ userId: owner.id, email: owner.email, firstName: owner.firstName });
  }
  return recipients;
}
