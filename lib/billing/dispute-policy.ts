import type { Prisma, PrismaClient } from "@prisma/client";
import { forbidden } from "@/server/services/errors";

/**
 * YF-815 — bir Stripe uyuşmazlığının (dispute/chargeback) kaybedilmesinin
 * organizasyonun yeni ücretli özellik oluşturma/tüketimini kısıtlayıp
 * kısıtlamayacağına dair TEK politika anahtarı. Görev talimatı "access
 * restriction should be deliberate and configurable" — uydurma bir
 * feature-flag sistemi İCAT EDİLMEZ (bkz. mimari ilke "avoid
 * overengineering"), yalnızca TEK, açıkça belgelenmiş bir sabit
 * kullanılır. `false` yapılırsa hiçbir `StripeDispute` satırı erişim
 * kararını ETKİLEMEZ (yalnızca gözlemlenebilirlik/denetim amaçlı kalır).
 *
 * ## Neden `lib/entitlements/entitlement-service.ts` içinde DEĞİL
 *
 * `tests/billing-stripe-customer.test.ts` "entitlement servisi Stripe
 * modüllerine bağımlı DEĞİLDİR (tek yönlü bağımlılık)" testi,
 * `entitlement-service.ts`/`capabilities.ts` kaynak metninde `"stripe"`/
 * `"billing"` dizgisinin HİÇ geçmediğini KANITLAR (mimari ilke: entitlement
 * çekirdeği yalnızca YapiFin'in kendi `Plan` modelini bilir, hangi ödeme
 * sağlayıcısının kullanıldığından TAMAMEN BAĞIMSIZDIR). Bu yüzden faturalama
 * riski kısıtlaması entitlement çekirdeğine YAZILMAZ — bunun yerine bu dosya,
 * `assertCapability`/`assertWithinLimit*`i SARMALAYAN (wrap eden) `assertNotBillingRestricted`
 * fonksiyonunu dışa açar; ücretli kaynak OLUŞTURAN küçük, sabit bir servis
 * kümesi (bkz. aşağıdaki liste) bunu KENDİ assert çağrısından HEMEN ÖNCE
 * çağırır — merkezi TEK politika kaynağı yine BURASIDIR (görev talimatı
 * "reuse centralized entitlement checks... do not create ad-hoc UI-only
 * blocking"), yalnızca uygulama noktası (entitlement-service.ts DEĞİL,
 * çağıran servisler) farklıdır:
 *
 * - server/services/project-service.ts `createProject`
 * - server/services/invitation-service.ts `acceptInvitation`
 * - server/services/document-extraction-service.ts `uploadAndExtractDocument`
 * - server/services/bank-import-service.ts (banka içe aktarım başlatma)
 */
export const DISPUTE_LOST_RESTRICTS_BILLING = true;

type Tx = Prisma.TransactionClient;
type Client = PrismaClient | Tx;

/**
 * YF-815 — bir organizasyonun GÜNCEL faturalama kısıtlaması olup olmadığını
 * CANLI sorgular — `Organization`/`OrganizationStripeCustomer` üzerinde
 * denormalize bir "risk" alanı İCAT EDİLMEZ (bkz. `checkLimit`/
 * `getEffectivePlan` ile AYNI ilke: her çağrı güncel durumu DB'den taze
 * okur, hiçbir yerde önbelleğe alınmaz — plan/risk değişikliği anında
 * yansımalıdır).
 */
export async function hasActiveBillingRestriction(client: Client, organizationId: string): Promise<boolean> {
  if (!DISPUTE_LOST_RESTRICTS_BILLING) return false;
  const count = await client.stripeDispute.count({
    where: { organizationId, riskState: "RESTRICTED" },
  });
  return count > 0;
}

export const BILLING_RESTRICTION_MESSAGE =
  "Faturalama hesabınızda çözülmemiş bir ödeme itirazı (chargeback) nedeniyle bu işlem geçici olarak kısıtlandı. Lütfen destek ekibiyle iletişime geçin.";

/**
 * Kısıtlıysa Türkçe, kullanıcıya gösterilebilir bir `ServiceError`
 * (`FORBIDDEN`) fırlatır — `lib/entitlements/entitlement-service.ts`
 * `assertCapability`/`assertWithinLimit`in dosya başı "no-op ise" felsefesiyle
 * AYNI: yalnızca YENİ ücretli kaynak OLUŞTURAN çağrı noktalarında, o
 * çağrının KENDİ `assertCapability`/`assertWithinLimit*` çağrısından HEMEN
 * ÖNCE kullanılmalıdır — salt-okunur (`checkCapability`/`checkLimit`) yollar
 * ASLA çağırmamalıdır (görev talimatı "preserve read access, block only
 * paid-feature creation/consumption").
 */
export async function assertNotBillingRestricted(client: Client, organizationId: string): Promise<void> {
  if (await hasActiveBillingRestriction(client, organizationId)) {
    throw forbidden(BILLING_RESTRICTION_MESSAGE);
  }
}
