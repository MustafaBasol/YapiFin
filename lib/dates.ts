/**
 * YapiFin sabit zaman dilimi politikası — docs/ARCHITECTURE.md §8 ve §12.
 * Uygulama tek pazar (Türkiye) için tasarlandığından `Europe/Istanbul`
 * sabit UTC+3 kabul edilir (2016 sonrası DST uygulanmadığı için TZ veritabanı
 * kurallarına gerek yoktur). Tüm DB timestamp'leri UTC saklanır; gün/ay
 * sınırları bu sabit ofsetle Istanbul takvimine göre hesaplanır — tarayıcı
 * yerel saat dilimi hiçbir zaman sunucu tarafı hesaplamalara karışmaz.
 */
export const TR_OFFSET_MS = 3 * 60 * 60 * 1000;

export function toIstanbul(date: Date): Date {
  return new Date(date.getTime() + TR_OFFSET_MS);
}

export function fromIstanbulComponents(y: number, m: number, d: number, h = 0, mi = 0, s = 0, ms = 0): Date {
  return new Date(Date.UTC(y, m, d, h, mi, s, ms) - TR_OFFSET_MS);
}

/** Istanbul takvimine göre "bugün"ün 00:00'ını UTC Date olarak döndürür. */
export function startOfIstanbulDay(now: Date): Date {
  const ist = toIstanbul(now);
  return fromIstanbulComponents(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate());
}

export function addIstanbulDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 24 * 60 * 60 * 1000);
}
