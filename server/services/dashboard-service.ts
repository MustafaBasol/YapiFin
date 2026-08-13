import { Prisma } from "@prisma/client";
import type { MovementType, TransactionStatus, TransactionType } from "@prisma/client";
import { db } from "@/lib/db";
import { canViewAllProjects } from "@/lib/permissions";
import { getOpenAndOverdueTotals, getOrganizationCashBalance, toDecimal, ZERO } from "@/server/services/ledger";
import { toIstanbul, fromIstanbulComponents } from "@/lib/dates";
import type { SessionUser } from "@/lib/auth/session";
import type { DashboardFilterInput, DashboardPeriod } from "@/lib/validation/dashboard";

/**
 * YF-401 — Şirket finans dashboardu ve YF-402 proje kârlılığı için paylaşılan
 * agregasyon servisi. Tüm parasal toplamlar Prisma.Decimal ile hesaplanır ve
 * DTO sınırında `string`'e çevrilir (bkz. CLAUDE.md "Decimal-safe
 * serialization"); yalnızca grafik veri noktaları (recharts) için `number`'a
 * dönüştürülür.
 *
 * İptal/ters kayıt kuralları:
 * - `FinancialTransaction.status = CANCELLED` olan kayıtlar tüm toplamlardan
 *   tamamen hariç tutulur.
 * - `Settlement.status != 'ACTIVE'` olan tahsilat/ödemeler (iptal edilmişler)
 *   toplanan/ödenen tutarlara dahil edilmez — ters kayıt (REVERSAL) orijinal
 *   AccountMovement'ı silmediği için çift sayım riski, settlement'ın kendisi
 *   `CANCELLED` olarak işaretlenip filtrelendiği için oluşmaz.
 * - Kasa/banka bakiyesi `AccountMovement` CREDIT-DEBIT farkından türetilir;
 *   ters kayıt hareketleri (`type: REVERSAL`) ters yönde eklendiği için ayrı
 *   bir düzeltme gerekmez.
 * - `OVERDUE`, vade tarihi geçmiş VE kalan tutar pozitif olan kayıtlar için
 *   okuma anında (canlı) türetilir; gelecekteki vadeler asla sayılmaz.
 */


export interface DateRange {
  start: Date;
  end: Date; // exclusive
}

export function getDateRange(period: DashboardPeriod, now: Date): DateRange {
  const ist = toIstanbul(now);
  const y = ist.getUTCFullYear();
  const m = ist.getUTCMonth();
  if (period === "CURRENT_MONTH") {
    return { start: fromIstanbulComponents(y, m, 1), end: fromIstanbulComponents(y, m + 1, 1) };
  }
  if (period === "CURRENT_YEAR") {
    return { start: fromIstanbulComponents(y, 0, 1), end: fromIstanbulComponents(y + 1, 0, 1) };
  }
  // LAST_12_MONTHS: bu ayın başlangıcından geriye doğru 12 aylık kayan pencere.
  return { start: fromIstanbulComponents(y - 1, m + 1, 1), end: fromIstanbulComponents(y, m + 1, 1) };
}

/**
 * YF-702-F2 — `getDateRange(period, now)` ile üretilen dönemin HEMEN
 * ÖNCESİNDEKİ, eşdeğer süreli dönem.
 *
 * Neden `getDateRange` ile aynı modülde ve aynı `DashboardPeriod` sözlüğüyle:
 * uygulamada ikinci bir tarih-aralığı sistemi İSTENMEZ (bkz. görev talimatı
 * "Do not invent a second date-range system"). Dönemler her zaman Istanbul
 * takvimine göre hizalanır ve ÖRTÜŞMEZ — bu fonksiyonun `end` değeri, aynı
 * `period`/`now` için `getDateRange`'in `start` değerine BİREBİR eşittir:
 *
 * - CURRENT_MONTH  → bir önceki takvim ayı
 * - CURRENT_YEAR   → bir önceki takvim yılı
 * - LAST_12_MONTHS → o 12 aylık pencereden önceki 12 aylık pencere
 *
 * "Eşdeğer süre" takvim bazlıdır (28/29/30/31 günlük aylar gün sayısı olarak
 * birebir eşit değildir); bu kasıtlıdır — kullanıcı "geçen ay" ile "bu ay"ı
 * karşılaştırır, "son 30 gün" ile değil, ve dashboard/rapor dönemleriyle aynı
 * sınırlar korunur.
 */
export function getPriorDateRange(period: DashboardPeriod, now: Date): DateRange {
  const ist = toIstanbul(now);
  const y = ist.getUTCFullYear();
  const m = ist.getUTCMonth();
  if (period === "CURRENT_MONTH") {
    return { start: fromIstanbulComponents(y, m - 1, 1), end: fromIstanbulComponents(y, m, 1) };
  }
  if (period === "CURRENT_YEAR") {
    return { start: fromIstanbulComponents(y - 1, 0, 1), end: fromIstanbulComponents(y, 0, 1) };
  }
  return { start: fromIstanbulComponents(y - 2, m + 1, 1), end: fromIstanbulComponents(y - 1, m + 1, 1) };
}

export type MonthlySeriesGranularity = "CURRENT_YEAR" | "LAST_12_MONTHS";

/**
 * Aylık trend grafikleri her zaman 12 aylık bir pencere gösterir — tek bir ay
 * için "aylık trend" anlamsız olacağından, CURRENT_MONTH seçiliyken bile bu
 * grafikler son 12 aya döner (ürün kararı; KPI kartları yine de seçilen
 * döneme göre hesaplanır).
 */
