import { formatDate } from "@/lib/utils";
import { toDecimal, ZERO } from "@/server/services/ledger";
import type { BudgetReport, BudgetStatus } from "@/server/services/budget-report-service";
import type { CashFlowReport, MaturityBuckets } from "@/server/services/cash-flow-report-service";
import type { ProjectMarginComparison } from "@/server/services/project-margin-service";
import type { InsightEvidence, InsightSeverity, InsightType } from "@/lib/ai/insights/schema";
import { buildEvidence, money, percent, percentagePoint, text } from "@/lib/ai/insights/evidence";
import type { InsightThresholds } from "@/lib/ai/insights/thresholds";

/**
 * YF-702 — Deterministik finansal erken uyarı KURAL MOTORU.
 *
 * Önceki hâlinde tüm sinyal çıkarımı, gömülü sihirli eşiklerle tek bir ~145
 * satırlık fonksiyonun içindeydi; yeni bir kural eklemek o fonksiyonu
 * büyütmek, tek bir kuralı test etmek ise tüm zinciri çalıştırmak demekti.
 * Artık her kural, kendi kimliği ve kendi `evaluate` fonksiyonu olan bağımsız
 * bir `InsightRule`'dür ve `INSIGHT_RULES` dizisine kaydedilir — yeni bir
 * sinyal eklemek yalnızca yeni bir kural yazıp bu diziye eklemektir.
 *
 * Mimari sınır (değişmedi): bu modül HİÇBİR Prisma sorgusu yapmaz. Tüm
 * finansal olgular, zaten tenant/rol kapsamlı olan kanonik rapor
 * servislerinin (`getBudgetReport`, `getCashFlowReport`) çıktısından okunur —
 * hiçbir finansal formül burada YENİDEN hesaplanmaz. Kurallar yalnızca eşik
 * karşılaştırması yapar ve `Prisma.Decimal` üzerinden çalışır (kayan nokta
 * ASLA kullanılmaz).
 */

export interface FinancialSignal {
  id: string;
  type: InsightType;
  severity: InsightSeverity;
  affectedProjectId: string | null;
  affectedProjectName: string | null;
  /** Tamamen deterministik, tipli kanıt — AI bunu asla üretmez/değiştirmez. */
  evidence: InsightEvidence;
  /** Modelin yorumlayacağı, önceden hesaplanmış Türkçe olgu cümlesi. */
  facts: string;
}

/**
 * YF-702-F1 — GERÇEKLEŞEN (settlement bazlı) tahsilat/ödeme toplamları,
 * kapanmış bir geçmiş dönem için.
 *
 * Neden ayrı bir bağlam alanı: `CashFlowReport.summary.realizedCollections`
 * alanı da aynı kanonik servisten (`getSettlementTotalsForRange`) gelir, ancak
 * o rapor içgörü akışında varsayılan `NEXT_30_DAYS` (İLERİ dönük) penceresiyle
 * çalışır — gelecekteki bir pencerede "gerçekleşen" tahsilat neredeyse her
 * zaman sıfırdır ve dengesizlik ölçümü için anlamsızdır. Bu yüzden bu alan,
 * aynı servise GERİYE dönük bir dönemle yapılan tek bir çağrının sonucunu
 * taşır (bkz. server/services/ai-insights-service.ts).
 *
 * Değerler kural motoruna Decimal string olarak girer; hiçbir toplam burada
 * yeniden hesaplanmaz.
 */
export interface SettlementPeriodTotals {
  /** Dönemde gerçekleşen toplam tahsilat. */
  collected: string;
  /** Dönemde gerçekleşen toplam ödeme. */
  paid: string;
  /** Servisin ürettiği net akış (tahsilat − ödeme) — burada YENİDEN türetilmez. */
  net: string;
  rangeStart: Date;
  /** Dönem sonu (hariç). */
  rangeEnd: Date;
}

export interface InsightRuleContext {
  budget: BudgetReport;
  cashFlow: CashFlowReport;
  settlement: SettlementPeriodTotals;
  /**
   * YF-702-F3 — Aktörün kapsamındaki TÜM projelerin cari/önceki dönem marjı,
   * kanonik `getProjectMarginComparison` çıktısı olarak. Kural motoru bu
   * servisi ASLA kendisi çağırmaz (bkz. modül başlığı: burada Prisma yoktur);
   * servis, proje sayısından bağımsız sabit sayıda sorguyla TEK SEFER
   * çağrılır (bkz. server/services/ai-insights-service.ts) — kural başına
   * veya proje başına sorgu YOKTUR.
   */
  projectMargin: ProjectMarginComparison;
  thresholds: InsightThresholds;
}

