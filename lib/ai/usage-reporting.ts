/**
 * YF-701 — Kota/faturalama SINIRI. Bu dosya bilinçli olarak hiçbir plan/
 * abonelik/limit MANTIĞI içermez (bkz. görev talimatı "Do not implement
 * billing or plan limits here" ve "IMPORTANT PARALLEL-WORK RULE" — YF-802 bu
 * alanda paralel çalışıyor olabilir). Amaç yalnızca YF-711/YF-802'nin ileride
 * bağlanabileceği küçük, kararlı bir arayüz sağlamaktır.
 *
 * `AiUsageReporter.checkQuota` varsayılan (no-op) implementasyonda her zaman
 * `{ allowed: true }` döner — yani bugün hiçbir kullanım engellenmez. Gerçek
 * bir kota uygulaması eklenmek istendiğinde tek yapılması gereken bu arayüzü
 * uygulayan yeni bir implementasyon yazıp çağıran koda enjekte etmektir
 * (bkz. `server/services/document-extraction/provider.ts` ile aynı enjeksiyon
 * deseni) — bu dosyanın kendisi DEĞİŞMEZ.
 */

export interface AiQuotaDecision {
  allowed: boolean;
  /** yalnızca allowed: false olduğunda dolu — kullanıcıya gösterilebilecek Türkçe sebep. */
  reason?: string;
}

export interface AiUsageReportEntry {
  organizationId: string;
  provider: string;
  correlationId: string;
  usage: {
    promptTokens: number | null;
    completionTokens: number | null;
    totalTokens: number | null;
  };
}

export interface AiUsageReporter {
  /** Bir AI çağrısı başlamadan önce çağrılır — organizasyonun kotası doluysa fail-closed reddedebilir. */
  checkQuota(organizationId: string): Promise<AiQuotaDecision>;
  /** Bir AI çağrısı tamamlandıktan sonra (başarılı/başarısız fark etmeksizin, kullanım tükettiyse) çağrılır. */
  reportUsage(entry: AiUsageReportEntry): Promise<void>;
}

/** Varsayılan implementasyon: hiçbir kota uygulamaz, hiçbir yere yazmaz — YF-711/YF-802 entegre olana kadar güvenli varsayılan. */
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
