import { Prisma } from "@prisma/client";
import type { TransactionType } from "@prisma/client";
import { addIstanbulDays } from "@/lib/dates";
import { ZERO } from "@/server/services/ledger";

/**
 * YF-705 — Nakit akışı senaryo matematiği (SAF çekirdek).
 *
 * Bu modülde Prisma sorgusu, `db` erişimi ve yan etki YOKTUR — yalnızca
 * `Prisma.Decimal` aritmetiği. Aynı ayrım `server/services/ai-insights-rules.ts`
 * içinde de uygulanır: finansal kural/formül katmanı, veri erişim katmanından
 * ayrı tutulur ve böylece fikstür tabanlı birim testlerle veritabanı olmadan
 * doğrulanabilir.
 *
 * ## Sözleşme
 *
 * - Model/AI bu dosyadaki HİÇBİR sayıyı üretmez, değiştiremez veya sıralayamaz.
 * - Tüm parasal değerler `Prisma.Decimal`'dir; kayan nokta ASLA kullanılmaz.
 * - Senaryolar YALNIZCA zamanlama kaydırır (YF-403 `CASH_FLOW_SCENARIOS` ile
 *   aynı ilke): veritabanındaki `dueDate` hiçbir zaman değiştirilmez, hiçbir
 *   tutara oran/iskonto uygulanmaz ve var olmayan hiçbir gelir/gider eklenmez.
 */

export const CASH_SCENARIOS = ["BASE", "RISK", "OPTIMISTIC"] as const;
export type CashScenario = (typeof CASH_SCENARIOS)[number];

export const CASH_SCENARIO_HORIZON_DAYS = [30, 60, 90] as const;
export type CashScenarioHorizon = (typeof CASH_SCENARIO_HORIZON_DAYS)[number];

/** Seri uzunluğu — en uzun ufuk. Tüm senaryolar tek bir 90 günlük seri üretir. */
export const CASH_SCENARIO_MAX_HORIZON_DAYS = 90;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Senaryo gecikme parametreleri.
 *
 * YF-403'ün `DELAY_DAYS_BY_SCENARIO` mekanizmasıyla AYNI türden bir kaydırmadır
 * (bkz. server/services/cash-flow-report-service.ts), ancak gün sayıları bu
 * rapora göre seçilmiştir:
 *
 * - **RISK = 30 gün tahsilat gecikmesi.** Türkiye B2B/inşaat pratiğinde "vade"
 *   kanonik olarak aylıktır; 30 gün bir TAM vade dönemidir. YF-403'ün 7 günlük
 *   nüansı 30 günlük bir rapor için ölçeklenmiştir ve 60/90 günlük ufuklarda
 *   etkisi sönümlenir (senaryolar görsel olarak birbirine yapışır) — bu rapor
 *   tam da uzun ufukta ayrışma göstermek zorundadır.
 * - **OPTIMISTIC = 15 gün ödeme ötelemesi.** Yarım vade. Tüm borçların (maaş
 *   benzeri, vergi benzeri kalemler dahil) tek taraflı 30 gün ötelenmesi
 *   inandırıcı değildir. Asimetri kasıtlıdır: kendi ödemelerinizi ötelemekte
 *   sınırlı bir kontrolünüz vardır, müşteri tahsilat disiplininde hiç yoktur.
 *
 * Gecikmeler ASLA negatif olamaz (bkz. `assertNonNegativeDelays`): negatif
 * kaydırma, tek sorgulu `dueDate < end90` veri çekme sınırını geçersiz kılar ve
 * sözleşme tarihinden ÖNCE nakit uydurmak anlamına gelir.
 */
export const CASH_SCENARIO_DELAY_DAYS: Record<
  CashScenario,
  { collectionDelayDays: number; paymentDelayDays: number }
> = {
  BASE: { collectionDelayDays: 0, paymentDelayDays: 0 },
  RISK: { collectionDelayDays: 30, paymentDelayDays: 0 },
  OPTIMISTIC: { collectionDelayDays: 0, paymentDelayDays: 15 },
};

export const CASH_SCENARIO_LABELS: Record<CashScenario, string> = {
  BASE: "Baz senaryo",
  RISK: "Risk senaryosu",
  OPTIMISTIC: "İyimser senaryo",
};