export interface InsightRule {
  /** Kararlı kural kimliği — log/test tarafından referans alınır, sinyal id'siyle karıştırılmamalıdır. */
  readonly id: string;
  /**
   * Bu kuralın ürettiği sinyaller. `emitted`, kendisinden ÖNCE çalışmış
   * kuralların sinyalleridir — birleşik risk kuralları (bkz.
   * `projectDeteriorationRule`) bunu okuyarak kendi başına aynı veriyi
   * yeniden türetmek zorunda kalmaz. Sıra bu yüzden anlamlıdır ve
   * `INSIGHT_RULES` dizisindeki sırayla sabittir.
   */
  evaluate(ctx: InsightRuleContext, emitted: readonly FinancialSignal[]): FinancialSignal[];
}

const SEVERITY_RANK: Record<InsightSeverity, number> = { CRITICAL: 3, HIGH: 2, MEDIUM: 1, LOW: 0 };

/** Bütçe durumu kodlarının kullanıcıya gösterilebilir Türkçe karşılıkları (bkz. CLAUDE.md madde 8 — arayüze ham enum sızmamalıdır). */
const BUDGET_STATUS_LABELS: Record<BudgetStatus, string> = {
  NORMAL: "Normal",
  CRITICAL: "Kritik",
  OVER_BUDGET: "Bütçe aşımı",
  NO_BUDGET: "Bütçe tanımsız",
};

function formatPeriod(rangeStart: Date, rangeEnd: Date): string {
  return `${formatDate(rangeStart)} - ${formatDate(rangeEnd)}`;
}

/**
 * YF-702-F3 — `getDateRange`/`getPriorDateRange` YARI AÇIK aralık üretir
 * (`issueDate >= start AND < end`), yani `end` dönemin İÇİNDE DEĞİLDİR.
 * Kullanıcıya gösterilen dönem etiketi son GÜNÜ içermelidir (bkz.
 * lib/ai/insights/schema.ts `period` doküman notu: `"01.08.2026 - 31.08.2026"`),
 * bu yüzden bitiş sınırı bir milisaniye geriye alınarak biçimlendirilir.
 */
function formatHalfOpenPeriod(rangeStart: Date, rangeEndExclusive: Date): string {
  return `${formatDate(rangeStart)} - ${formatDate(new Date(rangeEndExclusive.getTime() - 1))}`;
}

function sumMaturityBuckets(buckets: MaturityBuckets) {
  return (
    [
      buckets.overdue,
      buckets.dueToday,
      buckets.next7Days,
      buckets.next30Days,
      buckets.days31to60,
      buckets.days61to90,
      buckets.over90Days,
      buckets.noDueDate,
    ] as const
  ).reduce((sum, v) => sum.plus(toDecimal(v)), ZERO);
}

const budgetOverrunRule: InsightRule = {
  id: "budget-overrun",
  evaluate({ budget }) {
    return budget.overBudgetProjects.map((row) => ({
      id: `budget_overrun:${row.projectId}`,
      type: "BUDGET_OVERRUN" as const,
      severity: "CRITICAL" as const,
      affectedProjectId: row.projectId,
      affectedProjectName: row.name,
      evidence: buildEvidence({
        currentValue: money("Gerçekleşen gider", row.realizedExpenses),
        comparisonValue: money("Planlanan bütçe", row.estimatedBudget),
        difference: money("Bütçe aşımı", row.overrunAmount),
        percentageChange: row.overrunPercentage,
      }),
      facts: `"${row.name}" projesi planlanan bütçeyi ${row.overrunAmount} TL (%${row.overrunPercentage}) aştı. Planlanan bütçe: ${row.estimatedBudget} TL, gerçekleşen gider: ${row.realizedExpenses} TL.`,
    }));
  },
};

