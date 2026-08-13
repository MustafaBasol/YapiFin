import type { Prisma, TransactionType } from "@prisma/client";
import { db } from "@/lib/db";
import { canViewAllProjects } from "@/lib/permissions";
import { toDecimal, ZERO } from "@/server/services/ledger";
import { computeProfitMarginPercent } from "@/server/services/project-finance-service";
import {
  getDateRange,
  getPriorDateRange,
  resolveActorReportScope,
  assertResolvedScopeForActor,
  type ActorReportScope,
  type DateRange,
} from "@/server/services/dashboard-service";
import type { SessionUser } from "@/lib/auth/session";
import type { DashboardPeriod } from "@/lib/validation/dashboard";

/**
 * YF-702-F2 — TOPLU (bulk) proje marj karşılaştırması: bir aktörün
 * yetkili olduğu TÜM projeler için, cari dönem ve onun HEMEN öncesindeki
 * eşdeğer dönem marjları.
 *
 * ## Neden ayrı bir servis
 *
 * `getProjectFinanceSummary` (server/services/project-finance-service.ts)
 * TEK bir projenin tam finans görünümünü üretir ve proje başına ~10 sorgu
 * çalıştırır (listeler, kategori dağılımı, aylık seri, settlement listesi...).
 * N proje için değerlendirilmesi gereken bir kural motoru (bkz.
 * server/services/ai-insights-rules.ts) için bu yapı kullanılamaz — ~10N
 * sorgu üretir. Bu servis aynı KANONİK finansal tanımları kullanır, ancak
 * proje sayısından BAĞIMSIZ, sabit sayıda sorguyla çalışır.
 *
 * ## Finansal tanımlar (yeniden hesaplanmaz, kanonik kaynaktan devralınır)
 *
 * - **Gelir** = dönem içinde kaydedilen (tahakkuk) INCOME toplamı —
 *   `getProjectFinanceSummary.totalRecordedIncome` ile AYNI yüklem:
 *   `status != CANCELLED`, `_sum.totalAmount`.
 * - **Gider** = aynı yüklemle EXPENSE toplamı (`totalRecordedExpense`).
 * - **Kâr** = gelir − gider — `accrualResult` ile AYNI tanım (TAHAKKUK
 *   bazlı). Nakit pozisyonu (tahsil edilen − ödenen) BİLİNÇLİ OLARAK
 *   karıştırılmaz: bu servis kârlılık ölçer, tahsilat performansı değil
 *   (bkz. project-finance-service.ts modül başlığındaki üç ayrı kâr kavramı).
 *   Bu nedenle KISMİ tahsilat/ödeme bu değerleri DEĞİŞTİRMEZ.
 * - **Marj** = `computeProfitMarginPercent(kâr, gelir)` — tek kanonik tanım
 *   (bkz. project-finance-service.ts). Gelir sıfır/negatifse `null`; `%0`
 *   UYDURULMAZ.
 *
 * İptal edilmiş (`CANCELLED`) kayıtlar tamamen hariçtir. Hesaplar arası
 * TRANSFERLER hiçbir zaman `FinancialTransaction` üretmez (yalnızca
 * `AccountTransfer` + `AccountMovement`, bkz.
 * server/services/transfer-service.ts) — bu yüzden işlem tablosu üzerinden
 * toplanan gelir/gider yapısal olarak transferleri İÇERMEZ, ek bir filtreye
 * gerek yoktur.
 *
 * ## Dönem
 *
 * Dönem sınırları `getDateRange`/`getPriorDateRange` ile Istanbul takvimine
 * göre belirlenir; iki dönem ÖRTÜŞMEZ (`priorPeriod.end === currentPeriod.start`)
 * ve iki taraf da AYNI şekilde dönem bazlıdır — bir tarafta ömür boyu toplam,
 * diğerinde dönem toplamı KULLANILMAZ. Kayıtlar `issueDate` üzerinden
 * dönemlenir; bu, uygulamadaki tüm dönemsel gelir/gider görünümleriyle
 * (dashboard aylık serisi, proje aylık trendi, bütçe kategori trendi) aynı
 * tarih alanıdır.
 *
 * ## Kapsam
 *
 * Rol/tenant kapsamı `resolveActorReportScope` ile TEK kaynaktan çözülür —
 * bu modülde paralel bir rol çözümleyici YOKTUR. Atanmış projesi olmayan bir
 * PROJECT_MANAGER için sonuç BOŞTUR; "kapsam yok" asla "tüm organizasyon"
 * anlamına gelmez (fail-closed). Tüm sorgular ayrıca `organizationId` ile
 * filtrelenir.
 */

