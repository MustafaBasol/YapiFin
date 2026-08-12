/**
 * YF-702 — Erken uyarı kural motorunun TÜM eşikleri, tek ve açık bir
 * yapılandırma nesnesinde.
 *
 * Neden ayrı bir dosya: eşikler daha önce kural gövdelerinin içine gömülü
 * sihirli sabitlerdi (`"0.2"`, `"0.3"`, `40`, `60`) — hangi sayının hangi
 * kuralı sürüklediğini görmek için kodu okumak, bir eşiği test etmek için de
 * gerçek veri kurgulamak gerekiyordu. Artık her kural eşiğini
 * `InsightRuleContext.thresholds` üzerinden alır, testler de eşiği doğrudan
 * geçerek sınır davranışını (eşiğin hemen altında sinyal YOK, tam eşikte
 * sinyal VAR) veri kurgulamadan doğrulayabilir.
 *
 * ÖNEMLİ — bunlar sektör kıyaslaması (benchmark) DEĞİLDİR. Onaylanmış bir
 * dış kaynak olmadan sektör ortalaması uydurulmamıştır (bkz. görev talimatı
 * "Do not invent industry benchmarks without an approved configuration/
 * source"). Her değer, YapıFin'in KENDİ verisinden türeyen göreli bir orandır
 * ve aşağıda gerekçesiyle birlikte belgelenmiştir.
 *
 * Oranlar `Prisma.Decimal` ile karşılaştırıldığından string olarak tutulur —
 * `0.1 + 0.2 !== 0.3` sınıfı kayan nokta hatası finansal eşik
 * karşılaştırmasına ASLA sızmamalıdır (bkz. CLAUDE.md "Mimari ilkeler").
 */
export interface InsightThresholds {
  /**
   * Projeksiyon kapanış bakiyesi, açılış bakiyesinin bu oranının ALTINA
   * düşerse `CASH_FLOW_PRESSURE` (HIGH) üretilir. Kapanış bakiyesi negatifse
   * bu oran hiç kullanılmaz — doğrudan CRITICAL üretilir.
   * Gerekçe: mevcut nakdin beşte dördünden fazlasının erimesi, YapıFin'in
   * kendi planlanmış tahsilat/ödeme verisinden okunan göreli bir sinyaldir.
   */
  readonly cashProjectionWarningRatio: string;

  /**
   * Vadesi geçmiş alacağın toplam açık alacağa oranı bu değere ULAŞIRSA
   * `OVERDUE_RECEIVABLES` HIGH, altındaysa MEDIUM olur. Sinyalin kendisi
   * vadesi geçmiş tutar sıfırdan büyük olduğu anda üretilir (oran yalnızca
   * önem derecesini belirler).
   */
  readonly overdueReceivableHighRatio: string;

  /** Tek bir gider kategorisinin toplam gider içindeki payı (yüzde) bu değere ulaşırsa `EXPENSE_CONCENTRATION` üretilir. */
  readonly expenseConcentrationMinSharePercent: string;

  /** Aynı payın HIGH önem derecesine yükseldiği eşik (yüzde). */
  readonly expenseConcentrationHighSharePercent: string;

  /**
   * `EXPENSE_CONCENTRATION` için gereken en az kategori sayısı. Tek
   * kategorisi olan bir organizasyonda "%100 yoğunlaşma" matematiksel bir
   * zorunluluktur, finansal bir uyarı değildir — bu, "yetersiz veriyle
   * uyarı üretme" kuralının somut karşılığıdır.
   */
  readonly expenseConcentrationMinCategoryCount: number;

  /** Proje bazlı vadesi geçmiş alacak sinyallerinde en fazla kaç proje raporlanır (en yüksek tutarlılar önce). */
  readonly maxOverdueProjectSignals: number;

  /** AI'ya iletilen ve kullanıcıya döndürülen en fazla sinyal sayısı; aşılırsa sonuç `truncated: true` ile işaretlenir. */
  readonly maxSignals: number;

  /**
   * YF-702-F1 — `COLLECTION_PAYMENT_IMBALANCE` göreli eşiği: dönem
   * tahsilatının dönem ödemesini karşılama oranı (tahsilat / ödeme) bu değere
   * eşit veya bundan KÜÇÜKSE sinyal üretilir.
   *
   * Gerekçe: sektör kıyaslaması DEĞİLDİR. Uygulamanın kendi verisinden okunan
   * göreli bir orandır ve YapıFin'de zaten kullanılan 0,8 kritiklik
   * konvansiyonuyla aynı hizadadır (bkz. `BUDGET_CRITICAL_RATIO`,
   * server/services/budget-report-service.ts) — yeni bir dış varsayım
   * getirilmemiştir.
   */
  readonly collectionPaymentImbalanceMaxCoverageRatio: string;

  /** Aynı karşılama oranının HIGH önem derecesine yükseldiği eşik — tahsilat, ödemelerin yarısını veya daha azını karşılıyor. */
  readonly collectionPaymentImbalanceHighCoverageRatio: string;

  /**
   * Mutlak gürültü tabanı (TRY): net nakit çıkışı (ödeme − tahsilat) bu
   * tutara ULAŞMADIKÇA sinyal üretilmez.
   *
   * Neden gerekli: yalnızca oran kapısı bırakılırsa 10 TL ödeme / 8 TL
   * tahsilat gibi finansal olarak anlamsız bir dönem de "dengesizlik" sayılır.
   * Bu bir kıyaslama veya plan/tenant'a özgü bir değer DEĞİLDİR; tüm
   * organizasyonlar için aynıdır ve `InsightThresholds` üzerinden enjekte
   * edilebilir — dağıtım başına ayarlanabilir tutucu bir varsayılandır.
   */
  readonly collectionPaymentImbalanceMinNetOutflow: string;
}

export const DEFAULT_INSIGHT_THRESHOLDS: InsightThresholds = {
  cashProjectionWarningRatio: "0.2",
  overdueReceivableHighRatio: "0.3",
  expenseConcentrationMinSharePercent: "40",
  expenseConcentrationHighSharePercent: "60",
  expenseConcentrationMinCategoryCount: 2,
  maxOverdueProjectSignals: 5,
  maxSignals: 15,
  collectionPaymentImbalanceMaxCoverageRatio: "0.8",
  collectionPaymentImbalanceHighCoverageRatio: "0.5",
  collectionPaymentImbalanceMinNetOutflow: "10000",
};
