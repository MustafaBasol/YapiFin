import { Prisma } from "@prisma/client";
import { addIstanbulDays } from "@/lib/dates";
import { formatHalfOpenPeriod, formatMoney } from "@/lib/utils";
import { ZERO, toDecimal } from "@/server/services/ledger";
import type { InsightThresholds } from "@/lib/ai/insights/thresholds";
import type { EvidenceValue, InsightSeverity } from "@/lib/ai/insights/schema";
import { money, percent, text } from "@/lib/ai/insights/evidence";
import {
  CASH_SCENARIO_DELAY_DAYS,
  CASH_SCENARIO_LABELS,
  type CashScenario,
  type CashScenarioCell,
  type CashScenarioHorizon,
  type CashScenarioRow,
} from "@/server/services/cash-flow-scenario-math";

/**
 * YF-705 — Senaryoya ÖZGÜ deterministik risk sürücüleri (SAF modül).
 *
 * ## Neden YF-702 kuralları burada tekrar çalıştırılmıyor
 *
 * YF-702'nin (`ai-insights-rules.ts`) kuralları TAMAMLANMIŞ bir DÖNEMİ
 * (geçen hafta/ay) değerlendirir: "bu dönemde ne oldu". YF-705'in sürücüleri
 * ise bir ÖNGÖRÜ UFKUNU ve BİR SENARYOYU değerlendirir: "önümüzdeki 30/60/90
 * günde, tahsilatlar 30 gün gecikirse ne olur". Kanıt (evidence) tabanları
 * farklıdır — biri gerçekleşmiş settlement, diğeri kaydırılmış vade
 * proje­ksiyonu — bu yüzden YF-702 kurallarının burada yeniden çalıştırılması
 * hem anlamsız hem de pahalı olurdu (bütçe + marj + settlement servislerinin
 * yeniden çağrılması, bilinen YF-702-TD1 mükerrer nakit akışı SQL yükünü bu
 * göreve taşırdı).
 *
 * Görev talimatındaki "Do not duplicate YF-702 rules unless scenario-specific
 * evidence genuinely requires new rules" koşulu bu nedenle karşılanmaktadır.
 *
 * ## Eşikler ICAT EDİLMEZ
 *
 * Önem derecesi gerektiren her yerde YF-702'nin ZATEN belgelenmiş ve
 * gerekçelendirilmiş eşikleri (`InsightThresholds`) yeniden kullanılır; bu
 * modül tek bir yeni sihirli sabit tanımlamaz. Sıralama ise eşik değil,
 * tutar büyüklüğüdür (`Decimal.comparedTo`).
 *
 * ## Bütçe aşımı / marj bozulması KAPSAM DIŞI
 *
 * Bu iki sürücü YF-702'de zaten vardır ve tahakkuk bazlıdır; nakit ufkuna
 * doğrudan çevrilemezler. Burada tekrar üretilmez, bunun yerine kapsam notu
 * (`coverageGaps`) ile açıkça belirtilir — sessizce atlanmaz.
 */

export const CASH_SCENARIO_DRIVER_TYPES = [
  "PROJECTED_CASH_BREAK",
  "NEGATIVE_PROJECTED_ENDING_CASH",
  "CASH_BUFFER_EROSION",
  "OVERDUE_RECEIVABLE_EXPOSURE",
  "OVERDUE_PAYABLE_EXPOSURE",
  "NEAR_TERM_PAYABLE_CONCENTRATION",
  "RECEIVABLE_CONCENTRATION",
] as const;
export type CashScenarioDriverType = (typeof CASH_SCENARIO_DRIVER_TYPES)[number];