export type CashScenarioAssumptionId =
  | "CASH_BASIS_DUE_DATE"
  | "OPENING_CASH_ALL_ACTIVE_ACCOUNTS"
  | "OVERDUE_AT_WINDOW_START"
  | "NO_NEW_BUSINESS"
  | "TRANSFERS_EXCLUDED"
  | "PROGRESS_PAYMENTS_UNAPPROVED_EXCLUDED"
  | "SCENARIO_ON_DUE_DATE"
  | "SCENARIO_COLLECTIONS_DELAYED_30D"
  | "SCENARIO_PAYMENTS_DEFERRED_15D"
  | "NULL_DUE_DATE_EXCLUDED"
  | "CREDIT_CARD_IN_OPENING_CASH"
  | "MULTI_CURRENCY_NOT_CONVERTED"
  | "ROWS_TRUNCATED"
  | "NO_DATED_RECORDS"
  | "NO_CASH_VISIBILITY";

/**
 * Varsayım etiketleri — kullanıcıya ve AI istemine BİREBİR aynı metin gider.
 * Gizli/örtük varsayım bırakılmaz: her senaryo hücresi kendi varsayımlarını
 * taşır ve arayüzde "Senaryonun dayandığı varsayımlar" panelinde listelenir.
 */
export const CASH_SCENARIO_ASSUMPTION_LABELS: Record<CashScenarioAssumptionId, string> = {
  CASH_BASIS_DUE_DATE: "Nakit tahmini yalnızca vade tarihi girilmiş açık kayıtlara dayanır.",
  OPENING_CASH_ALL_ACTIVE_ACCOUNTS:
    "Açılış nakdi tüm aktif hesapların (kasa, banka, kredi kartı, ortak cari) hareket bakiyesidir.",
  // NOT: "pencerenin ilk günü" ifadesi YALNIZCA baz senaryoda doğrudur.
  // Motor kaydır-sonra-kırp uygular: 5 gün gecikmiş bir alacak risk
  // senaryosunda (+30 gün) 25. güne düşer, ilk güne DEĞİL. Etiket bu yüzden
  // her üç senaryoda da doğru olacak şekilde yazılmıştır.
  OVERDUE_AT_WINDOW_START:
    "Vadesi geçmiş alacak ve borçlar, senaryo gecikmesi uygulandıktan sonra en erken bugüne yazılır; geçmişe taşınmaz.",
  NO_NEW_BUSINESS: "Bugün kayıtlı olmayan hiçbir gelir veya gider tahmine eklenmemiştir.",
  TRANSFERS_EXCLUDED: "Hesaplar arası virmanlar toplam nakdi değiştirmediği için modele girmez.",
  PROGRESS_PAYMENTS_UNAPPROVED_EXCLUDED:
    "Onaylanmamış hakedişler (taslak/gönderilmiş) finansal kayda dönüşmediği için tahminde yer almaz.",
  SCENARIO_ON_DUE_DATE: "Tüm tahsilat ve ödemeler kayıtlı vade tarihinde gerçekleşir.",
  SCENARIO_COLLECTIONS_DELAYED_30D:
    "Her tahsilat bir tam vade dönemi (30 gün) gecikir; ödemeler vadesinde yapılır.",
  SCENARIO_PAYMENTS_DEFERRED_15D:
    "Ödemeler yarım vade (15 gün) ötelenir; tahsilatlar vadesinde ve kayıtlı tutarda kalır — hiçbir yeni gelir eklenmemiştir.",
  NULL_DUE_DATE_EXCLUDED:
    "Vadesi girilmemiş kayıtlar zaman çizelgesine yerleştirilemediği için tahmin dışıdır.",
  CREDIT_CARD_IN_OPENING_CASH:
    "Açılış nakdinde kredi kartı bakiyeleri de yer alır; kart borcu nakdi azaltan yönde işlenir.",
  MULTI_CURRENCY_NOT_CONVERTED:
    "Farklı para birimlerindeki tutarlar kur çevrimi yapılmadan toplanmıştır.",
  ROWS_TRUNCATED: "Kayıt sayısı üst sınırı aşıldığı için tahmin eksiktir.",
  NO_DATED_RECORDS:
    "Vade tarihli açık kayıt bulunmadığı için tahmin yalnızca mevcut nakit bakiyesini yansıtır.",
  NO_CASH_VISIBILITY:
    "Kasa/banka bakiyesi bu rolde görüntülenemediği için nakit bakiyesi, kırılma tarihi ve minimum nakit hesaplanmaz.",
};

