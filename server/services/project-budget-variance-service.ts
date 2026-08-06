import { getProjectForUser } from "@/server/services/project-service";
import {
  getProjectBudgetPlanningForResolvedProject,
  type ProjectBudgetPlanningItem,
} from "@/server/services/project-budget-service";
import { toDecimal, ZERO } from "@/server/services/ledger";
import type { SessionUser } from "@/lib/auth/session";
import type { BudgetStatus } from "@/server/services/budget-report-service";
import type { ProjectStatus } from "@prisma/client";

/**
 * YF-407 — Proje bütçe sapma analizi ve tamamlanma tahmini.
 *
 * Bu servis YF-406'nın `getProjectBudgetPlanningForResolvedProject`
 * (planlanan/gerçekleşen/kalan/durum, kalem bazında dahil) çıktısını
 * doğrudan yeniden kullanır; gerçekleşen gider veya durum eşiği burada
 * ikinci kez hesaplanmaz — yalnızca sapma tutarı/yüzdesi (realized - planned)
 * ve tamamlanma tahmini bu üzerine eklenir. Proje erişimi tek bir
 * `getProjectForUser` çağrısıyla çözülür ve aynı sorgu setinin ürettiği
 * kalem/finans-özeti sonuçları hem sapma hem tahmin için kullanılır — ek
 * sorgu üretilmez (bkz. docs/ARCHITECTURE.md §15, §16).
 *
 * Tahmin (completion forecast) tamamen deterministiktir: proje başlangıç
 * tarihi, bugüne kadar geçen gün sayısı, toplam planlanan bütçe ve toplam
 * gerçekleşen gider dışında hiçbir veri uydurulmaz. Aşağıdaki durumlardan
 * biri geçerliyse tahmin üretilmez ve `forecast.available = false` +
 * nedeni `forecast.unavailableReason` alanında döner (öncelik sırasıyla):
 *   1. NO_START_DATE — projenin başlangıç tarihi girilmemiş
 *   2. NOT_STARTED — başlangıç tarihi gelecekte (proje henüz başlamamış)
 *   3. NO_ELAPSED_TIME — başlangıçtan bugüne geçen tam gün sayısı sıfır
 *   4. NO_EXPENSE — henüz kaydedilmiş (iptal olmayan) gider yok
 *   5. NO_BUDGET — toplam planlanan bütçe sıfır/negatif
 *
 * Formüller (tümü Prisma.Decimal ile, JS number aritmetiği kullanılmaz):
 *   elapsedDays              = floor((bugün - başlangıç) / 1 gün)
 *   dailyBurnRate             = toplamGerçekleşenGider / elapsedDays
 *   projectedTotalExpense     = dailyBurnRate * planlanan proje süresi (gün)
 *                               — yalnızca plannedEndDate > startDate ise
 *   projectedOverrunOrSavings = projectedTotalExpense - totalPlannedBudget
 *                               (pozitif = tahmini aşım, negatif = tasarruf)
 *   estimatedDaysRemainingOnBudget:
 *     kalanBütçe <= 0  → 0 (bütçe zaten tükenmiş/aşılmış)
 *     aksi halde       → floor(kalanBütçe / dailyBurnRate)
 *
 * Bu bir muhasebesel kesin sonuç değil, mevcut harcama hızının değişmeden
 * devam edeceği varsayımına dayanan operasyonel bir projeksiyondur.
 */

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export type ForecastUnavailableReason = "NO_START_DATE" | "NOT_STARTED" | "NO_ELAPSED_TIME" | "NO_BUDGET" | "NO_EXPENSE";

export const FORECAST_UNAVAILABLE_LABELS: Record<ForecastUnavailableReason, string> = {
  NO_START_DATE: "Projenin başlangıç tarihi girilmemiş, tahmin üretilemiyor.",
  NOT_STARTED: "Proje henüz başlamamış, tahmin üretilemiyor.",
  NO_ELAPSED_TIME: "Başlangıçtan bu yana yeterli süre geçmemiş, tahmin üretilemiyor.",
  NO_BUDGET: "Bu proje için planlanan bütçe girilmemiş, tahmin üretilemiyor.",
  NO_EXPENSE: "Bu projede henüz gerçekleşen gider yok, tahmin üretilemiyor.",
};

export interface ProjectCompletionForecast {
  forecastAvailable: boolean;
  unavailableReason: ForecastUnavailableReason | null;
  elapsedDays: number | null;
  dailyBurnRate: string | null;
  projectedTotalExpenseAvailable: boolean;
  projectedTotalExpense: string | null;
  projectedOverrunOrSavings: string | null;
  estimatedDaysRemainingOnBudget: number | null;
}

export interface ProjectBudgetVarianceCategoryRow extends ProjectBudgetPlanningItem {
  varianceAmount: string;
  variancePercentage: string | null;
}