export const CASH_SCENARIO_DRIVER_TITLES: Record<CashScenarioDriverType, string> = {
  PROJECTED_CASH_BREAK: "Projeksiyonda nakit kırılması",
  NEGATIVE_PROJECTED_ENDING_CASH: "Dönem sonunda negatif nakit",
  CASH_BUFFER_EROSION: "Nakit tamponunun erimesi",
  OVERDUE_RECEIVABLE_EXPOSURE: "Vadesi geçmiş alacak maruziyeti",
  OVERDUE_PAYABLE_EXPOSURE: "Vadesi geçmiş borç yükü",
  // Kural bir YOĞUNLAŞMA değil, tahsilat/ödeme KARŞILAMA ORANI ölçer ve 90
  // günlük ufukta da çalışır — başlık bu yüzden "yakın vadeli" demez.
  NEAR_TERM_PAYABLE_CONCENTRATION: "Tahsilat/ödeme dengesizliği",
  RECEIVABLE_CONCENTRATION: "Tek alacakta yoğunlaşma",
};

export const CASH_SCENARIO_DRIVER_ACTIONS: Record<CashScenarioDriverType, string> = {
  PROJECTED_CASH_BREAK:
    "Kırılma tarihinden önce vadesi gelen büyük ödemeleri yeniden planlayın veya tahsilatları hızlandırın.",
  NEGATIVE_PROJECTED_ENDING_CASH:
    "Dönem sonu açığını kapatmak için tahsilat takvimini ve kredi limiti ihtiyacını gözden geçirin.",
  CASH_BUFFER_EROSION: "Nakit tamponu kritik seviyeye inmeden önce ödeme takvimini yayın.",
  OVERDUE_RECEIVABLE_EXPOSURE: "Vadesi geçmiş alacaklar için tahsilat takibini önceliklendirin.",
  OVERDUE_PAYABLE_EXPOSURE: "Vadesi geçmiş borçları tedarikçilerle yeniden yapılandırmayı değerlendirin.",
  NEAR_TERM_PAYABLE_CONCENTRATION:
    "Yakın vadede yoğunlaşan ödemeleri, tahsilat takvimiyle uyumlu olacak şekilde dağıtın.",
  RECEIVABLE_CONCENTRATION:
    "Tahminin büyük bölümü tek bir alacağa bağlı; bu müşteriyle tahsilat teyidi alın.",
};

export interface CashScenarioDriver {
  /** Kararlı, deterministik kimlik — AI YALNIZCA bu kimliğe atıfta bulunabilir. */
  id: string;
  type: CashScenarioDriverType;
  severity: InsightSeverity;
  scenario: CashScenario;
  horizonDays: CashScenarioHorizon;
  title: string;
  /** Sıralama anahtarı (Decimal string) — büyükten küçüğe. */
  magnitude: string;
  evidence: EvidenceValue[];
  /** İsteme giden, önceden biçimlenmiş Türkçe olgu cümlesi. */
  facts: string;
  defaultAction: string;
}

function driverId(type: CashScenarioDriverType, scenario: CashScenario, horizonDays: number): string {
  return `${type}:${scenario}:${horizonDays}`;
}

/** Sıfıra bölmeden oran — payda ≤ 0 ise null. */
function safeRatio(numerator: Prisma.Decimal, denominator: Prisma.Decimal): Prisma.Decimal | null {
  if (denominator.lessThanOrEqualTo(ZERO)) return null;
  return numerator.div(denominator);
}

function toPercentString(ratio: Prisma.Decimal): string {
  return ratio.times(100).toDecimalPlaces(1).toString();
}

/**
 * Bir senaryo/ufuk hücresi için deterministik risk sürücülerini üretir.
 *
 * Hiçbir sürücü tahmini DEĞİŞTİRMEZ — hepsi zaten hesaplanmış hücre
 * değerlerinin ve ham satır kümesinin okunmasıdır.
 */
