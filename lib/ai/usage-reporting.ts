/**
 * YF-701/YF-711 — Kota/faturalama SINIRI. `runAiCompletion` bu arayüz
 * üzerinden çalışır ve hiçbir zaman Prisma/`@/lib/db` içermez — gerçek
 * kalıcılık `server/services/ai-usage-reporting-service.ts`'deki
 * `createEntitlementAiUsageReporter` implementasyonunun ARKASINDADIR (bkz.
 * `server/services/document-extraction/provider.ts` ile aynı enjeksiyon
 * deseni).
 */

export interface AiQuotaDecision {
  allowed: boolean;
  /** yalnızca allowed: false olduğunda dolu — kullanıcıya gösterilebilecek Türkçe sebep. */
  reason?: string;
  /**
   * YF-711 — kararlı, makine-okunur sınıflandırma (bkz.
   * server/services/ai-usage-reporting-service.ts AiEntitlementError).
   * `AI_REQUEST_IN_PROGRESS`/`AI_REQUEST_ALREADY_COMPLETED` nadir eşzamanlılık
   * yarışı geri dönüşleridir (yaygın durum bir üst katmanda erken kontrolle
   * zaten yakalanır) — yalnızca `AI_PLAN_REQUIRED`/`AI_QUOTA_EXCEEDED`
   * `AiEntitlementError.reasonCode`'a normalize edilir.
   */
  reasonCode?: "AI_PLAN_REQUIRED" | "AI_QUOTA_EXCEEDED" | "AI_REQUEST_IN_PROGRESS" | "AI_REQUEST_ALREADY_COMPLETED";
}

export interface AiQuotaCheckRequest {
  /** Çağıranın ürettiği, tekrarlar arasında sabit kalan mantıksal istek kimliği — bkz. AiUsageLedger.idempotencyKey. */
  idempotencyKey: string;
  correlationId: string;
  provider: string;
  model: string | null;
  /**
   * `lib/ai/credits.ts` `estimateReservationCredits` ile `runAiCompletion`
   * TARAFINDAN hesaplanır ve buraya sayısal bir değer olarak geçirilir —
   * implementasyonlar ham `messages` içeriğini HİÇBİR ZAMAN görmez.
   */
  reservationCreditsEstimate: number;
}

export interface AiUsageReportEntry {
  organizationId: string;
  provider: string;
  correlationId: string;
  idempotencyKey: string;
  status: "success" | "failure";
  /** yalnızca status: "failure" olduğunda dolu — bkz. lib/ai/errors.ts AiErrorCategory. */
  failureCategory?: string;
  usage: {
    promptTokens: number | null;
    completionTokens: number | null;
    totalTokens: number | null;
  };
}

export interface AiUsageReporter {
  /**
   * Bir AI çağrısı başlamadan ÖNCE çağrılır. Gerçek implementasyon burada
   * atomik rezervasyon yapar (bkz. server/services/ai-usage-reporting-service.ts
   * checkQuota) — sağlayıcı yalnızca `allowed: true` döndükten SONRA
   * çağrılabilir (bkz. lib/ai/service.ts runAiCompletion).
   */
  checkQuota(organizationId: string, request: AiQuotaCheckRequest): Promise<AiQuotaDecision>;
  /** Bir AI çağrısı tamamlandıktan sonra (başarılı/başarısız fark etmeksizin) çağrılır — gerçek implementasyon rezervasyonu kesinleştirir veya serbest bırakır. */
  reportUsage(entry: AiUsageReportEntry): Promise<void>;
}

/** Varsayılan implementasyon: hiçbir kota uygulamaz, hiçbir yere yazmaz — YF-711 entegre olmayan çağrılar için güvenli varsayılan. */
export function createNoopAiUsageReporter(): AiUsageReporter {
  return {
    async checkQuota() {
      return { allowed: true };
    },
    async reportUsage() {
      // Kasıtlı olarak no-op.
    },
  };
}