export interface ProjectBudgetVarianceReport {
  project: {
    id: string;
    name: string;
    code: string;
    status: ProjectStatus;
    currency: string;
    startDate: Date | null;
    plannedEndDate: Date | null;
  };
  totalPlannedBudget: string;
  totalRealizedExpense: string;
  totalRemainingBudget: string;
  totalUsagePercentage: string | null;
  status: BudgetStatus;
  varianceAmount: string;
  variancePercentage: string | null;
  items: ProjectBudgetVarianceCategoryRow[];
  canManage: boolean;
  forecast: ProjectCompletionForecast;
}

function computeVariance(realized: string, planned: string): { amount: string; percentage: string | null } {
  const plannedDecimal = toDecimal(planned);
  const varianceAmount = toDecimal(realized).minus(plannedDecimal);
  const variancePercentage = plannedDecimal.greaterThan(ZERO)
    ? varianceAmount.div(plannedDecimal).mul(100).toDecimalPlaces(2).toString()
    : null;
  return { amount: varianceAmount.toString(), percentage: variancePercentage };
}

function computeForecast(params: {
  startDate: Date | null;
  plannedEndDate: Date | null;
  totalPlannedBudget: string;
  totalRealizedExpense: string;
  now: Date;
}): ProjectCompletionForecast {
  const unavailable = (reason: ForecastUnavailableReason): ProjectCompletionForecast => ({
    forecastAvailable: false,
    unavailableReason: reason,
    elapsedDays: null,
    dailyBurnRate: null,
    projectedTotalExpenseAvailable: false,
    projectedTotalExpense: null,
    projectedOverrunOrSavings: null,
    estimatedDaysRemainingOnBudget: null,
  });

  const { startDate, plannedEndDate, now } = params;
  if (!startDate) return unavailable("NO_START_DATE");
  if (startDate.getTime() > now.getTime()) return unavailable("NOT_STARTED");

  const elapsedDays = Math.floor((now.getTime() - startDate.getTime()) / MS_PER_DAY);
  if (elapsedDays < 1) return unavailable("NO_ELAPSED_TIME");

  const totalRealizedExpense = toDecimal(params.totalRealizedExpense);
  if (totalRealizedExpense.lessThanOrEqualTo(ZERO)) return unavailable("NO_EXPENSE");

  const totalPlannedBudget = toDecimal(params.totalPlannedBudget);
  if (totalPlannedBudget.lessThanOrEqualTo(ZERO)) return unavailable("NO_BUDGET");

  const dailyBurnRate = totalRealizedExpense.div(elapsedDays);

  const hasPlannedDuration = plannedEndDate != null && plannedEndDate.getTime() > startDate.getTime();
  const projectedTotalExpense = hasPlannedDuration
    ? dailyBurnRate.mul(Math.ceil((plannedEndDate!.getTime() - startDate.getTime()) / MS_PER_DAY))
    : null;
  const projectedOverrunOrSavings = projectedTotalExpense ? projectedTotalExpense.minus(totalPlannedBudget) : null;

  const remainingBudget = totalPlannedBudget.minus(totalRealizedExpense);
  const estimatedDaysRemainingOnBudget = remainingBudget.lessThanOrEqualTo(ZERO)
    ? 0
    : remainingBudget.div(dailyBurnRate).floor().toNumber();

  return {
    forecastAvailable: true,
    unavailableReason: null,
    elapsedDays,
    dailyBurnRate: dailyBurnRate.toDecimalPlaces(2).toString(),
    projectedTotalExpenseAvailable: hasPlannedDuration,
    projectedTotalExpense: projectedTotalExpense ? projectedTotalExpense.toDecimalPlaces(2).toString() : null,
    projectedOverrunOrSavings: projectedOverrunOrSavings ? projectedOverrunOrSavings.toDecimalPlaces(2).toString() : null,
    estimatedDaysRemainingOnBudget,
  };
}

export async function getProjectBudgetVarianceReport(actor: SessionUser, projectId: string): Promise<ProjectBudgetVarianceReport> {
  const project = await getProjectForUser(actor, projectId);
  const planning = await getProjectBudgetPlanningForResolvedProject(actor, project);

  const items: ProjectBudgetVarianceCategoryRow[] = planning.items.map((item) => {
    const variance = computeVariance(item.realizedExpense, item.plannedAmount);
    return { ...item, varianceAmount: variance.amount, variancePercentage: variance.percentage };
  });

  const totalVariance = computeVariance(planning.totalRealizedExpense, planning.totalPlannedBudget);

  const forecast = computeForecast({
    startDate: project.startDate,
    plannedEndDate: project.plannedEndDate,
    totalPlannedBudget: planning.totalPlannedBudget,
    totalRealizedExpense: planning.totalRealizedExpense,
    now: new Date(),
  });

  return {
    project: { ...planning.project, startDate: project.startDate, plannedEndDate: project.plannedEndDate },
    totalPlannedBudget: planning.totalPlannedBudget,
    totalRealizedExpense: planning.totalRealizedExpense,
    totalRemainingBudget: planning.totalRemainingBudget,
    totalUsagePercentage: planning.totalUsagePercentage,
    status: planning.status,
    varianceAmount: totalVariance.amount,
    variancePercentage: totalVariance.percentage,
    items,
    canManage: planning.canManage,
    forecast,
  };
}