export function buildCashScenarioDrivers(params: {
  cell: CashScenarioCell;
  rows: readonly CashScenarioRow[];
  thresholds: InsightThresholds;
  formatDate: (value: Date) => string;
}): CashScenarioDriver[] {
  const { cell, rows, thresholds, formatDate } = params;
  const drivers: CashScenarioDriver[] = [];

  const collections = toDecimal(cell.expectedCollections);
  const payments = toDecimal(cell.expectedPayments);
  const periodLabel = formatHalfOpenPeriod(cell.windowStart, cell.windowEnd);
  const scenarioLabel = CASH_SCENARIO_LABELS[cell.scenario];

  const push = (
    type: CashScenarioDriverType,
    severity: InsightSeverity,
    magnitude: Prisma.Decimal,
    evidence: EvidenceValue[],
    facts: string,
  ) => {
    drivers.push({
      id: driverId(type, cell.scenario, cell.horizonDays),
      type,
      severity,
      scenario: cell.scenario,
      horizonDays: cell.horizonDays,
      title: CASH_SCENARIO_DRIVER_TITLES[type],
      magnitude: magnitude.abs().toString(),
      evidence,
      facts,
      defaultAction: CASH_SCENARIO_DRIVER_ACTIONS[type],
    });
  };

  // 1) Kırılma tarihi — yalnızca nakit görünürlüğü varsa anlamlıdır.
  if (cell.breakDate && cell.minimumCashPoint) {
    const minimumAmount = toDecimal(cell.minimumCashPoint.amount);
    const whenLabel = cell.alreadyNegativeAtOpening
      ? "bugün (açılış bakiyesi zaten negatif)"
      : formatDate(cell.breakDate);
    push(
      "PROJECTED_CASH_BREAK",
      "CRITICAL",
      minimumAmount,
      [
        text("Kırılma tarihi", whenLabel),
        money("En düşük nakit", cell.minimumCashPoint.amount),
        text("Senaryo", scenarioLabel),
      ],
      `${scenarioLabel} altında ${periodLabel} penceresinde projekte nakit ${whenLabel} tarihinde sıfırın altına iner; en düşük nokta ${formatMoney(cell.minimumCashPoint.amount)}.`,
    );
  }

  // 2) Dönem sonu negatif nakit (kırılmadan bağımsız: kırılmadan kapanış negatif olabilir).
  if (cell.endingCash !== null) {
    const endingCash = toDecimal(cell.endingCash);
    if (endingCash.lessThan(ZERO)) {
      push(
        "NEGATIVE_PROJECTED_ENDING_CASH",
        "CRITICAL",
        endingCash,
        [money("Tahmini kapanış nakdi", cell.endingCash), text("Senaryo", scenarioLabel)],
        `${scenarioLabel} altında ${periodLabel} sonunda projekte nakit ${formatMoney(cell.endingCash)} ile negatiftir.`,
      );
    } else if (cell.openingCash !== null) {
      // 3) Tampon erimesi — YF-702'nin `cashProjectionWarningRatio` eşiği aynen kullanılır.
      const openingCash = toDecimal(cell.openingCash);
      const warningFloor = openingCash.times(toDecimal(thresholds.cashProjectionWarningRatio));
      if (openingCash.greaterThan(ZERO) && endingCash.lessThan(warningFloor)) {
        push(
          "CASH_BUFFER_EROSION",
          "HIGH",
          openingCash.minus(endingCash),
          [
            money("Açılış nakdi", cell.openingCash),
            money("Tahmini kapanış nakdi", cell.endingCash),
            text("Senaryo", scenarioLabel),
          ],
          `${scenarioLabel} altında ${periodLabel} penceresinde nakit ${formatMoney(cell.openingCash)} seviyesinden ${formatMoney(cell.endingCash)} seviyesine iner.`,
        );
      }
    }
  }

  // 4) Vadesi geçmiş alacak maruziyeti — YF-702 `overdueReceivableHighRatio` eşiği.
  const overdueReceivable = toDecimal(cell.overdueReceivableIncluded);
  if (overdueReceivable.greaterThan(ZERO)) {
    const ratio = safeRatio(overdueReceivable, collections);
    const isHigh = ratio !== null && ratio.greaterThanOrEqualTo(toDecimal(thresholds.overdueReceivableHighRatio));
    const evidence: EvidenceValue[] = [money("Vadesi geçmiş alacak", cell.overdueReceivableIncluded)];
    if (ratio !== null) evidence.push(percent("Tahmini tahsilat içindeki payı", toPercentString(ratio)));
    push(
      "OVERDUE_RECEIVABLE_EXPOSURE",
      isHigh ? "HIGH" : "MEDIUM",
      overdueReceivable,
      evidence,
      `${periodLabel} tahminindeki tahsilatlarının ${formatMoney(cell.overdueReceivableIncluded)} tutarındaki kısmı vadesi ZATEN GEÇMİŞ alacaklardan gelmektedir${
        ratio !== null ? ` (payı %${toPercentString(ratio)})` : ""
      }.`,
    );
  }

  // 5) Vadesi geçmiş borç yükü.
  const overduePayable = toDecimal(cell.overduePayableIncluded);
  if (overduePayable.greaterThan(ZERO)) {
    push(
      "OVERDUE_PAYABLE_EXPOSURE",
      "MEDIUM",
      overduePayable,
      [money("Vadesi geçmiş borç", cell.overduePayableIncluded)],
      `${periodLabel} tahminindeki ödemelerinin ${formatMoney(cell.overduePayableIncluded)} tutarındaki kısmı vadesi ZATEN GEÇMİŞ borçlardan oluşmaktadır.`,
    );
  }

  // 6) Tahsilat/ödeme dengesizliği — YF-702-F1 karşılama oranı eşikleri aynen kullanılır.
  if (payments.greaterThan(ZERO)) {
    const coverage = safeRatio(collections, payments);
    const netOutflow = payments.minus(collections);
    const minNetOutflow = toDecimal(thresholds.collectionPaymentImbalanceMinNetOutflow);
    if (
      coverage !== null &&
      coverage.lessThanOrEqualTo(toDecimal(thresholds.collectionPaymentImbalanceMaxCoverageRatio)) &&
      netOutflow.greaterThanOrEqualTo(minNetOutflow)
    ) {
      const isHigh = coverage.lessThanOrEqualTo(toDecimal(thresholds.collectionPaymentImbalanceHighCoverageRatio));
      push(
        "NEAR_TERM_PAYABLE_CONCENTRATION",
        isHigh ? "HIGH" : "MEDIUM",
        netOutflow,
        [
          money("Tahmini tahsilat", cell.expectedCollections),
          money("Tahmini ödeme", cell.expectedPayments),
          percent("Karşılama oranı", toPercentString(coverage)),
        ],
        `${scenarioLabel} altında ${periodLabel} penceresinde tahsilatlar (${formatMoney(cell.expectedCollections)}) ödemelerin (${formatMoney(cell.expectedPayments)}) yalnızca %${toPercentString(coverage)}'ini karşılamaktadır.`,
      );
    }
  }

  // 7) Tek alacakta yoğunlaşma — YF-702 `expenseConcentrationMinSharePercent` payı aynen kullanılır.
  if (collections.greaterThan(ZERO)) {
    // KRİTİK: pay ve payda AYNI kümeden gelmelidir. `collections` bu hücrenin
    // ufkuyla sınırlı ve senaryo gecikmesi uygulanmış toplamdır; bu yüzden en
    // büyük alacak da yalnızca AYNI pencereye düşen satırlar arasından
    // seçilir. Tüm satır kümesi taransaydı (90 güne kadar), 30 günlük bir
    // hücrede pencere DIŞINDAKİ bir alacak paya girer ve %100'ü çok aşan
    // anlamsız bir "pay" üretirdi — üstelik bu sayı deterministik katmandan
    // çıktığı için modele değiştirilemez bir OLGU olarak gider.
    const collectionDelayDays = CASH_SCENARIO_DELAY_DAYS[cell.scenario].collectionDelayDays;
    let largest: Prisma.Decimal = ZERO;
    let incomeRowCount = 0;
    for (const r of rows) {
      if (r.type !== "INCOME") continue;
      const shifted =
        collectionDelayDays === 0 ? r.dueDate : addIstanbulDays(r.dueDate, collectionDelayDays);
      // Kırpma yalnızca alt sınırı etkiler: pencereden önceye düşen kayıtlar
      // gün 0'a çekilir ve her zaman pencere içindedir.
      if (shifted.getTime() >= cell.windowEnd.getTime()) continue;
      incomeRowCount += 1;
      if (r.remaining.greaterThan(largest)) largest = r.remaining;
    }
    const share = safeRatio(largest, collections);
    const minShare = toDecimal(thresholds.expenseConcentrationMinSharePercent).div(100);
    if (
      share !== null &&
      incomeRowCount >= thresholds.expenseConcentrationMinCategoryCount &&
      share.greaterThanOrEqualTo(minShare)
    ) {
      push(
        "RECEIVABLE_CONCENTRATION",
        share.greaterThanOrEqualTo(toDecimal(thresholds.expenseConcentrationHighSharePercent).div(100))
          ? "HIGH"
          : "MEDIUM",
        largest,
        [money("En büyük tek alacak", largest.toString()), percent("Tahmindeki payı", toPercentString(share))],
        `${periodLabel} tahmininde beklenen tahsilatların %${toPercentString(share)}'i tek bir alacaktan (${formatMoney(largest.toString())}) gelmektedir.`,
      );
    }
  }

  return drivers;
}