const budgetNearOverrunRule: InsightRule = {
  id: "budget-near-overrun",
  evaluate({ budget }) {
    return budget.atRiskProjects.map((row) => ({
      id: `budget_near_overrun:${row.projectId}`,
      type: "BUDGET_NEAR_OVERRUN" as const,
      severity: "HIGH" as const,
      affectedProjectId: row.projectId,
      affectedProjectName: row.name,
      evidence: buildEvidence({
        currentValue: money("Gerçekleşen gider", row.realizedExpenses),
        comparisonValue: money("Planlanan bütçe", row.estimatedBudget),
        difference: money("Kalan bütçe", row.remainingAmount),
        // Bütçe kullanım oranı bir DEĞİŞİM değil, bir orandır — bu yüzden
        // `percentageChange` alanına yazılmaz (o alan işaretli sapma içindir).
        details: [percent("Bütçe kullanım oranı", row.usagePercentage ?? "0")],
      }),
      facts: `"${row.name}" projesi bütçesinin %${row.usagePercentage}'ini kullandı. Planlanan bütçe: ${row.estimatedBudget} TL, kalan: ${row.remainingAmount} TL.`,
    }));
  },
};

const cashFlowPressureRule: InsightRule = {
  id: "cash-flow-pressure",
  evaluate({ cashFlow, thresholds }) {
    // Proje yöneticisi kapsamında organizasyon geneli kasa/banka bakiyesi
    // TANIMLI DEĞİLDİR (bkz. ProjectManagerCashFlowReport — openingBalance
    // alanı yoktur), bu yüzden bu kural yalnızca organizasyon kapsamında
    // çalışır. Veri yokken uyarı üretilmez.
    if (cashFlow.scope !== "ORGANIZATION") return [];

    const openingBalance = toDecimal(cashFlow.openingBalance);
    const projectedClosingBalance = toDecimal(cashFlow.projectedClosingBalance);
    const delta = projectedClosingBalance.minus(openingBalance);
    const period = formatPeriod(cashFlow.rangeStart, cashFlow.rangeEnd);

    const base = {
      id: "cash_flow_pressure:org",
      type: "CASH_FLOW_PRESSURE" as const,
      affectedProjectId: null,
      affectedProjectName: null,
      evidence: buildEvidence({
        currentValue: money("Tahmini kapanış bakiyesi", cashFlow.projectedClosingBalance),
        comparisonValue: money("Güncel kasa/banka bakiyesi", cashFlow.openingBalance),
        difference: money("Beklenen bakiye değişimi", delta.toString()),
        percentageChange: openingBalance.greaterThan(ZERO)
          ? delta.div(openingBalance).mul(100).toDecimalPlaces(1).toString()
          : null,
        period,
      }),
    };

    if (projectedClosingBalance.lessThan(ZERO)) {
      return [
        {
          ...base,
          severity: "CRITICAL" as const,
          facts: `Güncel kasa/banka bakiyesi ${cashFlow.openingBalance} TL. Planlanan tahsilat ve ödemeler gerçekleştiğinde tahmini kapanış bakiyesi ${cashFlow.projectedClosingBalance} TL (negatif) olacak.`,
        },
      ];
    }

    const warningFloor = openingBalance.mul(thresholds.cashProjectionWarningRatio);
    if (openingBalance.greaterThan(ZERO) && projectedClosingBalance.lessThan(warningFloor)) {
      return [
        {
          ...base,
          severity: "HIGH" as const,
          facts: `Güncel kasa/banka bakiyesi ${cashFlow.openingBalance} TL. Planlanan tahsilat ve ödemeler sonrası tahmini kapanış bakiyesi ${cashFlow.projectedClosingBalance} TL'ye düşüyor (açılış bakiyesinin %${toDecimal(thresholds.cashProjectionWarningRatio).mul(100).toString()}'sinin altında).`,
        },
      ];
    }

    return [];
  },
};

/**
 * YF-702-F1 — Tahsilat/ödeme dengesizliği.
 *
 * Kapanmış bir dönemde GERÇEKLEŞEN (settlement bazlı) ödemelerin tahsilatları
 * maddi olarak aşıp aşmadığını ölçer. Girdilerin tamamı kanonik
 * `getSettlementTotalsForRange` çıktısıdır; burada hiçbir işlem toplanmaz,
 * hiçbir formül yeniden hesaplanmaz.
 *
 * İki kapı birlikte çalışır ve İKİSİ de aşılmadıkça uyarı üretilmez:
 *   1. Mutlak: net nakit çıkışı (ödeme − tahsilat) gürültü tabanına ulaşmalı.
 *   2. Göreli: tahsilat/ödeme karşılama oranı eşiğe eşit veya altında olmalı.
 *
 * Ödeme sıfırsa oran TANIMSIZDIR (0'a bölme) ve zaten net çıkış da negatif
 * veya sıfırdır — bu durumda uyarı ÜRETİLMEZ, uydurulmuş bir yüzde de
 * hesaplanmaz.
 */
