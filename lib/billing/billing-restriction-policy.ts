import type { Prisma, PrismaClient } from "@prisma/client";
import { forbidden } from "@/server/services/errors";
import { hasActiveDisputeRestriction, DISPUTE_RESTRICTION_MESSAGE } from "@/lib/billing/dispute-policy";
import { hasActiveDunningRestriction, DUNNING_RESTRICTION_MESSAGE } from "@/lib/billing/dunning-policy";

/**
 * YF-814 — TEK, KOMPOZE faturalama kısıtlama kapısı. `lib/billing/dispute-policy.ts`
 * (YF-815) ve `lib/billing/dunning-policy.ts` (YF-814) BAĞIMSIZ birer sinyal
 * kaynağıdır; hiçbiri diğerini ZAYIFLATMAZ — İKİSİNDEN HERHANGİ BİRİ
 * kısıtlıyorsa organizasyon kısıtlıdır (görev talimatı "The effective
 * billing restriction should account for both: delinquency/grace policy,
 * dispute policy. Do not weaken either unintentionally"). Bu, YF-815'in
 * `assertNotBillingRestricted`'in ARTIK BURADAN dışa açıldığı TEK dosyadır —
 * ücretli kaynak OLUŞTURAN servisler (aşağıdaki liste) İTHALATLARINI bu
 * dosyaya taşır, KENDİ çağrı sırası/konumu DEĞİŞMEZ:
 *
 * - server/services/project-service.ts `createProject`
 * - server/services/invitation-service.ts `acceptInvitation`
 * - server/services/document-extraction-service.ts `uploadAndExtractDocument`
 * - server/services/bank-import-service.ts (banka içe aktarım başlatma)
 *
 * Salt-okunur (`checkCapability`/`checkLimit`) yollar ASLA çağırmamalıdır —
 * mevcut verileriniz/raporlarınız her iki politika altında da HER ZAMAN
 * erişilebilir kalır (bkz. her iki alt-politikanın kendi dosya başı notu).
 */
type Tx = Prisma.TransactionClient;
type Client = PrismaClient | Tx;

export async function hasActiveBillingRestriction(client: Client, organizationId: string): Promise<boolean> {
  return (
    (await hasActiveDunningRestriction(client, organizationId)) ||
    (await hasActiveDisputeRestriction(client, organizationId))
  );
}

/**
 * Kısıtlıysa Türkçe, kullanıcıya gösterilebilir bir `ServiceError`
 * (`FORBIDDEN`) fırlatır — yalnızca YENİ ücretli kaynak OLUŞTURAN çağrı
 * noktalarında, o çağrının KENDİ `assertCapability`/`assertWithinLimit*`
 * çağrısından HEMEN ÖNCE kullanılmalıdır (bkz. dosya başı not). Dunning
 * (ödeme gecikmesi) önce kontrol edilir — iki politika da AKTİFSE kullanıcıya
 * en TEMEL/ilk nedeni gösterir; her iki durumda da salt bir "kısıtlı"
 * mesajından FAZLASI değildir, hiçbir erişim KARARI bu sıralamadan
 * ETKİLENMEZ (her iki alt-fonksiyon da BAĞIMSIZ ve İDEMPOTENTTİR).
 */
export async function assertNotBillingRestricted(client: Client, organizationId: string): Promise<void> {
  if (await hasActiveDunningRestriction(client, organizationId)) {
    throw forbidden(DUNNING_RESTRICTION_MESSAGE);
  }
  if (await hasActiveDisputeRestriction(client, organizationId)) {
    throw forbidden(DISPUTE_RESTRICTION_MESSAGE);
  }
}