export function getMonthlySeriesGranularity(period: DashboardPeriod): MonthlySeriesGranularity {
  return period === "CURRENT_YEAR" ? "CURRENT_YEAR" : "LAST_12_MONTHS";
}

export interface MonthLabel {
  key: string;
  label: string;
  monthStart: Date;
}

export function buildMonthLabels(range: DateRange): MonthLabel[] {
  const startIst = toIstanbul(range.start);
  const y0 = startIst.getUTCFullYear();
  const m0 = startIst.getUTCMonth();
  const months: MonthLabel[] = [];
  for (let i = 0; i < 12; i++) {
    const monthStart = fromIstanbulComponents(y0, m0 + i, 1);
    const ist = toIstanbul(monthStart);
    const key = `${ist.getUTCFullYear()}-${String(ist.getUTCMonth() + 1).padStart(2, "0")}`;
    const label = new Intl.DateTimeFormat("tr-TR", { month: "short", year: "2-digit", timeZone: "Europe/Istanbul" }).format(
      monthStart,
    );
    months.push({ key, label, monthStart });
  }
  return months;
}

export function bucketByMonth(rows: { amount: Prisma.Decimal.Value; date: Date }[], months: MonthLabel[]): Prisma.Decimal[] {
  const indexByYm = new Map<number, number>();
  months.forEach((m, i) => {
    const ist = toIstanbul(m.monthStart);
    indexByYm.set(ist.getUTCFullYear() * 12 + ist.getUTCMonth(), i);
  });
  const sums = months.map(() => ZERO);
  for (const row of rows) {
    const d = toIstanbul(row.date);
    const idx = indexByYm.get(d.getUTCFullYear() * 12 + d.getUTCMonth());
    if (idx !== undefined) sums[idx] = sums[idx].plus(toDecimal(row.amount));
  }
  return sums;
}

export interface MonthlyPoint {
  key: string;
  label: string;
  collected: number;
  paid: number;
  net: number;
}

export interface CategorySlice {
  categoryId: string;
  name: string;
  amount: string;
}

export interface ProjectComparisonRow {
  projectId: string;
  name: string;
  code: string;
  income: string;
  expense: string;
  result: string;
}

export interface UpcomingItem {
  id: string;
  description: string;
  counterpartName: string | null;
  projectName: string | null;
  dueDate: Date;
  remainingAmount: string;
  currency: string;
}

export interface RecentMovement {
  id: string;
  occurredAt: Date;
  type: MovementType;
  accountName: string;
  amount: string;
  direction: "CREDIT" | "DEBIT";
  description: string;
  relatedProjectName: string | null;
}

export interface RecentProjectActivity {
  id: string;
  type: TransactionType;
  description: string;
  projectName: string;
  totalAmount: string;
  status: TransactionStatus;
  issueDate: Date;
}

interface MoneyKpis {
  collectedIncome: string;
  paidExpense: string;
  netCashFlow: string;
  openReceivable: string;
  overdueReceivable: string;
  openPayable: string;
  overduePayable: string;
}

export interface OrganizationDashboardData {
  scope: "ORGANIZATION";
  period: DashboardPeriod;
  projectFilter: { id: string; name: string } | null;
  kpis: MoneyKpis & {
    cashAndBankBalance: string;
    activeProjectCount: number;
    totalProjectCount: number;
    activeCustomerCount: number;
    activeSupplierCount: number;
    budgetCriticalProjectCount: number;
  };
  monthlySeries: MonthlyPoint[];
  monthlySeriesGranularity: MonthlySeriesGranularity;
  expenseCategoryDistribution: CategorySlice[];
  projectComparison: ProjectComparisonRow[];
  upcomingCollections: UpcomingItem[];
  upcomingPayments: UpcomingItem[];
  recentMovements: RecentMovement[];
}

export interface ProjectManagerDashboardData {
  scope: "PROJECT_MANAGER";
  period: DashboardPeriod;
  projectFilter: { id: string; name: string } | null;
  hasAssignedProjects: boolean;
  kpis: MoneyKpis & {
    activeProjectCount: number;
    totalProjectCount: number;
    budgetCriticalProjectCount: number;
  };
  monthlySeries: MonthlyPoint[];
  monthlySeriesGranularity: MonthlySeriesGranularity;
  expenseCategoryDistribution: CategorySlice[];
  projectComparison: ProjectComparisonRow[];
  upcomingCollections: UpcomingItem[];
  upcomingPayments: UpcomingItem[];
  recentProjectActivity: RecentProjectActivity[];
}

export type DashboardData = OrganizationDashboardData | ProjectManagerDashboardData;

/**
 * Bir proje filtresini organizasyon + (varsa) atanmış proje kapsamına göre
 * doğrular — proje scope doğrulaması tek kaynaktan yapılır (bkz. görev
 * talimatları "Every server-supplied projectId ... must be validated and
 * scoped").
 *
 * YF-702-F7 — DIŞA AÇILMAZ ve `assignedProjectIds` ZORUNLUDUR. Tek çağıranı
 * `resolveActorReportScope`'tur; rapor servisleri bu fonksiyonu artık doğrudan
 * çağırmaz. Parametrenin zorunlu olması, atanmış proje kapsamını geçmeyi
 * unutan bir çağrının derlenmemesini sağlar: aksi hâlde bir PROJECT_MANAGER
 * organizasyondaki HERHANGİ bir projeyi filtre olarak verip verisini
 * okuyabilirdi (üyelik süzgeci aşağıdaki son satırdır). Organizasyon geneli
 * roller için `undefined` geçilir — süzgeç kasıtlı olarak devre dışı kalır.
 */