/** Tek bir dönemin proje finansalları. Tüm parasal alanlar Decimal string'dir (bkz. CLAUDE.md — para için JS number kullanılmaz). */
export interface ProjectPeriodMargin {
  /** Dönemde kaydedilen (tahakkuk) gelir. */
  revenue: string;
  /** Dönemde kaydedilen (tahakkuk) gider. */
  expense: string;
  /** gelir − gider. */
  profit: string;
  /** Kâr marjı yüzdesi (2 ondalık, biçimlendirilmemiş). Gelir sıfır/negatifse `null`. */
  margin: string | null;
  /** Marjın tanımlı olup olmadığı — tüketicinin `null` ile `"0"` arasını ayırt etmesi için. */
  marginAvailable: boolean;
}

/**
 * Tek bir projenin dönemler arası karşılaştırması. KASITLI olarak dar
 * tutulmuştur: yalnızca finansal karşılaştırma için gereken alanlar taşınır —
 * müşteri/adres/bütçe gibi ilgisiz proje meta verisi, PII, aktör kimliği veya
 * tenant iç bilgisi (organizationId) DIŞARI VERİLMEZ.
 */
export interface ProjectMarginComparisonRow {
  projectId: string;
  /** Kullanıcıya gösterilebilir proje adı — uyarı metinleri için gereklidir (bkz. `ProjectBudgetRow` ile aynı konvansiyon). */
  projectName: string;
  projectCode: string;
  current: ProjectPeriodMargin;
  prior: ProjectPeriodMargin;
}

export interface ProjectMarginComparison {
  period: DashboardPeriod;
  /** Aktörün kapsamı — tüketici "boş sonuç" ile "yetkisiz kapsam"ı ayırt edebilsin diye taşınır. */
  scope: "ORGANIZATION" | "PROJECT_MANAGER";
  currentPeriod: DateRange;
  /** `currentPeriod`'un hemen öncesi; `priorPeriod.end === currentPeriod.start`. */
  priorPeriod: DateRange;
  rows: ProjectMarginComparisonRow[];
}

export interface GetProjectMarginComparisonOptions {
  period?: DashboardPeriod;
  /** Deterministik dönem sınırı testleri için "şimdi" enjeksiyonu; üretim çağrılarında verilmez. */
  now?: Date;
}

/**
 * Varsayılan dönem içinde bulunulan takvim ayıdır — dashboard KPI kartlarının
 * ve YF-702-F1 tahsilat/ödeme sinyalinin dönemiyle AYNI (bkz.
 * server/services/ai-insights-service.ts `SETTLEMENT_SIGNAL_PERIOD`).
 * Kullanıcı bir uyarı gördüğünde aynı rakamları dashboard'da bulur; yeni bir
 * dönem kavramı icat edilmez.
 */
const DEFAULT_MARGIN_PERIOD: DashboardPeriod = "CURRENT_MONTH";

interface PeriodTotals {
  revenue: Prisma.Decimal;
  expense: Prisma.Decimal;
}

/**
 * Bir dönemin proje×tür (gelir/gider) toplamlarını TEK bir gruplu sorguyla
 * getirip proje bazında indeksler — proje başına sorgu YOKTUR.
 * `getProjectFinanceSummary`'nin `incomeAgg`/`expenseAgg` yüklemiyle aynıdır,
 * yalnızca `issueDate` dönem filtresi eklenmiş ve tek projeye sabitlenmek
 * yerine proje bazında gruplanmıştır.
 */
async function groupRecordedTotalsByProject(
  organizationId: string,
  range: DateRange,
  projectIds: string[] | undefined,
): Promise<Map<string, PeriodTotals>> {
  const groups = await db.financialTransaction.groupBy({
    by: ["projectId", "type"],
    where: {
      organizationId,
      status: { not: "CANCELLED" },
      issueDate: { gte: range.start, lt: range.end },
      projectId: projectIds ? { in: projectIds } : { not: null },
    },
    _sum: { totalAmount: true },
  });

  const map = new Map<string, PeriodTotals>();
  for (const group of groups) {
    if (!group.projectId) continue;
    const totals = map.get(group.projectId) ?? { revenue: ZERO, expense: ZERO };
    const amount = toDecimal(group._sum.totalAmount ?? ZERO);
    const type: TransactionType = group.type;
    if (type === "INCOME") {
      totals.revenue = totals.revenue.plus(amount);
    } else {
      totals.expense = totals.expense.plus(amount);
    }
    map.set(group.projectId, totals);
  }
  return map;
}

function toPeriodMargin(totals: PeriodTotals | undefined): ProjectPeriodMargin {
  const revenue = totals?.revenue ?? ZERO;
  const expense = totals?.expense ?? ZERO;
  const profit = revenue.minus(expense);
  const margin = computeProfitMarginPercent(profit, revenue);
  return {
    revenue: revenue.toString(),
    expense: expense.toString(),
    profit: profit.toString(),
    margin,
    marginAvailable: margin !== null,
  };
}

