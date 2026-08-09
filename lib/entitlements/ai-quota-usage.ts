import type { Prisma, PrismaClient } from "@prisma/client";
import { getAiQuotaPeriodStart } from "@/lib/ai/quota-period";

/**
 * YF-711 — AI kota kullanım defterinin (AiUsageLedger) TEK okuma kaynağı.
 * Kasıtlı olarak `lib/entitlements/entitlement-service.ts`'e bağımlı DEĞİLDİR
 * (import etmez) — bu, iki yönlü bir bağımlılık döngüsü oluşturmadan hem
 * `entitlement-service.ts`'in genel `countUsage` anahtarından HEM DE
 * `server/services/ai-usage-reporting-service.ts`'in atomik rezervasyon
 * işleminden aynı "kullanım" tanımını çağırabilmesini sağlar (bkz. görev
 * talimatı "Prefer: generic entitlement service supplies configured limit;
 * AI quota service owns current-period usage computation").
 */
type Tx = Prisma.TransactionClient;
type Client = PrismaClient | Tx;

/**
 * Geçerli dönemde tüketilen + halen aktif (süresi dolmamış) rezerve edilen
 * kredilerin toplamı — bkz. lib/ai/quota-period.ts (deterministik UTC
 * takvim ayı). Bayat (expired) RESERVED satırlar kasıtlı olarak HARİÇ
 * tutulur (bkz. AiUsageLedger.reservationExpiresAt doküman notu) — bir
 * çökme/zaman aşımı sonrası kotayı kalıcı olarak bloke etmez.
 *
 * `opts.excludeLedgerRowId`, bayat bir rezervasyonun aynı satır üzerinde
 * geri kazanılması (recycle) sırasında kullanılır: o satırın KENDİ eski
 * değeri toplamdan çıkarılır, böylece yeniden rezervasyon kontrolü kendi
 * önceki rezervasyonuyla çakışmaz.
 */
export async function getCurrentPeriodAiCreditsUsed(
  client: Client,
  organizationId: string,
  opts: { excludeLedgerRowId?: string } = {},
): Promise<number> {
  const periodStart = getAiQuotaPeriodStart(new Date());

  const [committed, reserved] = await Promise.all([
    client.aiUsageLedger.aggregate({
      where: {
        organizationId,
        periodStart,
        status: "COMMITTED",
        ...(opts.excludeLedgerRowId ? { id: { not: opts.excludeLedgerRowId } } : {}),
      },
      _sum: { consumedCredits: true },
    }),
    client.aiUsageLedger.aggregate({
      where: {
        organizationId,
        periodStart,
        status: "RESERVED",
        reservationExpiresAt: { gt: new Date() },
        ...(opts.excludeLedgerRowId ? { id: { not: opts.excludeLedgerRowId } } : {}),
      },
      _sum: { reservedCredits: true },
    }),
  ]);

  return (committed._sum.consumedCredits ?? 0) + (reserved._sum.reservedCredits ?? 0);
}