const SCENARIO_ASSUMPTION_ID: Record<CashScenario, CashScenarioAssumptionId> = {
  BASE: "SCENARIO_ON_DUE_DATE",
  RISK: "SCENARIO_COLLECTIONS_DELAYED_30D",
  OPTIMISTIC: "SCENARIO_PAYMENTS_DEFERRED_15D",
};

/** Tek bir açık (kalan > 0), vadesi girilmiş finansal kayıt. */
export interface CashScenarioRow {
  id: string;
  type: TransactionType;
  dueDate: Date;
  remaining: Prisma.Decimal;
  currency: string;
}

export interface CashScenarioMinimumPoint {
  /** `-1` = açılış anı (bugünün başlangıcı); aksi halde pencere içi gün indeksi. */
  dayIndex: number;
  date: Date;
  amount: string;
  isOpeningPoint: boolean;
}

export interface CashScenarioCell {
  scenario: CashScenario;
  horizonDays: CashScenarioHorizon;
  /** Pencere YARI AÇIKtır: [windowStart, windowEnd). `windowEnd` DAHİL DEĞİLDİR. */
  windowStart: Date;
  windowEnd: Date;
  /** Nakit görünürlüğü olmayan kapsamlarda `null` (bkz. NO_CASH_VISIBILITY). */
  openingCash: string | null;
  expectedCollections: string;
  expectedPayments: string;
  netChange: string;
  endingCash: string | null;
  minimumCashPoint: CashScenarioMinimumPoint | null;
  /** `-1` = açılışta zaten negatif; `null` = kırılma yok. */
  breakDayIndex: number | null;
  breakDate: Date | null;
  willBreak: boolean;
  alreadyNegativeAtOpening: boolean;
  /**
   * RAPORLAMA ALT KÜMESİ — hiçbir toplama EKLENMEZ. `expectedCollections`
   * zaten vadesi geçmiş tutarları içerir; bu alan yalnızca "bu tahminin ne
   * kadarı vadesi geçmiş maruziyetten geliyor" sorusunu yanıtlar.
   */
  overdueReceivableIncluded: string;
  overduePayableIncluded: string;
  assumptions: CashScenarioAssumptionId[];
}

/**
 * Istanbul takvim günü indeksi — `todayStart` 0. `Math.floor` ZORUNLUDUR.
 *
 * `Math.round` KULLANILMAZ: `cash-flow-report-service.ts` görüntüleme
 * listesinde `Math.round` kullanır ve `dueDate` UTC gece yarısı olarak
 * saklandığı için (`z.coerce.date()`, lib/validation/transaction.ts) Istanbul
 * gününe göre kesir 0.125 çıkar, yani round ve floor bugün TESADÜFEN aynı
 * sonucu verir. Saat bileşeni taşıyan herhangi bir `dueDate`'te `Math.round`
 * kaydı BİR SONRAKİ güne taşır. Kırılma tarihi hesabı bu hatayı kaldıramaz.
 */
export function cashScenarioDayIndex(value: Date, todayStart: Date): number {
  return Math.floor((value.getTime() - todayStart.getTime()) / MS_PER_DAY);
}

function assertNonNegativeDelays(collectionDelayDays: number, paymentDelayDays: number): void {
  if (collectionDelayDays < 0 || paymentDelayDays < 0) {
    throw new Error("Negatif senaryo kaydırması nakit uydurur ve tek sorgu sınırını geçersiz kılar");
  }
}

export interface CashScenarioSeries {
  inflow: Prisma.Decimal[];
  outflow: Prisma.Decimal[];
}

/**
 * Günlük giriş/çıkış serisi. Uzunluk `CASH_SCENARIO_MAX_HORIZON_DAYS`; 30 ve 60
 * günlük ufuklar bu serinin ÖN EKİdir — senaryo başına tek seri üretilir,
 * dokuz hücre için dokuz kez hesaplanmaz.
 *
 * **Kaydır, SONRA kırp.** Vadesi geçmiş bir kayıt önce senaryo gecikmesiyle
 * kaydırılır, ardından gün 0'a kırpılır. Ters sıra (`0 + gecikme`) vadesi
 * geçmiş kalemleri yanlış güne taşır: 3 gün gecikmiş bir borç OPTIMISTIC'te
 * gün 12'ye gitmelidir (−3 + 15), gün 15'e değil.
 */