/**
 * Aktörün yetkili olduğu projeler için cari ve önceki dönem marjlarını, proje
 * sayısından BAĞIMSIZ sabit sayıda sorguyla döndürür.
 *
 * Sorgu bütçesi (proje sayısından bağımsız):
 * - organizasyon geneli roller: 3 sorgu (projeler + 2 dönem grubu, paralel)
 * - PROJECT_MANAGER: 4 sorgu (+ kapsam çözümlemesi)
 * - atanmış projesi olmayan PROJECT_MANAGER: 1 sorgu (kapsam) — sonrasında
 *   hiçbir finansal sorgu ÇALIŞTIRILMAZ, boş sonuç döner.
 *
 * Kapsamdaki her proje, o dönemde HİÇ hareketi olmasa bile bir satır üretir
 * (sıfır gelir/gider, `margin: null`) — böylece tüketici "veri yok" ile
 * "proje yok" durumlarını ayırt edebilir ve satırlar sessizce kırpılmaz.
 * Sıralama proje koduna göre artan ve deterministiktir.
 *
 * Kanonik (genel) giriş noktasıdır: kapsamı kendisi çözer. Bu servisin proje
 * filtresi YOKTUR; kapsam bu nedenle her zaman `requestedProjectId:
 * undefined` ile çözülür ve `resolveProjectFilter` hiç sorgu çalıştırmaz —
 * PROJECT_MANAGER için toplam maliyet yine TEK üyelik sorgusudur.
 */
export async function getProjectMarginComparison(
  actor: SessionUser,
  options: GetProjectMarginComparisonOptions = {},
): Promise<ProjectMarginComparison> {
  return getProjectMarginComparisonWithScope(actor, options, await resolveActorReportScope(actor, undefined));
}

/**
 * YF-702-F8 — Kapsamı ÖNCEDEN çözülmüş çağrılar için iç giriş noktası (bkz.
 * server/services/ai-insights-service.ts `extractFinancialSignals`; aynı
 * istekte dört tüketici aynı üyelik sorgusunu tekrarlıyordu).
 *
 * Kapsam alanı olarak `assignedProjectIds` kullanılır, `moneyScope` DEĞİL:
 * bu servisin proje filtresi yoktur ve aktörün yetkili olduğu TÜM projeleri
 * kapsamak ZORUNDADIR. `requestedProjectId` `undefined` olduğunda iki alan
 * eşit olsa da, anlamı doğru olan alan `assignedProjectIds`'tir — filtreli bir
 * kapsam buraya yanlışlıkla taşınırsa sonuç sessizce tek projeye daralmaz,
 * `assertResolvedScopeForActor` çağrıyı reddeder.
 */
export async function getProjectMarginComparisonWithScope(
  actor: SessionUser,
  options: GetProjectMarginComparisonOptions,
  actorScope: ActorReportScope,
): Promise<ProjectMarginComparison> {
  assertResolvedScopeForActor(actor, actorScope, undefined);
  const period = options.period ?? DEFAULT_MARGIN_PERIOD;
  const now = options.now ?? new Date();
  const currentPeriod = getDateRange(period, now);
  const priorPeriod = getPriorDateRange(period, now);
  const scope = canViewAllProjects(actor.role) ? "ORGANIZATION" : "PROJECT_MANAGER";

  const projectIds = actorScope.assignedProjectIds;

  // Fail-closed: kapsamı boş olan bir aktör için organizasyon geneline
  // DÜŞÜLMEZ; hiç finansal sorgu çalıştırılmadan boş sonuç döner.
  if (projectIds && projectIds.length === 0) {
    return { period, scope, currentPeriod, priorPeriod, rows: [] };
  }

  const [projects, currentTotals, priorTotals] = await Promise.all([
    db.project.findMany({
      where: { organizationId: actor.organizationId, ...(projectIds ? { id: { in: projectIds } } : {}) },
      select: { id: true, name: true, code: true },
      orderBy: { code: "asc" },
    }),
    groupRecordedTotalsByProject(actor.organizationId, currentPeriod, projectIds),
    groupRecordedTotalsByProject(actor.organizationId, priorPeriod, projectIds),
  ]);

  const rows: ProjectMarginComparisonRow[] = projects.map((project) => ({
    projectId: project.id,
    projectName: project.name,
    projectCode: project.code,
    current: toPeriodMargin(currentTotals.get(project.id)),
    prior: toPeriodMargin(priorTotals.get(project.id)),
  }));

  return { period, scope, currentPeriod, priorPeriod, rows };
}