const collectionPaymentImbalanceRule: InsightRule = {
  id: "collection-payment-imbalance",
  evaluate({ settlement, thresholds }) {
    const collected = toDecimal(settlement.collected);
    const paid = toDecimal(settlement.paid);

    // Ödeme yoksa dengesizlik tanımlı değildir; "her iki taraf da sıfır"
    // durumu da buraya düşer (veri yokken uyarı üretilmez).
    if (!paid.greaterThan(ZERO)) return [];

    const netOutflow = paid.minus(collected);
    if (!netOutflow.greaterThanOrEqualTo(thresholds.collectionPaymentImbalanceMinNetOutflow)) return [];

    const coverageRatio = collected.div(paid);
    if (!coverageRatio.lessThanOrEqualTo(thresholds.collectionPaymentImbalanceMaxCoverageRatio)) return [];

    const coveragePercent = coverageRatio.mul(100).toDecimalPlaces(1);
    // Ödemeye göre işaretli sapma: paydası (ödeme) burada her zaman > 0
    // olduğundan matematiksel olarak geçerlidir.
    const percentageChange = collected.minus(paid).div(paid).mul(100).toDecimalPlaces(1).toString();
    const period = formatPeriod(settlement.rangeStart, settlement.rangeEnd);

    return [
      {
        id: "collection_payment_imbalance:org",
        type: "COLLECTION_PAYMENT_IMBALANCE" as const,
        severity: coverageRatio.lessThanOrEqualTo(thresholds.collectionPaymentImbalanceHighCoverageRatio)
          ? ("HIGH" as const)
          : ("MEDIUM" as const),
        affectedProjectId: null,
        affectedProjectName: null,
        evidence: buildEvidence({
          currentValue: money("Dönemde gerçekleşen tahsilat", settlement.collected),
          comparisonValue: money("Dönemde gerçekleşen ödeme", settlement.paid),
          difference: money("Net nakit akışı", settlement.net),
          percentageChange,
          period,
          details: [percent("Tahsilatın ödemeleri karşılama oranı", coveragePercent.toString())],
        }),
        facts: `${period} döneminde gerçekleşen tahsilat ${settlement.collected} TL, gerçekleşen ödeme ${settlement.paid} TL oldu; ödemeler tahsilatları ${netOutflow.toString()} TL aştı (tahsilatlar ödemelerin yalnızca %${coveragePercent}'ini karşılıyor).`,
      },
    ];
  },
};

const overdueReceivablesOrgRule: InsightRule = {
  id: "overdue-receivables-org",
  evaluate({ cashFlow, thresholds }) {
    const overdueReceivable = toDecimal(cashFlow.receivableBuckets.overdue);
    if (!overdueReceivable.greaterThan(ZERO)) return [];

    const totalOpenReceivable = sumMaturityBuckets(cashFlow.receivableBuckets);
    const ratio = totalOpenReceivable.greaterThan(ZERO) ? overdueReceivable.div(totalOpenReceivable) : ZERO;
    const ratioPercent = ratio.mul(100).toDecimalPlaces(1);

    return [
      {
        id: "overdue_receivables:org",
        type: "OVERDUE_RECEIVABLES" as const,
        severity: ratio.greaterThanOrEqualTo(thresholds.overdueReceivableHighRatio) ? ("HIGH" as const) : ("MEDIUM" as const),
        affectedProjectId: null,
        affectedProjectName: null,
        evidence: buildEvidence({
          currentValue: money("Vadesi geçmiş alacak", cashFlow.receivableBuckets.overdue),
          comparisonValue: money("Toplam açık alacak", totalOpenReceivable.toString()),
          details: [percent("Vadesi geçmiş alacak oranı", ratioPercent.toString())],
          period: formatPeriod(cashFlow.rangeStart, cashFlow.rangeEnd),
        }),
        facts: `Vadesi geçmiş toplam alacak ${cashFlow.receivableBuckets.overdue} TL (açık toplam alacağın %${ratioPercent}'i).`,
      },
    ];
  },
};

