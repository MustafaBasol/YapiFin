/**
 * YF-711 — AI aylık kota dönemi sınırları.
 *
 * KASITLI OLARAK `lib/dates.ts`'in Istanbul yardımcılarından (`toIstanbul`/
 * `fromIstanbulComponents`) bağımsızdır. O dosya docs/ARCHITECTURE.md §8/§12
 * uyarınca özellikle FİNANSAL RAPORLAMA gün/ay sınırları içindir (dashboard
 * dönemleri, bütçe raporları) — YapiFin'de henüz tanımlanmış bir abonelik/
 * faturalama dönemi sözleşmesi (ör. `Organization`/`Plan` üzerinde bir alan)
 * YOKTUR; `Organization.timezone` yalnızca görüntüleme amaçlı, hiçbir
 * faturalama hesaplamasında kullanılmaz. Bu nedenle AI kotası kendi
 * deterministik UTC takvim ayı sınırını kullanır — gerçek bir abonelik
 * faturalama dönemi tanımlandığında yalnızca BU dosya değişir, çağıran kod
 * (lib/entitlements/ai-quota-usage.ts, server/services/ai-usage-*) değişmez.
 */

export function getAiQuotaPeriodStart(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0, 0));
}

export function getAiQuotaPeriodEnd(periodStart: Date): Date {
  return new Date(Date.UTC(periodStart.getUTCFullYear(), periodStart.getUTCMonth() + 1, 1, 0, 0, 0, 0));
}