async function resolveProjectFilter(
  actor: SessionUser,
  requestedProjectId: string | undefined,
  assignedProjectIds: string[] | undefined,
): Promise<{ id: string; name: string } | null> {
  if (!requestedProjectId) return null;
  const project = await db.project.findFirst({
    where: { id: requestedProjectId, organizationId: actor.organizationId },
    select: { id: true, name: true },
  });
  if (!project) return null;
  if (assignedProjectIds && !assignedProjectIds.includes(project.id)) return null;
  return project;
}

/**
 * YF-702-F1 — Aktörün parasal kapsamını (proje kimlikleri) tek kaynaktan
 * çözer: tüm projeleri görebilen roller için `undefined` (organizasyon
 * geneli), PROJECT_MANAGER için yalnızca atandığı projeler.
 *
 * Atanmış projesi olmayan bir PROJECT_MANAGER için BOŞ DİZİ döner — bu,
 * `getSettlementTotalsForRange` gibi tüketicilerde fail-closed davranışa
 * (sıfır toplam) karşılık gelir; "kapsam yok" ASLA "tüm organizasyon"
 * anlamına gelmez. `resolveProjectFilter` ile aynı modülde tutulur; bu iki
 * fonksiyon birlikte proje kapsamı çözümlemesinin tek kaynağıdır.
 */
export async function resolveActorProjectScope(actor: SessionUser): Promise<string[] | undefined> {
  if (canViewAllProjects(actor.role)) return undefined;
  const memberships = await db.projectMember.findMany({
    where: { organizationId: actor.organizationId, userId: actor.id },
    select: { projectId: true },
  });
  return memberships.map((m) => m.projectId);
}

/** `resolveProjectFilter` çıktısıyla birebir aynı kalması için türetilir. */
export type ResolvedProjectFilter = Awaited<ReturnType<typeof resolveProjectFilter>>;

/**
 * YF-702-F7 — Çözümlenmiş aktör kapsamı. `ORGANIZATION` dalı organizasyon
 * genelini, `PROJECT_MANAGER` dalı yalnızca atanmış projeleri temsil eder.
 *
 * `PROJECT_MANAGER` dalında `assignedProjectIds` ve `moneyScope` tipçe ASLA
 * `undefined` olamaz — "kapsam yok" hiçbir zaman "tüm organizasyon" anlamına
 * gelemez (fail-closed). Bu, dizi ile `undefined` karıştırılmasını derleme
 * zamanında imkânsız kılar.
 *
 * YF-702-F8 — Bu nesne artık servisler ARASINDA taşınabilir (bkz.
 * `*WithScope` giriş noktaları: `getBudgetReportWithScope`,
 * `getCashFlowReportWithScope`, `getProjectMarginComparisonWithScope`);
 * dolayısıyla salt bir "hesaplama sonucu" değil, GÜVENİLEN İÇ YETKİ DURUMUdur.
 * Taşınabilir hâle geldiği için üç KÖKEN (provenance) alanı eklendi:
 *
 *   - `actorId` — kapsamın çözüldüğü aktör,
 *   - `organizationId` — o aktörün tenant'ı,
 *   - `requestedProjectId` — kapsamı üreten proje filtresi (yoksa `undefined`).
 *
 * Bu üç alan, kapsamı TÜKETEN servisin (`assertResolvedScopeForActor` ile)
 * aktör ile kapsamın SESSİZCE ayrışmadığını kanıtlamasını sağlar: A aktörü
 * için çözülmüş bir kapsamın B aktörünün raporunda kullanılması, ya da X
 * projesi için çözülmüş bir kapsamın Y projesi filtresiyle kullanılması artık
 * çalışma zamanında yakalanır. Alanlar EK'tir; mevcut dört alanın anlamı ve
 * `ORGANIZATION`/`PROJECT_MANAGER` asimetrisi aynen korunur.
 */
export type ActorReportScope =
  | {
      scope: "ORGANIZATION";
      assignedProjectIds: undefined;
      projectFilter: ResolvedProjectFilter;
      moneyScope: string[] | undefined;
      actorId: string;
      organizationId: string;
      requestedProjectId: string | undefined;
    }
  | {
      scope: "PROJECT_MANAGER";
      assignedProjectIds: string[];
      projectFilter: ResolvedProjectFilter;
      moneyScope: string[];
      actorId: string;
      organizationId: string;
      requestedProjectId: string | undefined;
    };

/**
 * YF-702-F8 — Köken (provenance) kaydı: yalnızca `resolveActorReportScope`
 * tarafından ÜRETİLMİŞ kapsam nesnelerini tutar.
 *
 * Modül-özeldir ve DIŞA AÇILMAZ; başka hiçbir dosya buraya kayıt ekleyemez.
 * Bunun sonucu şudur: alanları "doğru" görünen elle kurulmuş bir nesne
 * sözlüğü (`{ scope: "ORGANIZATION", ... }`) `assertResolvedScopeForActor`
 * kontrolünden GEÇEMEZ. Kapsamın kanonik çözümleyiciden gelmesi böylece
 * yalnızca bir konvansiyon değil, uygulanabilir bir değişmez olur.
 *
 * `WeakSet` seçilmiştir: kapsam nesnesi istek sonunda çöp toplayıcıya
 * bırakılır, istek-ötesi hiçbir durum SAKLANMAZ (global mutable önbellek
 * değildir).
 */
