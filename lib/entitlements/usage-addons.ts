import type { Prisma, PrismaClient, UsageAddonGrant } from "@prisma/client";
import { isLimitId, type LimitId } from "@/lib/entitlements/capabilities";
import { ServiceError } from "@/server/services/errors";

/**
 * YF-803 — `UsageAddonGrant`'ın TEK okuma/yazma kaynağı. Kasıtlı olarak
 * `lib/entitlements/entitlement-service.ts`'e bağımlı DEĞİLDİR (import
 * etmez) — `lib/entitlements/ai-quota-usage.ts`/`ocr-quota-usage.ts` ile
 * AYNI gerekçeyle: iki yönlü bir bağımlılık döngüsü oluşmadan hem genel
 * `checkLimit`/`resolveEffectiveLimitMax` HEM DE (ileride gerekirse) YF-813
 * gibi daha atomik bir çağrı noktası aynı, tek "aktif ek kota" tanımını
 * çağırabilsin.
 */
type Tx = Prisma.TransactionClient;
type Client = PrismaClient | Tx;

/**
 * Belirli bir `resource` (LimitId) için, `now` anında GEÇERLİ tüm
 * `UsageAddonGrant` satırlarının toplam miktarı. `lib/entitlements/
 * entitlement-service.ts` `resolveEffectiveLimitMax` bu değeri planın dahil
 * kotasına EKLER — "available = included + add-on - consumed" formülünün
 * "+ add-on" kısmı budur.
 *
 * Süresi dolmuş (`validUntil <= now`) veya henüz başlamamış
 * (`validFrom > now`) bağışlar kasıtlı olarak HARİÇ tutulur — silinmez
 * (mimari ilke "hard delete yok"), yalnızca toplamdan düşer.
 */
export async function getActiveAddonQuota(
  client: Client,
  organizationId: string,
  resource: LimitId,
  now: Date = new Date(),
): Promise<number> {
  const result = await client.usageAddonGrant.aggregate({
    where: {
      organizationId,
      resource,
      validFrom: { lte: now },
      OR: [{ validUntil: null }, { validUntil: { gt: now } }],
    },
    _sum: { amount: true },
  });
  return result._sum.amount ?? 0;
}

export interface GrantUsageAddonInput {
  /**
   * Çağıran TARAFINDAN, oturum/webhook bağlamından çözümlenmiş organizasyon
   * kimliği — bu fonksiyon organizationId'yi ASLA doğrulamaz/çözümlemez
   * (bkz. görev talimatı "No client-provided tenant ... may be trusted
   * without server-side resolution"); o sorumluluk çağırana aittir.
   */
  organizationId: string;
  resource: LimitId;
  /** Bağışlanan ek kota miktarı — pozitif bir tam sayı olmalıdır. */
  amount: number;
  /** Çağıranın ürettiği, tekrarlar arasında sabit kalan mantıksal bağış kimliği (bkz. AiUsageLedger.idempotencyKey ile aynı desen). */
  idempotencyKey: string;
  /** Serbest metin köken etiketi (ör. "manual", gelecekte "stripe_topup") — denetlenebilirlik için. */
  source: string;
  validFrom?: Date;
  /** `undefined`/verilmemiş = süresiz geçerli. */
  validUntil?: Date | null;
  /** Yalnızca güvenli, PII/sır İÇERMEYEN serbest meta veri. */
  metadata?: Prisma.InputJsonValue;
  createdById?: string | null;
}

function isUniqueConstraintViolation(err: unknown): boolean {
  return (err as { code?: string } | null)?.code === "P2002";
}

/**
 * Bir kota bağışını İDEMPOTENT biçimde oluşturur — aynı
 * `(organizationId, idempotencyKey)` ile tekrar çağrılırsa (ör. bir webhook
 * retry'ı, bkz. YF-813) YENİ bir satır oluşturmaz, mevcut satırı döner.
 * Eşzamanlı iki aynı-anahtarlı çağrı arasındaki nadir yarışı `P2002` benzersizlik
 * ihlalini yakalayıp mevcut satırı yeniden okuyarak (aynı `AiUsageLedger`
 * idempotency deseninin daha basit bir varyantı) güvenle çözer.
 */
export async function grantUsageAddon(client: Client, input: GrantUsageAddonInput): Promise<UsageAddonGrant> {
  if (!isLimitId(input.resource)) {
    throw new ServiceError("Bilinmeyen kullanım kaynağı");
  }
  if (!Number.isInteger(input.amount) || input.amount <= 0) {
    throw new ServiceError("Bağış miktarı pozitif bir tam sayı olmalıdır");
  }
  if (!input.idempotencyKey) {
    throw new ServiceError("idempotencyKey zorunludur");
  }

  const existing = await client.usageAddonGrant.findUnique({
    where: { organizationId_idempotencyKey: { organizationId: input.organizationId, idempotencyKey: input.idempotencyKey } },
  });
  if (existing) return existing;

  try {
    return await client.usageAddonGrant.create({
      data: {
        organizationId: input.organizationId,
        resource: input.resource,
        amount: input.amount,
        idempotencyKey: input.idempotencyKey,
        source: input.source,
        validFrom: input.validFrom ?? new Date(),
        validUntil: input.validUntil ?? null,
        metadata: input.metadata,
        createdById: input.createdById ?? null,
      },
    });
  } catch (err) {
    if (isUniqueConstraintViolation(err)) {
      const recovered = await client.usageAddonGrant.findUnique({
        where: { organizationId_idempotencyKey: { organizationId: input.organizationId, idempotencyKey: input.idempotencyKey } },
      });
      if (recovered) return recovered;
    }
    throw err;
  }
}

/**
 * Bir bağışı "iptal eder" — satır SİLİNMEZ (mimari ilke "hard delete yok,
 * iptal/arşiv mantığı"), yalnızca `validUntil` verilen zamana (varsayılan:
 * şimdi) çekilir; bu andan itibaren `getActiveAddonQuota` onu artık saymaz.
 * Zaten geçmişte sona ermiş bir bağış üzerinde no-op'tur (daha erken bir
 * `validUntil`'i asla GERİYE almaz). Cross-tenant bir `grantId` — `organizationId`
 * eşleşmezse — varlığını sızdırmadan `NOT_FOUND` döner (findFirst + organizationId
 * filtresi, bkz. server/services/document-extraction-service.ts findDocumentExtractionOrThrow ile aynı desen).
 */
export async function expireUsageAddonGrant(
  client: Client,
  organizationId: string,
  grantId: string,
  at: Date = new Date(),
): Promise<UsageAddonGrant> {
  const grant = await client.usageAddonGrant.findFirst({ where: { id: grantId, organizationId } });
  if (!grant) throw new ServiceError("Kota bağışı bulunamadı", "NOT_FOUND");
  if (grant.validUntil !== null && grant.validUntil <= at) return grant;
  return client.usageAddonGrant.update({ where: { id: grant.id }, data: { validUntil: at } });
}
