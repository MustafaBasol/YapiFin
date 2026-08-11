import type { StripeEnvironment } from "@prisma/client";
import { db } from "@/lib/db";

/**
 * YF-808/YF-815 — bir Stripe müşteri kimliğini kanonik
 * `OrganizationStripeCustomer` eşlemesi üzerinden organizasyona çözer.
 * Eşleme YOKSA `null` döner (hata FIRLATMAZ) — çağıran bunu fail-closed
 * "bu olayla ilgili bir eylemimiz yok" olarak ele alır.
 *
 * `server/services/billing/webhook-service.ts` (SUBSCRIPTION/INVOICE/
 * CHECKOUT_SESSION/REFUND — hepsi `customerId`'yi DOĞRUDAN webhook
 * payload'ından taşır) VE `dispute-service.ts` (Dispute nesnesi customer'ı
 * DOĞRUDAN taşımadığı için `retrieveDispute` SONRASI çağırır) arasında
 * PAYLAŞILAN TEK çözümleme noktasıdır — döngüsel bağımlılık oluşmasın diye
 * (webhook-service.ts dispute-service.ts'i çağırır) ayrı bir yaprak
 * (leaf) modülde tutulur.
 */
export async function resolveOrganizationForCustomer(
  stripeCustomerId: string,
  environment: StripeEnvironment,
): Promise<string | null> {
  const row = await db.organizationStripeCustomer.findUnique({
    where: { environment_stripeCustomerId: { environment, stripeCustomerId } },
    select: { organizationId: true },
  });
  return row?.organizationId ?? null;
}