const resolvedScopeRegistry = new WeakSet<ActorReportScope>();

/**
 * YF-702-F8 — Kapsamı köken kaydına ekler ve DONDURUR.
 *
 * Dondurma, kaydın kendisi kadar önemlidir: `WeakSet` yalnızca NESNE KİMLİĞİNİ
 * saklar, içeriğini değil. Kayıttan sonra `moneyScope`/`assignedProjectIds`
 * değiştirilebilseydi, beş doğrulamanın tamamından geçen bir kapsam yine de
 * GENİŞLETİLEBİLİRDİ (örn. diziye proje kimliği eklenerek). Hem nesne hem de
 * proje kimliği dizileri dondurularak, "kanonik çözümleyiciden geldi" ifadesi
 * "çözümlendiği hâliyle geldi" anlamına da gelir.
 *
 * `moneyScope` filtresiz bir PROJECT_MANAGER için `assignedProjectIds` ile AYNI
 * dizi örneğidir; `Object.freeze` yinelenen çağrıda etkisizdir, bu yüzden iki
 * alanın ayrı ayrı dondurulması güvenlidir.
 */
function registerResolvedScope(scope: ActorReportScope): ActorReportScope {
  if (scope.assignedProjectIds) Object.freeze(scope.assignedProjectIds);
  if (scope.moneyScope) Object.freeze(scope.moneyScope);
  Object.freeze(scope);
  resolvedScopeRegistry.add(scope);
  return scope;
}

/**
 * YF-702-F8 — Önceden çözülmüş bir kapsamın bu aktöre ve bu filtreye AİT
 * olduğunu kanıtlar; aksi hâlde fırlatır (fail-closed).
 *
 * Beş koşulun tamamı sağlanmalıdır:
 *   1. Köken — nesne `resolveActorReportScope` tarafından üretilmiş olmalıdır
 *      (bkz. `resolvedScopeRegistry`). Elle kurulmuş bir nesne sözlüğü
 *      "önerilmez" değil, İMKÂNSIZDIR.
 *   2. `actorId` kimliği — kapsam başka bir kullanıcı için çözülmüş olamaz.
 *   3. `organizationId` kimliği — kapsam başka bir tenant için çözülmüş olamaz.
 *   4. Filtre kimliği — kapsam, çağrıdaki `projectId` ile AYNI istek üzerine
 *      çözülmüş olmalıdır; aksi hâlde `moneyScope` başka bir projeye ait olurdu.
 *   5. Rol↔dal tutarlılığı — `ORGANIZATION` dalı yalnızca tüm projeleri
 *      görebilen roller için geçerlidir. Bir PROJECT_MANAGER'a organizasyon
 *      geneli bir kapsamın iliştirilmesi bu adımda yakalanır.
 *
 * `assignedProjectIds` bir PROJECT_MANAGER için hiçbir zaman `undefined`
 * olmaz ve BOŞ DİZİ asla "tüm organizasyon" anlamına gelmez (bkz.
 * `ActorReportScope` ve `resolveActorProjectScope`) — bu değişmez taşıma
 * sırasında da korunur.
 *
 * Bilinçli olarak DÜZ bir `Error` fırlatılır; uygulamanın notFound/forbidden
 * yardımcıları KULLANILMAZ. Bu bir son kullanıcı yetki hatası değil, iç
 * değişmez ihlali (programlama hatası) sinyalidir ve gürültülü biçimde
 * başarısız olmalıdır. Mesaj kimlik bilgisi SIZDIRMAZ.
 */
export function assertResolvedScopeForActor(
  actor: SessionUser,
  scope: ActorReportScope,
  requestedProjectId: string | undefined,
): void {
  const valid =
    resolvedScopeRegistry.has(scope) &&
    scope.actorId === actor.id &&
    scope.organizationId === actor.organizationId &&
    scope.requestedProjectId === requestedProjectId &&
    (scope.scope === "ORGANIZATION") === canViewAllProjects(actor.role);
  if (!valid) {
    throw new Error("Çözümlenmemiş veya bu aktöre ait olmayan rapor kapsamı");
  }
}

/**
 * YF-702-F7 — Rapor servislerinin (dashboard, bütçe, nakit akışı) ortak kapsam
 * girişi. Aktörün rol kapsamını `resolveActorProjectScope` ile, istemciden
 * gelen proje filtresini `resolveProjectFilter` ile çözer ve ikisini tek bir
 * ayrık birleşimde birleştirir. Bu üç servis daha önce aynı üyelik sorgusunu
 * ve aynı rol dalını kendi içinde TEKRARLIYORDU; kapsam çözümlemesi artık
 * yalnızca burada yapılır.
 *
 * Güvenlik sözleşmesi:
 *   - `resolveProjectFilter` HER ZAMAN `assignedProjectIds` ile çağrılır (o
 *     fonksiyonun tek çağıranı burasıdır ve parametresi zorunludur); atanmamış
 *     veya başka organizasyona ait bir projectId bu nedenle aktörün kapsamını
 *     genişletemez.
 *   - Geçersiz/yetkisiz projectId HATA FIRLATMAZ; `projectFilter` `null` olur
 *     ve kapsam aktörün KENDİ kapsamına düşer (PROJECT_MANAGER için atanmış
 *     projeler, organizasyon geneli roller için tüm organizasyon). Bu kasıtlı
 *     ve testlerle sabitlenmiş bir sözleşmedir — daraltma değil, sızdırmama.
 *
 * Sorgu maliyeti değişmez: organizasyon geneli roller için 0 üyelik sorgusu,
 * PROJECT_MANAGER için 1; proje filtresi verildiyse `resolveProjectFilter`
 * kaynaklı 1 doğrulama sorgusu daha. İki await SIRALI kalmalıdır — filtre
 * doğrulaması `assignedProjectIds`'e bağımlıdır, paralelleştirilemez.
 *
 * YF-702-F8 — Üretilen kapsam, köken kaydına (`resolvedScopeRegistry`)
 * eklenerek döndürülür: kapsamı bir servisten diğerine TAŞIYAN çağrılar
 * (`*WithScope`) böylece nesnenin gerçekten burada çözüldüğünü kanıtlayabilir.
 * Bu fonksiyon, kapsamın TEK meşru üretim noktasıdır.
 */