const overdueReceivablesProjectRule: InsightRule = {
  id: "overdue-receivables-project",
  evaluate({ cashFlow, thresholds }) {
    return cashFlow.projectComparison
      .filter((p) => toDecimal(p.overdueReceivable).greaterThan(ZERO))
      // Decimal karşılaştırması ZORUNLUDUR — `Number()`'a düşürmek yüksek
      // hassasiyetli tutarlarda top-N sınırında yanlış projeyi seçebilir
      // (bkz. tests/ai-insights-decimal-sort.test.ts).
      .sort((a, b) => toDecimal(b.overdueReceivable).comparedTo(toDecimal(a.overdueReceivable)))
      .slice(0, thresholds.maxOverdueProjectSignals)
      .map((row) => ({
        id: `overdue_receivables:${row.projectId}`,
        type: "OVERDUE_RECEIVABLES" as const,
        severity: "MEDIUM" as const,
        affectedProjectId: row.projectId,
        affectedProjectName: row.name,
        evidence: buildEvidence({
          currentValue: money("Vadesi geçmiş alacak", row.overdueReceivable),
          period: formatPeriod(cashFlow.rangeStart, cashFlow.rangeEnd),
        }),
        facts: `"${row.name}" projesinde vadesi geçmiş ${row.overdueReceivable} TL alacak bulunuyor.`,
      }));
  },
};

const expenseConcentrationRule: InsightRule = {
  id: "expense-concentration",
  evaluate({ budget, thresholds }) {
    // Tek kategorili bir organizasyonda "%100 yoğunlaşma" matematiksel bir
    // zorunluluktur, finansal bir uyarı değildir — yetersiz veriyle uyarı
    // üretilmez (bkz. thresholds.expenseConcentrationMinCategoryCount).
    if (budget.categoryAnalysis.length < thresholds.expenseConcentrationMinCategoryCount) return [];

    const top = budget.categoryAnalysis[0];
    const share = toDecimal(top.shareOfTotal ?? "0");
    if (!share.greaterThanOrEqualTo(thresholds.expenseConcentrationMinSharePercent)) return [];

    return [
      {
        id: `expense_concentration:${top.categoryId}`,
        type: "EXPENSE_CONCENTRATION" as const,
        severity: share.greaterThanOrEqualTo(thresholds.expenseConcentrationHighSharePercent)
          ? ("HIGH" as const)
          : ("MEDIUM" as const),
        affectedProjectId: null,
        affectedProjectName: null,
        evidence: buildEvidence({
          currentValue: money("Kategori gideri", top.recordedExpense),
          comparisonValue: money("Toplam gerçekleşen gider", budget.metrics.totalRealizedExpenses),
          details: [text("Gider kategorisi", top.name), percent("Toplam gider içindeki payı", top.shareOfTotal ?? "0")],
        }),
        facts: `"${top.name}" gider kategorisi toplam giderlerin %${top.shareOfTotal}'ini oluşturuyor (${top.recordedExpense} TL).`,
      },
    ];
  },
};

/**
 * YF-702-F3 — Proje kâr marjının dönemler arası GERİLEMESİ.
 *
 * ## Ölçü: yüzde PUAN
 *
 * Marjın kendisi zaten bir yüzdedir; iki dönem arasındaki farkı yeniden
 * yüzde olarak ifade etmek belirsizdir. "%24 → %14" bu kuralda 10 yüzde
 * PUANlık gerilemedir (göreli olarak %41,67'lik marj kaybına karşılık gelir,
 * ancak o AYRI bir metriktir ve burada üretilmez —
 * `evidence.percentageChange` bilinçli olarak `null` bırakılır).
 *
 * ## Girdi: kanonik F2 servisi
 *
 * Gelir/gider/kâr/marj burada YENİDEN hesaplanmaz; `getProjectMarginComparison`
 * çıktısı otoritedir (tahakkuk bazlı, `CANCELLED` hariç, transferler yapısal
 * olarak dışarıda, tahsilat/ödeme verisi marja KARIŞTIRILMAZ). Tenant ve rol
 * kapsamı da tamamen o servise aittir — burada ikinci bir kapsam çözümleyicisi
 * YOKTUR.
 *
 * ## Marj tanımsızsa
 *
 * F2, gelir sıfır/negatifse marjı `null` döndürür (bkz. `ProjectPeriodMargin`).
 * `null` ASLA `0` sayılmaz: iki dönemden herhangi birinin marjı tanımsızsa
 * karşılaştırma yapılamaz ve sinyal ÜRETİLMEZ — uydurulmuş bir taban
 * üzerinden "gerileme" iddia edilmez.
 *
 * ## Negatif marj
 *
 * Marj, gelir > 0 olan HER durumda tanımlıdır; negatif marj (zarar eden ama
 * geliri olan proje) geçerli bir değerdir ve özel olarak ele ALINMAZ. Puan
 * farkı işaretten bağımsız aynı anlamı taşır: `%5 → %-10` 15 puan, `%-10 →
 * %-30` 20 puanlık gerilemedir ve ikisi de sinyal üretir. Küçük paydalarda
 * marjın patlaması (`1 TL gelir` → `%-99.900`) bir MARJ sorunu değil bir
 * ÖLÇEK sorunudur; buna karşı özel bir işaret kuralı değil, iki döneme de
 * uygulanan gelir tabanı (`projectMarginDeteriorationMinRevenue`) korur.
 *
 * ## Gürültü koruması ve üst sınır
 *
 * İki kapı birlikte çalışır: gelir tabanı (her iki dönem) ve en az puan
 * gerilemesi. Aday sayısı proje sayısı kadar olabileceğinden çıktı
 * `maxProjectMarginSignals` ile sınırlanır; seçim DETERMİNİSTİKtir ve DB satır
 * sırasına DUYARSIZdır (en sert gerileme → daha büyük cari gelir → proje id).
 */