export function buildCashScenarioSeries(params: {
  rows: readonly CashScenarioRow[];
  collectionDelayDays: number;
  paymentDelayDays: number;
  todayStart: Date;
  horizonDays?: number;
}): CashScenarioSeries {
  const { rows, collectionDelayDays, paymentDelayDays, todayStart } = params;
  const length = params.horizonDays ?? CASH_SCENARIO_MAX_HORIZON_DAYS;
  assertNonNegativeDelays(collectionDelayDays, paymentDelayDays);

  const inflow: Prisma.Decimal[] = new Array(length).fill(ZERO);
  const outflow: Prisma.Decimal[] = new Array(length).fill(ZERO);

  for (const row of rows) {
    const isIncome = row.type === "INCOME";
    const delayDays = isIncome ? collectionDelayDays : paymentDelayDays;
    const shifted = delayDays === 0 ? row.dueDate : addIstanbulDays(row.dueDate, delayDays);
    const bucketDay = Math.max(0, cashScenarioDayIndex(shifted, todayStart));
    if (bucketDay >= length) continue;
    if (isIncome) inflow[bucketDay] = inflow[bucketDay].plus(row.remaining);
    else outflow[bucketDay] = outflow[bucketDay].plus(row.remaining);
  }

  return { inflow, outflow };
}

function sumOverdue(rows: readonly CashScenarioRow[], type: TransactionType, todayStart: Date): Prisma.Decimal {
  let total = ZERO;
  for (const row of rows) {
    if (row.type !== type) continue;
    if (cashScenarioDayIndex(row.dueDate, todayStart) >= 0) continue;
    total = total.plus(row.remaining);
  }
  return total;
}

/**
 * Bir senaryo serisinin ilk `horizonDays` gününü özetler.
 *
 * Değişmez (test edilir): `cum[N-1] === endingCash(N)`. Kırpma sayesinde
 * `{ r : bucketDay ∈ [0,N) }` kümesi `{ r : kaydırılmışVade < end_N }` kümesine
 * BİREBİR eşittir; bu yüzden gün gün toplam ile toplu yüklem aynı sonucu verir.
 */
export interface CashScenarioOverdueTotals {
  receivable: Prisma.Decimal;
  payable: Prisma.Decimal;
}

/** Vadesi geçmiş toplamlar — senaryodan BAĞIMSIZdır (ham vade kullanılır). */
export function computeCashScenarioOverdueTotals(
  rows: readonly CashScenarioRow[],
  todayStart: Date,
): CashScenarioOverdueTotals {
  return {
    receivable: sumOverdue(rows, "INCOME", todayStart),
    payable: sumOverdue(rows, "EXPENSE", todayStart),
  };
}