export async function resolveActorReportScope(
  actor: SessionUser,
  requestedProjectId: string | undefined,
): Promise<ActorReportScope> {
  const assignedProjectIds = await resolveActorProjectScope(actor);
  const projectFilter = await resolveProjectFilter(actor, requestedProjectId, assignedProjectIds);
  const provenance = {
    actorId: actor.id,
    organizationId: actor.organizationId,
    requestedProjectId,
  };

  if (assignedProjectIds === undefined) {
    return registerResolvedScope({
      scope: "ORGANIZATION",
      assignedProjectIds: undefined,
      projectFilter,
      moneyScope: projectFilter ? [projectFilter.id] : undefined,
      ...provenance,
    });
  }

  return registerResolvedScope({
    scope: "PROJECT_MANAGER",
    assignedProjectIds,
    projectFilter,
    moneyScope: projectFilter ? [projectFilter.id] : assignedProjectIds,
    ...provenance,
  });
}

export async function getSettlementTotalsForRange(organizationId: string, range: DateRange, projectIds?: string[]) {
  if (projectIds && projectIds.length === 0) return { collected: ZERO, paid: ZERO, net: ZERO };
  const groups = await db.settlement.groupBy({
    by: ["type"],
    where: {
      organizationId,
      status: "ACTIVE",
      settlementDate: { gte: range.start, lt: range.end },
      ...(projectIds ? { transaction: { projectId: { in: projectIds } } } : {}),
    },
    _sum: { amount: true },
  });
  const collected = toDecimal(groups.find((g) => g.type === "COLLECTION")?._sum.amount ?? ZERO);
  const paid = toDecimal(groups.find((g) => g.type === "PAYMENT")?._sum.amount ?? ZERO);
  return { collected, paid, net: collected.minus(paid) };
}

const UPCOMING_WINDOW_DAYS = 30;
const UPCOMING_CANDIDATE_LIMIT = 20;
const UPCOMING_RESULT_LIMIT = 8;

async function findUpcomingItems(
  organizationId: string,
  type: TransactionType,
  projectIds: string[] | undefined,
): Promise<UpcomingItem[]> {
  if (projectIds && projectIds.length === 0) return [];
  const now = new Date();
  const windowEnd = new Date(now.getTime() + UPCOMING_WINDOW_DAYS * 24 * 60 * 60 * 1000);

  const candidates = await db.financialTransaction.findMany({
    where: {
      organizationId,
      type,
      status: { not: "CANCELLED" },
      dueDate: { gte: now, lte: windowEnd },
      ...(projectIds ? { projectId: { in: projectIds } } : {}),
    },
    orderBy: { dueDate: "asc" },
    take: UPCOMING_CANDIDATE_LIMIT,
    select: {
      id: true,
      description: true,
      dueDate: true,
      totalAmount: true,
      currency: true,
      customer: { select: { name: true } },
      supplier: { select: { name: true } },
      project: { select: { name: true } },
    },
  });
  if (candidates.length === 0) return [];

  const settled = await db.settlement.groupBy({
    by: ["transactionId"],
    where: { transactionId: { in: candidates.map((c) => c.id) }, status: "ACTIVE" },
    _sum: { amount: true },
  });
  const settledMap = new Map(settled.map((s) => [s.transactionId, toDecimal(s._sum.amount ?? ZERO)]));

  return candidates
    .map((c) => ({ ...c, remaining: toDecimal(c.totalAmount).minus(settledMap.get(c.id) ?? ZERO) }))
    .filter((c) => c.remaining.greaterThan(ZERO))
    .slice(0, UPCOMING_RESULT_LIMIT)
    .map((c) => ({
      id: c.id,
      description: c.description,
      counterpartName: c.customer?.name ?? c.supplier?.name ?? null,
      projectName: c.project?.name ?? null,
      dueDate: c.dueDate as Date,
      remainingAmount: c.remaining.toString(),
      currency: c.currency,
    }));
}

interface ProjectFinanceGroupRow {
  projectId: string | null;
  _sum: { totalAmount: Prisma.Decimal | null };
}