const projectMarginDeteriorationRule: InsightRule = {
  id: "project-margin-deterioration",
  evaluate({ projectMargin, thresholds }) {
    const minRevenue = toDecimal(thresholds.projectMarginDeteriorationMinRevenue);
    const currentPeriodLabel = formatHalfOpenPeriod(projectMargin.currentPeriod.start, projectMargin.currentPeriod.end);
    const priorPeriodLabel = formatHalfOpenPeriod(projectMargin.priorPeriod.start, projectMargin.priorPeriod.end);

    const candidates = projectMargin.rows.flatMap((row) => {
      // Tanımsız marj `0` KABUL EDİLMEZ; karşılaştırma yapılamaz.
      const currentMargin = row.current.margin;
      const priorMargin = row.prior.margin;
      if (currentMargin === null || priorMargin === null) return [];

      const currentRevenue = toDecimal(row.current.revenue);
      if (currentRevenue.lessThan(minRevenue)) return [];
      if (toDecimal(row.prior.revenue).lessThan(minRevenue)) return [];

      // Yalnızca GERİLEME tetikler: sabit veya iyileşen marjda fark ≤ 0 olur
      // ve eşiği (pozitif) asla geçemez.
      const declinePoints = toDecimal(priorMargin).minus(toDecimal(currentMargin));
      if (!declinePoints.greaterThanOrEqualTo(thresholds.projectMarginDeteriorationMinPoints)) return [];

      return [{ row, currentMargin, priorMargin, declinePoints, currentRevenue }];
    });

    return candidates
      .sort((a, b) => {
        const byDecline = b.declinePoints.comparedTo(a.declinePoints);
        if (byDecline !== 0) return byDecline;
        const byRevenue = b.currentRevenue.comparedTo(a.currentRevenue);
        if (byRevenue !== 0) return byRevenue;
        return a.row.projectId.localeCompare(b.row.projectId);
      })
      .slice(0, thresholds.maxProjectMarginSignals)
      .map(({ row, currentMargin, priorMargin, declinePoints }) => ({
        id: `project_margin_deterioration:${row.projectId}`,
        type: "PROJECT_MARGIN_DETERIORATION" as const,
        severity: declinePoints.greaterThanOrEqualTo(thresholds.projectMarginDeteriorationHighPoints)
          ? ("HIGH" as const)
          : ("MEDIUM" as const),
        affectedProjectId: row.projectId,
        affectedProjectName: row.projectName,
        evidence: buildEvidence({
          currentValue: percent("Cari dönem kâr marjı", currentMargin),
          comparisonValue: percent("Önceki dönem kâr marjı", priorMargin),
          // İŞARETLİ puan farkı (cari − önceki); gerileme her zaman negatiftir.
          difference: percentagePoint("Marj değişimi", declinePoints.negated().toString()),
          // `percentageChange` KASITLI olarak null: göreli marj kaybı (%41,67)
          // puan farkıyla (10 puan) karıştırılmaya çok açık AYRI bir metriktir
          // ve bu sinyalin otoritesi puan farkıdır (bkz. kural başlığı).
          period: currentPeriodLabel,
          details: [
            money("Cari dönem geliri", row.current.revenue),
            money("Cari dönem kârı", row.current.profit),
            money("Önceki dönem geliri", row.prior.revenue),
            money("Önceki dönem kârı", row.prior.profit),
            text("Önceki dönem", priorPeriodLabel),
          ],
        }),
        facts: `"${row.projectName}" projesinin kâr marjı önceki dönemde (${priorPeriodLabel}) %${priorMargin} iken cari dönemde (${currentPeriodLabel}) %${currentMargin} oldu; ${declinePoints.toString()} yüzde puanlık gerileme var. Cari dönem geliri ${row.current.revenue} TL, kârı ${row.current.profit} TL; önceki dönem geliri ${row.prior.revenue} TL, kârı ${row.prior.profit} TL.`,
      }));
  },
};

