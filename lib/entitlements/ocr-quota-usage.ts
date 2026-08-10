import type { Prisma, PrismaClient } from "@prisma/client";
import { getAiQuotaPeriodStart, getAiQuotaPeriodEnd } from "@/lib/ai/quota-period";

/**
 * YF-817 — `ocr.monthly_quota` kullanım defterinin TEK okuma kaynağı.
 * Kasıtlı olarak `lib/entitlements/entitlement-service.ts`'e bağımlı DEĞİLDİR
 * (import etmez) — `lib/entitlements/ai-quota-usage.ts` ile AYNI gerekçeyle:
 * hem genel `countUsage` anahtarı HEM DE (ileride gerekirse) daha atomik bir
 * çağrı noktası aynı, tek "kullanım" tanımını çağırabilsin, iki yönlü bir
 * bağımlılık döngüsü oluşmadan.
 */
type Tx = Prisma.TransactionClient;
type Client = PrismaClient | Tx;

/**
 * Bir PENDING `DocumentExtraction` satırının, oluşturulmasından itibaren
 * kota SAYIMINA dahil kalabileceği azami süre. `lib/ai/credits.ts`
 * `AI_CREDIT_POLICY.reservationTtlMs` (5 dakika) ile AYNI değeri ve AYNI
 * gerekçeyi kullanır: `runExtraction`'da (bkz.
 * server/services/document-extraction-service.ts) sağlayıcı çağrısının
 * normal (hatasız VEYA hatalı) her yolu senkron olarak EXTRACTED/FAILED'e
 * döner; satırın kalıcı olarak PENDING kalması yalnızca sürecin (process)
 * `provider.extract()` sırasında/öncesinde ÇÖKMESİ gibi istisnai bir
 * kurtarma senaryosunda mümkündür. 5 dakika, gerçekçi bir sağlayıcı
 * çağrısı süresine bolca pay bırakır; bu pencere aşıldığında satır
 * "terk edilmiş" (abandoned) kabul edilip sayımdan hariç tutulur —
 * `ai-quota-usage.ts`'teki süresi dolmuş RESERVED satırların hariç
 * tutulmasıyla AYNI ilke.
 */
export const OCR_PENDING_RESERVATION_TTL_MS = 5 * 60 * 1000;

/**
 * Geçerli UTC takvim ayında (bkz. lib/ai/quota-period.ts —
 * `ai.monthly_quota` ile AYNI deterministik dönem tanımı, TEK kaynak)
 * organizasyonun tükettiği (VEYA hâlâ devam eden) OCR/belge çıkarım sayısı.
 *
 * Kasıtlı olarak AYRI bir kullanım defteri (ör. AI'nın `AiUsageLedger`'ı
 * gibi bir rezervasyon tablosu) İCAT EDİLMEZ: OCR kotası AI kotasının
 * aksine değişken maliyetli değildir (her yükleme = sağlayıcıya tam olarak
 * bir çağrı), bu yüzden mevcut, kalıcı `DocumentExtraction` kaydı zaten
 * doğru granülariteye sahiptir — bkz.
 * server/services/document-extraction-service.ts `uploadAndExtractDocument`
 * (her çağrı tam olarak bir `DocumentExtraction` satırı oluşturur, hiçbir
 * kod yolu ikinci bir sağlayıcı çağrısı için aynı satırı yeniden kullanmaz).
 *
 * `status: "PENDING"` TAZE (henüz `OCR_PENDING_RESERVATION_TTL_MS` içinde
 * oluşturulmuş) satırlar için DAHİL edilir — bkz. görev notu (YF-817 kod
 * inceleme düzeltmesi): satır oluşturma ile sağlayıcı çağrısı
 * (`provider.extract`) ARASINDA transaction ZATEN commit olmuştur (bkz.
 * `uploadAndExtractDocument`), bu yüzden sağlayıcı yanıtı YAVAŞ olsa bile
 * kayıt DB'de GÖRÜNÜR durumdadır. PENDING'i sayımdan hariç tutmak, aynı
 * organizasyonun eşzamanlı ikinci bir yüklemesinin, birincinin sağlayıcı
 * yanıtını beklerken kotayı BOŞ görüp aşmasına izin verirdi (kota=1 iken
 * iki eşzamanlı yavaş sağlayıcı çağrısının ikisinin de geçmesi gibi) —
 * `lockOrganizationForEntitlement` satır kilidi yalnızca KONTROLÜ diğer
 * transaction'larla sıralar, kontrolün OKUDUĞU sayım PENDING'i
 * dışladığında bu sıralama hâlâ yanlış (düşük) bir sayıyı görür. Yalnızca
 * `OCR_PENDING_RESERVATION_TTL_MS`'i AŞMIŞ (terk edilmiş/çökmüş) PENDING
 * satırlar hariç tutulur — bkz. yukarıdaki sabit doküman notu.
 *
 * EXTRACTED/FAILED/CONFIRMING/CONFIRMED HEPSİ (yaşından bağımsız) dahildir
 * — `FAILED` de dahil, çünkü sağlayıcı bu durumda da GERÇEKTEN çağrılmıştır
 * (maliyet oluşmuştur, bkz. `runExtraction`'ın `catch` dalı). `FAILED`'i
 * hariç tutmak, bir kullanıcının kasıtlı olarak bozuk dosyalar yükleyerek
 * sağlayıcıyı sınırsız çağırıp kotayı bedavaya atlatmasına izin verirdi —
 * bu kabul edilemez bir kota atlatma (bypass) yoludur.
 */
export async function getCurrentPeriodOcrExtractionsUsed(client: Client, organizationId: string): Promise<number> {
  const now = new Date();
  const periodStart = getAiQuotaPeriodStart(now);
  const periodEnd = getAiQuotaPeriodEnd(periodStart);
  const pendingStaleBefore = new Date(now.getTime() - OCR_PENDING_RESERVATION_TTL_MS);

  return client.documentExtraction.count({
    where: {
      organizationId,
      createdAt: { gte: periodStart, lt: periodEnd },
      OR: [{ status: { not: "PENDING" } }, { status: "PENDING", createdAt: { gte: pendingStaleBefore } }],
    },
  });
}