function buildProjectComparison(
  incomeGroups: ProjectFinanceGroupRow[],
  expenseGroups: ProjectFinanceGroupRow[],
  projects: { id: string; name: string; code: string }[],
  limit: number,
): ProjectComparisonRow[] {
  const incomeMap = new Map(incomeGroups.map((g) => [g.projectId as string, toDecimal(g._sum.totalAmount ?? ZERO)]));
  const expenseMap = new Map(expenseGroups.map((g) => [g.projectId as string, toDecimal(g._sum.totalAmount ?? ZERO)]));
  const projectMap = new Map(projects.map((p) => [p.id, p]));
  const ids = new Set<string>([...incomeMap.keys(), ...expenseMap.keys()]);

  const rows = Array.from(ids).map((id) => {
    const income = incomeMap.get(id) ?? ZERO;
    const expense = expenseMap.get(id) ?? ZERO;
    const project = projectMap.get(id);
    return {
      projectId: id,
      name: project?.name ?? "Bilinmeyen proje",
      code: project?.code ?? "—",
      income: income.toString(),
      expense: expense.toString(),
      result: income.minus(expense).toString(),
    };
  });

  rows.sort((a, b) => Math.abs(Number(b.result)) - Math.abs(Number(a.result)));
  return rows.slice(0, limit);
}

function computeBudgetCriticalCount(
  projects: { id: string; status: string; estimatedBudget: Prisma.Decimal }[],
  expenseMap: Map<string, Prisma.Decimal>,
): number {
  return projects.filter((p) => {
    if (p.status !== "ACTIVE") return false;
    const budget = toDecimal(p.estimatedBudget);
    if (budget.lessThanOrEqualTo(ZERO)) return false;
    const used = expenseMap.get(p.id) ?? ZERO;
    return used.div(budget).greaterThanOrEqualTo(0.8);
  }).length;
}

async function getCategoryDistribution(
  organizationId: string,
  range: DateRange,
  projectIds: string[] | undefined,
): Promise<CategorySlice[]> {
  if (projectIds && projectIds.length === 0) return [];
  const groups = await db.financialTransaction.groupBy({
    by: ["categoryId"],
    where: {
      organizationId,
      type: "EXPENSE",
      status: { not: "CANCELLED" },
      issueDate: { gte: range.start, lt: range.end },
      ...(projectIds ? { projectId: { in: projectIds } } : {}),
    },
    _sum: { totalAmount: true },
  });
  if (groups.length === 0) return [];
  const categories = await db.transactionCategory.findMany({
    where: { id: { in: groups.map((g) => g.categoryId) } },
    select: { id: true, name: true },
  });
  const nameMap = new Map(categories.map((c) => [c.id, c.name]));
  return groups
    .map((g) => ({
      categoryId: g.categoryId,
      name: nameMap.get(g.categoryId) ?? "Diğer",
      amount: toDecimal(g._sum.totalAmount ?? ZERO).toString(),
    }))
    .sort((a, b) => Number(b.amount) - Number(a.amount));
}

async function getRecentMovements(organizationId: string, projectId: string | null): Promise<RecentMovement[]> {
  const movements = await db.accountMovement.findMany({
    where: {
      organizationId,
      ...(projectId ? { settlement: { transaction: { projectId } } } : {}),
    },
    orderBy: [{ occurredAt: "desc" }, { createdAt: "desc" }],
    take: 15,
    include: {
      financialAccount: { select: { name: true } },
      settlement: { include: { transaction: { select: { project: { select: { name: true } } } } } },
    },
  });

  return movements.map((m) => ({
    id: m.id,
    occurredAt: m.occurredAt,
    type: m.type,
    accountName: m.financialAccount.name,
    amount: toDecimal(m.amount).toString(),
    direction: m.direction,
    description: m.description,
    relatedProjectName: m.settlement?.transaction.project?.name ?? null,
  }));
}

const PROJECT_COMPARISON_LIMIT = 10;

export async function getDashboardData(actor: SessionUser, filterInput: DashboardFilterInput): Promise<DashboardData> {
  const actorScope = await resolveActorReportScope(actor, filterInput.projectId);
  if (actorScope.scope === "ORGANIZATION") {
    return getOrganizationDashboard(actor, filterInput, actorScope);
  }
  return getProjectManagerDashboard(actor, filterInput, actorScope);
}

