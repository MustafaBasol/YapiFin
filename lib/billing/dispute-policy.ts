import type { Prisma, PrismaClient } from "@prisma/client";

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
 * riski kısıtlaması entitlement çekirdeğine YAZILMAZ.
 *
 * ## YF-814 — kompozisyon
 *
 * Bu dosya artık YALNIZCA uyuşmazlık (dispute) sinyalini taşır
 * (`hasActiveDisputeRestriction`). Ücretli kaynak OLUŞTURAN servisler
 * (aşağıdaki liste) bu dosyayı ARTIK DOĞRUDAN İTHAL ETMEZ — bunun yerine
 * `lib/billing/billing-restriction-policy.ts` `assertNotBillingRestricted`'i
 * çağırır; o dosya bu sinyali YF-814'ün `lib/billing/dunning-policy.ts`
 * `hasActiveDunningRestriction`'ı İLE KOMPOZE eder (görev talimatı "Compose
 * policies safely rather than creating conflicting gates... effective
 * billing restriction should account for both delinquency/grace policy and
 * dispute policy"). Merkezi TEK politika kaynağı hâlâ BURASI + dunning-policy.ts'tir,
 * yalnızca uygulama noktası (`billing-restriction-policy.ts`) bir katman
 * eklenmiştir:
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
 * YF-815 — bir organizasyonun GÜNCEL uyuşmazlık kaynaklı faturalama
 * kısıtlaması olup olmadığını CANLI sorgular — `Organization`/
 * `OrganizationStripeCustomer` üzerinde denormalize bir "risk" alanı İCAT
 * EDİLMEZ (bkz. `checkLimit`/`getEffectivePlan` ile AYNI ilke: her çağrı
 * güncel durumu DB'den taze okur, hiçbir yerde önbelleğe alınmaz — plan/risk
 * değişikliği anında yansımalıdır).
 */
export async function hasActiveDisputeRestriction(client: Client, organizationId: string): Promise<boolean> {
  if (!DISPUTE_LOST_RESTRICTS_BILLING) return false;
  const count = await client.stripeDispute.count({
    where: { organizationId, riskState: "RESTRICTED" },
  });
  return count > 0;
}

export const DISPUTE_RESTRICTION_MESSAGE =
  "Faturalama hesabınızda çözülmemiş bir ödeme itirazı (chargeback) nedeniyle bu işlem geçici olarak kısıtlandı. Lütfen destek ekibiyle iletişime geçin.";
