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
 * Geçerli UTC takvim ayında (bkz. lib/ai/quota-period.ts —
 * `ai.monthly_quota` ile AYNI deterministik dönem tanımı, TEK kaynak)
 * organizasyonun tükettiği OCR/belge çıkarım sayısı.
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
 * `status: "PENDING"` HARİÇ tutulur: bu, kaydın oluşturulduğu ama sağlayıcı
 * çağrısının (`provider.extract`) henüz TAMAMLANMADIĞI kısa geçiş durumudur
 * (normal akışta aynı senkron çağrı içinde EXTRACTED/FAILED'e döner — bkz.
 * `runExtraction`). Süreç sağlayıcı çağrısından ÖNCE çökerse kayıt kalıcı
 * olarak PENDING'de kalabilir; bu, `ai-quota-usage.ts`'teki süresi dolmuş
 * RESERVED satırların hariç tutulmasıyla AYNI ilkeyi izler — tamamlanmamış
 * bir deneme kotayı kalıcı olarak bloke ETMEZ.
 *
 * EXTRACTED/FAILED/CONFIRMING/CONFIRMED HEPSİ dahildir — `FAILED` de dahil,
 * çünkü sağlayıcı bu durumda da GERÇEKTEN çağrılmıştır (maliyet oluşmuştur,
 * bkz. `runExtraction`'ın `catch` dalı). `FAILED`'i hariç tutmak, bir
 * kullanıcının kasıtlı olarak bozuk dosyalar yükleyerek sağlayıcıyı
 * sınırsız çağırıp kotayı bedavaya atlatmasına izin verirdi — bu kabul
 * edilemez bir kota atlatma (bypass) yoludur.
 */
export async function getCurrentPeriodOcrExtractionsUsed(client: Client, organizationId: string): Promise<number> {
  const periodStart = getAiQuotaPeriodStart(new Date());
  const periodEnd = getAiQuotaPeriodEnd(periodStart);

  return client.documentExtraction.count({
    where: {
      organizationId,
      createdAt: { gte: periodStart, lt: periodEnd },
      status: { not: "PENDING" },
    },
  });
}