export function summarizeCashScenarioPrefix(params: {
  series: CashScenarioSeries;
  rows: readonly CashScenarioRow[];
  scenario: CashScenario;
  horizonDays: CashScenarioHorizon;
  todayStart: Date;
  openingCash: Prisma.Decimal | null;
  assumptions: readonly CashScenarioAssumptionId[];
  /**
   * Önceden hesaplanmış vadesi geçmiş toplamlar. Senaryodan bağımsız
   * olduklarından dokuz hücre için TEK kez hesaplanır; verilmezse bu çağrı
   * kendisi hesaplar (tekil kullanım/testler için).
   */
  overdue?: CashScenarioOverdueTotals;
}): CashScenarioCell {
  const { series, rows, scenario, horizonDays, todayStart, openingCash } = params;
  const overdue = params.overdue ?? computeCashScenarioOverdueTotals(rows, todayStart);

  let collections = ZERO;
  let payments = ZERO;
  for (let d = 0; d < horizonDays; d += 1) {
    collections = collections.plus(series.inflow[d]);
    payments = payments.plus(series.outflow[d]);
  }
  const netChange = collections.minus(payments);

  const windowStart = todayStart;
  const windowEnd = addIstanbulDays(todayStart, horizonDays);

  const scenarioAssumptions: CashScenarioAssumptionId[] = [
    ...params.assumptions,
    SCENARIO_ASSUMPTION_ID[scenario],
  ];
  if (overdue.receivable.greaterThan(ZERO) || overdue.payable.greaterThan(ZERO)) {
    scenarioAssumptions.push("OVERDUE_AT_WINDOW_START");
  }

  const base = {
    scenario,
    horizonDays,
    windowStart,
    windowEnd,
    expectedCollections: collections.toString(),
    expectedPayments: payments.toString(),
    netChange: netChange.toString(),
    overdueReceivableIncluded: overdue.receivable.toString(),
    overduePayableIncluded: overdue.payable.toString(),
    assumptions: scenarioAssumptions,
  };

  if (openingCash === null) {
    // Nakit görünürlüğü yok: akışlar yine üretilir, nakit çapalı alanların
    // TAMAMI null. Sıfır DEĞİL — "bilinmiyor" ile "sıfır" karıştırılmaz.
    return {
      ...base,
      openingCash: null,
      endingCash: null,
      minimumCashPoint: null,
      breakDayIndex: null,
      breakDate: null,
      willBreak: false,
      alreadyNegativeAtOpening: false,
    };
  }

  const alreadyNegativeAtOpening = openingCash.lessThan(ZERO);

  // Açılış noktası (`d = -1`) minimum adaylarına DAHİLDİR: aksi halde tüm
  // akışların pozitif olduğu bir senaryoda "minimum nakit", organizasyonun
  // bugün fiilen elinde tuttuğu tutardan YÜKSEK raporlanırdı.
  let minimumIndex = -1;
  let minimumAmount = openingCash;
  let running = openingCash;
  let firstNegative: number | null = null;

  for (let d = 0; d < horizonDays; d += 1) {
    running = running.plus(series.inflow[d]).minus(series.outflow[d]);
    if (running.lessThan(minimumAmount)) {
      minimumAmount = running;
      minimumIndex = d;
    }
    if (firstNegative === null && running.lessThan(ZERO)) firstNegative = d;
  }

  const endingCash = openingCash.plus(netChange);
  const breakDayIndex = alreadyNegativeAtOpening ? -1 : firstNegative;
  const breakDate = breakDayIndex === null ? null : addIstanbulDays(todayStart, Math.max(0, breakDayIndex));

  return {
    ...base,
    openingCash: openingCash.toString(),
    endingCash: endingCash.toString(),
    minimumCashPoint: {
      dayIndex: minimumIndex,
      date: minimumIndex === -1 ? todayStart : addIstanbulDays(todayStart, minimumIndex),
      amount: minimumAmount.toString(),
      isOpeningPoint: minimumIndex === -1,
    },
    breakDayIndex,
    breakDate,
    willBreak: breakDayIndex !== null,
    alreadyNegativeAtOpening,
  };
}

/**
 * Dokuz hücrenin tamamını TEK satır kümesinden üretir — senaryo başına bir
 * seri, ufuk başına bir ön ek özeti. Proje sayısından, senaryo sayısından ve
 * ufuk sayısından bağımsız olarak ek sorgu YOKTUR.
 */
export function computeCashScenarioCells(params: {
  rows: readonly CashScenarioRow[];
  todayStart: Date;
  openingCash: Prisma.Decimal | null;
  assumptions: readonly CashScenarioAssumptionId[];
}): CashScenarioCell[] {
  const cells: CashScenarioCell[] = [];
  // Vadesi geçmiş toplamlar senaryodan bağımsızdır — dokuz hücre için TEK kez
  // taranır, hücre başına yeniden hesaplanmaz.
  const overdue = computeCashScenarioOverdueTotals(params.rows, params.todayStart);
  for (const scenario of CASH_SCENARIOS) {
    const { collectionDelayDays, paymentDelayDays } = CASH_SCENARIO_DELAY_DAYS[scenario];
    const series = buildCashScenarioSeries({
      rows: params.rows,
      collectionDelayDays,
      paymentDelayDays,
      todayStart: params.todayStart,
    });
    for (const horizonDays of CASH_SCENARIO_HORIZON_DAYS) {
      cells.push(
        summarizeCashScenarioPrefix({
          series,
          rows: params.rows,
          scenario,
          horizonDays,
          todayStart: params.todayStart,
          openingCash: params.openingCash,
          assumptions: params.assumptions,
          overdue,
        }),
      );
    }
  }
  return cells;
}