async function getOrganizationDashboard(
  actor: SessionUser,
  filterInput: DashboardFilterInput,
  actorScope: Extract<ActorReportScope, { scope: "ORGANIZATION" }>,
): Promise<OrganizationDashboardData> {
  const period = filterInput.period;
  const now = new Date();
  const periodRange = getDateRange(period, now);
  const seriesGranularity = getMonthlySeriesGranularity(period);
  const seriesRange = getDateRange(seriesGranularity, now);

  // "moneyScope" — proje filtresi yalnızca parasal toplamları, aylık seriyi,
  // kategori dağılımını, yaklaşanlar listesini ve son hareketleri daraltır.
  // Kasa/banka bakiyesi, aktif proje/müşteri/tedarikçi sayıları, bütçe-kritik
  // proje sayısı ve proje karşılaştırması her zaman organizasyon geneli kalır
  // (bunlar tek bir projeye özgülenemeyecek kavramlardır) — görev talimatları
  // "limited and stable filter model" ilkesiyle uyumlu, kasıtlı bir tasarım
  // kararıdır.
  const { projectFilter, moneyScope } = actorScope;

  const [
    settlementTotals,
    incomeOpenOverdue,
    expenseOpenOverdue,
    cashAndBankBalanceDecimal,
    activeProjectCount,
    totalProjectCount,
    activeCustomerCount,
    activeSupplierCount,
    allProjects,
    projectIncomeGroups,
    projectExpenseGroups,
    monthlySettlements,
    expenseCategoryDistribution,
    upcomingCollections,
    upcomingPayments,
    recentMovements,
  ] = await Promise.all([
    getSettlementTotalsForRange(actor.organizationId, periodRange, moneyScope),
    getOpenAndOverdueTotals(db, { organizationId: actor.organizationId, type: "INCOME", projectIds: moneyScope }),
    getOpenAndOverdueTotals(db, { organizationId: actor.organizationId, type: "EXPENSE", projectIds: moneyScope }),
    getOrganizationCashBalance(db, actor.organizationId),
    db.project.count({ where: { organizationId: actor.organizationId, status: "ACTIVE" } }),
    db.project.count({ where: { organizationId: actor.organizationId } }),
    db.customer.count({ where: { organizationId: actor.organizationId, isActive: true } }),
    db.supplier.count({ where: { organizationId: actor.organizationId, isActive: true } }),
    db.project.findMany({
      where: { organizationId: actor.organizationId },
      select: { id: true, name: true, code: true, status: true, estimatedBudget: true },
    }),
    db.financialTransaction.groupBy({
      by: ["projectId"],
      where: { organizationId: actor.organizationId, type: "INCOME", status: { not: "CANCELLED" }, projectId: { not: null } },
      _sum: { totalAmount: true },
    }),
    db.financialTransaction.groupBy({
      by: ["projectId"],
      where: { organizationId: actor.organizationId, type: "EXPENSE", status: { not: "CANCELLED" }, projectId: { not: null } },
      _sum: { totalAmount: true },
    }),
    db.settlement.findMany({
      where: {
        organizationId: actor.organizationId,
        status: "ACTIVE",
        settlementDate: { gte: seriesRange.start, lt: seriesRange.end },
        ...(moneyScope ? { transaction: { projectId: { in: moneyScope } } } : {}),
      },
      select: { amount: true, settlementDate: true, type: true },
    }),
    getCategoryDistribution(actor.organizationId, periodRange, moneyScope),
    findUpcomingItems(actor.organizationId, "INCOME", moneyScope),
    findUpcomingItems(actor.organizationId, "EXPENSE", moneyScope),
    getRecentMovements(actor.organizationId, projectFilter?.id ?? null),
  ]);

  const cashAndBankBalance = cashAndBankBalanceDecimal.toString();

  const expenseByProject = new Map(
    projectExpenseGroups.map((g) => [g.projectId as string, toDecimal(g._sum.totalAmount ?? ZERO)]),
  );
  const budgetCriticalProjectCount = computeBudgetCriticalCount(allProjects, expenseByProject);
  const projectComparison = buildProjectComparison(
    projectIncomeGroups,
    projectExpenseGroups,
    allProjects,
    PROJECT_COMPARISON_LIMIT,
  );

  const months = buildMonthLabels(seriesRange);
  const collectedRows = monthlySettlements.filter((s) => s.type === "COLLECTION").map((s) => ({ amount: s.amount, date: s.settlementDate }));
  const paidRows = monthlySettlements.filter((s) => s.type === "PAYMENT").map((s) => ({ amount: s.amount, date: s.settlementDate }));
  const collectedBuckets = bucketByMonth(collectedRows, months);
  const paidBuckets = bucketByMonth(paidRows, months);
  const monthlySeries: MonthlyPoint[] = months.map((m, i) => ({
    key: m.key,
    label: m.label,
    collected: Number(collectedBuckets[i].toFixed(2)),
    paid: Number(paidBuckets[i].toFixed(2)),
    net: Number(collectedBuckets[i].minus(paidBuckets[i]).toFixed(2)),
  }));

  return {
    scope: "ORGANIZATION",
    period,
    projectFilter,
    kpis: {
      collectedIncome: settlementTotals.collected.toString(),
      paidExpense: settlementTotals.paid.toString(),
      netCashFlow: settlementTotals.net.toString(),
      openReceivable: incomeOpenOverdue.open.toString(),
      overdueReceivable: incomeOpenOverdue.overdue.toString(),
      openPayable: expenseOpenOverdue.open.toString(),
      overduePayable: expenseOpenOverdue.overdue.toString(),
      cashAndBankBalance,
      activeProjectCount,
      totalProjectCount,
      activeCustomerCount,
      activeSupplierCount,
      budgetCriticalProjectCount,
    },
    monthlySeries,
    monthlySeriesGranularity: seriesGranularity,
    expenseCategoryDistribution,
    projectComparison,
    upcomingCollections,
    upcomingPayments,
    recentMovements,
  };
}

function emptyPmDashboard(
  period: DashboardPeriod,
  projectFilter: { id: string; name: string } | null,
  seriesGranularity: MonthlySeriesGranularity,
  months: MonthLabel[],
): ProjectManagerDashboardData {
  return {
    scope: "PROJECT_MANAGER",
    period,
    projectFilter,
    hasAssignedProjects: false,
    kpis: {
      collectedIncome: "0",
      paidExpense: "0",
      netCashFlow: "0",
      openReceivable: "0",
      overdueReceivable: "0",
      openPayable: "0",
      overduePayable: "0",
      activeProjectCount: 0,
      totalProjectCount: 0,
      budgetCriticalProjectCount: 0,
    },
    monthlySeries: months.map((m) => ({ key: m.key, label: m.label, collected: 0, paid: 0, net: 0 })),
    monthlySeriesGranularity: seriesGranularity,
    expenseCategoryDistribution: [],
    projectComparison: [],
    upcomingCollections: [],
    upcomingPayments: [],
    recentProjectActivity: [],
  };
}