const DETERIORATING_BUDGET_STATUSES: ReadonlySet<BudgetStatus> = new Set<BudgetStatus>(["OVER_BUDGET", "CRITICAL"]);

const projectDeteriorationRule: InsightRule = {
  id: "project-deterioration",
  evaluate({ budget, cashFlow }, emitted) {
    // Birleşik risk: aynı projede HEM bütçe baskısı HEM vadesi geçmiş alacak.
    // Vadesi geçmiş proje kümesi, daha önce çalışan kuraldan okunur — aynı
    // filtre/sıralama burada TEKRAR uygulanmaz (tek kaynak: o kural).
    const overdueProjectIds = new Set(
      emitted.filter((s) => s.type === "OVERDUE_RECEIVABLES" && s.affectedProjectId).map((s) => s.affectedProjectId as string),
    );

    const signals: FinancialSignal[] = [];
    for (const row of budget.projectComparison) {
      if (!DETERIORATING_BUDGET_STATUSES.has(row.status)) continue;
      if (!overdueProjectIds.has(row.projectId)) continue;
      const cashRow = cashFlow.projectComparison.find((p) => p.projectId === row.projectId);
      if (!cashRow) continue;

      signals.push({
        id: `project_deterioration:${row.projectId}`,
        type: "PROJECT_DETERIORATION",
        severity: "CRITICAL",
        affectedProjectId: row.projectId,
        affectedProjectName: row.name,
        evidence: buildEvidence({
          currentValue: money("Gerçekleşen gider", row.realizedExpenses),
          comparisonValue: money("Planlanan bütçe", row.estimatedBudget),
          details: [
            text("Bütçe durumu", BUDGET_STATUS_LABELS[row.status]),
            percent("Bütçe kullanım oranı", row.usagePercentage ?? "0"),
            money("Vadesi geçmiş alacak", cashRow.overdueReceivable),
          ],
        }),
        facts: `"${row.name}" projesi hem bütçe baskısı altında (durum: ${BUDGET_STATUS_LABELS[row.status]}, kullanım %${row.usagePercentage}) hem de ${cashRow.overdueReceivable} TL vadesi geçmiş alacağa sahip — birleşik risk.`,
      });
    }
    return signals;
  },
};

/**
 * Kayıtlı kural listesi. SIRA ANLAMLIDIR: `projectDeteriorationRule` kendinden
 * önce çalışan alacak kuralının çıktısını okur (bkz. `InsightRule.evaluate`).
 */
export const INSIGHT_RULES: readonly InsightRule[] = [
  budgetOverrunRule,
  budgetNearOverrunRule,
  cashFlowPressureRule,
  collectionPaymentImbalanceRule,
  overdueReceivablesOrgRule,
  overdueReceivablesProjectRule,
  expenseConcentrationRule,
  projectMarginDeteriorationRule,
  projectDeteriorationRule,
];

/**
 * Tüm kuralları sırayla çalıştırır ve sinyalleri önem derecesine (azalan),
 * eşitlikte kimliğe (artan) göre deterministik biçimde sıralar. Aynı girdi
 * her zaman aynı çıktıyı üretir — AI burada hiç devreye girmez.
 */
export function runInsightRules(ctx: InsightRuleContext): FinancialSignal[] {
  const signals: FinancialSignal[] = [];
  for (const rule of INSIGHT_RULES) {
    signals.push(...rule.evaluate(ctx, signals));
  }

  signals.sort((a, b) => {
    const rankDiff = SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity];
    if (rankDiff !== 0) return rankDiff;
    return a.id.localeCompare(b.id);
  });

  return signals;
}