const SEVERITY_RANK: Record<InsightSeverity, number> = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 };

function compareDrivers(a: CashScenarioDriver, b: CashScenarioDriver): number {
  const bySeverity = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
  if (bySeverity !== 0) return bySeverity;
  const byMagnitude = toDecimal(b.magnitude).comparedTo(toDecimal(a.magnitude));
  if (byMagnitude !== 0) return byMagnitude;
  // Eşitlikte daha KISA ufuk önce gelir: "30 günde kırılıyor", "90 günde
  // kırılıyor"dan daha acildir.
  if (a.horizonDays !== b.horizonDays) return a.horizonDays - b.horizonDays;
  return a.id.localeCompare(b.id, "tr");
}

/**
 * Sürücüleri TÜRE GÖRE TEKİLLEŞTİRİR, sonra önem/büyüklük sırasına dizer.
 *
 * Neden tekilleştirme zorunlu: sürücüler dokuz hücrenin (3 senaryo × 3 ufuk)
 * her biri için ayrı ayrı üretilir, dolayısıyla AYNI risk en fazla dokuz kez
 * görünebilir. Tekilleştirme olmadan tek bir tür (ör. negatif kapanış nakdi)
 * listenin tamamını doldurur ve daha kritik ama tek örnekli bir tür (ör.
 * kırılma tarihi) listeden TAŞAR — kullanıcıya dokuz kez aynı cümle, AI'ya da
 * atıfta bulunacağı tek bir kırılma sürücüsü kalmaz.
 *
 * Her tür için EN KÖTÜ örnek saklanır (en yüksek önem, sonra en büyük tutar,
 * sonra en KISA ufuk) — böylece liste "hangi riskler var" sorusunu yanıtlar,
 * "aynı risk kaç hücrede tekrarlıyor" sorusunu değil.
 *
 * Büyüklük karşılaştırması `Decimal.comparedTo` ile yapılır — `Number(...)`
 * dönüşümü YASAKTIR (bkz. tests/ai-insights-decimal-sort.test.ts, aynı sınıf
 * hatanın YF-702'de kalıcı olarak kapatıldığı yer).
 */
export function rankCashScenarioDrivers(
  drivers: readonly CashScenarioDriver[],
  limit: number,
): CashScenarioDriver[] {
  const worstByType = new Map<CashScenarioDriverType, CashScenarioDriver>();
  for (const driver of drivers) {
    const current = worstByType.get(driver.type);
    if (!current || compareDrivers(driver, current) < 0) worstByType.set(driver.type, driver);
  }
  return [...worstByType.values()].sort(compareDrivers).slice(0, limit);
}