async function getProjectManagerDashboard(
  actor: SessionUser,
  filterInput: DashboardFilterInput,
  actorScope: Extract<ActorReportScope, { scope: "PROJECT_MANAGER" }>,
): Promise<ProjectManagerDashboardData> {
  const period = filterInput.period;
  const now = new Date();
  const periodRange = getDateRange(period, now);
  const seriesGranularity = getMonthlySeriesGranularity(period);
  const seriesRange = getDateRange(seriesGranularity, now);
  const months = buildMonthLabels(seriesRange);

  const { assignedProjectIds: assignedIds, projectFilter, moneyScope } = actorScope;

  if (assignedIds.length === 0) {
    return emptyPmDashboard(period, projectFilter, seriesGranularity, months);
  }

  const [
    settlementTotals,
    incomeOpenOverdue,
    expenseOpenOverdue,
    activeProjectCount,
    assignedProjects,
    projectIncomeGroups,
    projectExpenseGroups,
    monthlySettlements,
    expenseCategoryDistribution,
    upcomingCollections,
    upcomingPayments,
    recentActivity,
  ] = await Promise.all([
    getSettlementTotalsForRange(actor.organizationId, periodRange, moneyScope),
    getOpenAndOverdueTotals(db, { organizationId: actor.organizationId, type: "INCOME", projectIds: moneyScope }),
    getOpenAndOverdueTotals(db, { organizationId: actor.organizationId, type: "EXPENSE", projectIds: moneyScope }),
    db.project.count({ where: { organizationId: actor.organizationId, id: { in: assignedIds }, status: "ACTIVE" } }),
    db.project.findMany({
      where: { organizationId: actor.organizationId, id: { in: assignedIds } },
      select: { id: true, name: true, code: true, status: true, estimatedBudget: true },
    }),
    db.financialTransaction.groupBy({
      by: ["projectId"],
      where: { organizationId: actor.organizationId, type: "INCOME", status: { not: "CANCELLED" }, projectId: { in: assignedIds } },
      _sum: { totalAmount: true },
    }),
    db.financialTransaction.groupBy({
      by: ["projectId"],
      where: { organizationId: actor.organizationId, type: "EXPENSE", status: { not: "CANCELLED" }, projectId: { in: assignedIds } },
      _sum: { totalAmount: true },
    }),
    db.settlement.findMany({
      where: {
        organizationId: actor.organizationId,
        status: "ACTIVE",
        settlementDate: { gte: seriesRange.start, lt: seriesRange.end },
        transaction: { projectId: { in: moneyScope } },
      },
      select: { amount: true, settlementDate: true, type: true },
    }),
    getCategoryDistribution(actor.organizationId, periodRange, moneyScope),
    findUpcomingItems(actor.organizationId, "INCOME", moneyScope),
    findUpcomingItems(actor.organizationId, "EXPENSE", moneyScope),
    db.financialTransaction.findMany({
      where: { organizationId: actor.organizationId, projectId: { in: moneyScope } },
      orderBy: { updatedAt: "desc" },
      take: 10,
      select: {
        id: true,
        type: true,
        description: true,
        totalAmount: true,
        status: true,
        issueDate: true,
        project: { select: { name: true } },
      },
    }),
  ]);

  const expenseByProject = new Map(
    projectExpenseGroups.map((g) => [g.projectId as string, toDecimal(g._sum.totalAmount ?? ZERO)]),
  );
  const budgetCriticalProjectCount = computeBudgetCriticalCount(assignedProjects, expenseByProject);
  const projectComparison = buildProjectComparison(
    projectIncomeGroups,
    projectExpenseGroups,
    assignedProjects,
    PROJECT_COMPARISON_LIMIT,
  );

  const collectedRows = monthlySettlements.filter((s) => s.type === "COLLECTION").map((s) => ({ amount: s.amount, date: s.settlementDate }));
  const paidRows = monthlySettlements.filter((s) => s.type === "PAYMENT").map((s) => ({ amount: s.amount, date: s.settlementDate }));
  const collectedBuckets = bucketByMonth(collectedRows, months);
  const paidBuckets = bucketByMonth(paidRows, months);
  const monthlySeries: MonthlyPoint[] = months.map((m, i) => ({
    key: m.key,
    label: m.label,
    collected: Number(collectedBuckets[i].toFixed(2)),
    paid: Number(paidBuckets[i].toFixed(2)),
    net: Number(collectedBuckets[i].minus(paidBuckets[i]).toFixed(2)),
  }));

  return {
    scope: "PROJECT_MANAGER",
    period,
    projectFilter,
    hasAssignedProjects: true,
    kpis: {
      collectedIncome: settlementTotals.collected.toString(),
      paidExpense: settlementTotals.paid.toString(),
      netCashFlow: settlementTotals.net.toString(),
      openReceivable: incomeOpenOverdue.open.toString(),
      overdueReceivable: incomeOpenOverdue.overdue.toString(),
      openPayable: expenseOpenOverdue.open.toString(),
      overduePayable: expenseOpenOverdue.overdue.toString(),
      activeProjectCount,
      totalProjectCount: assignedIds.length,
      budgetCriticalProjectCount,
    },
    monthlySeries,
    monthlySeriesGranularity: seriesGranularity,
    expenseCategoryDistribution,
    projectComparison,
    upcomingCollections,
    upcomingPayments,
    recentProjectActivity: recentActivity.map((r) => ({
      id: r.id,
      type: r.type,
      description: r.description,
      projectName: r.project?.name ?? "—",
      totalAmount: toDecimal(r.totalAmount).toString(),
      status: r.status,
      issueDate: r.issueDate,
    })),
  };
}
