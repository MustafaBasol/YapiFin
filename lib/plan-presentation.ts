import { formatNumber } from "@/lib/utils";
import type { CapabilityId } from "@/lib/entitlements/capabilities";

/**
 * YF-805 — Plan karşılaştırma ekranının SUNUM katmanı yardımcıları. Bunlar
 * kararlı, saf (pure) fonksiyonlardır — hiçbiri bir yetki/limit KARARI
 * vermez (bu her zaman lib/entitlements/entitlement-service.ts'te), yalnızca
 * o karardan gelen veriyi Türkçe metne/duruma çevirir. React'ten bağımsız
 * tutulmuştur ki jsdom/RTL altyapısı olmayan bu repoda (bkz. vitest.config.ts
 * — environment: "node") düz `vitest` ile test edilebilsinler.
 */

/**
 * Onaylanmış pazarlama sloganları (görev talimatı — BİREBİR, değiştirilmez).
 * Kanonik plan/limit/yetenek verisiyle karışmaz: bu yalnızca sunum metnidir.
 */
export const PLAN_TAGLINES: Record<string, string> = {
  STARTER: "Projelerinizin parasını tek yerde yönetin.",
  PROFESSIONAL: "Bütçeyi, nakit akışını ve proje kârlılığını kontrol altında tutun.",
  BUSINESS: "Tüm finans operasyonunuzu yönetin ve AI ile riskleri önceden görün.",
  ENTERPRISE: "Kurumsal ölçekte finansal kontrol, otomasyon ve entegrasyon.",
};

/** Kanonik matriste "Önerilen/En popüler" olarak işaretlenen tek plan. */
export const RECOMMENDED_PLAN_CODE = "PROFESSIONAL";

export function isRecommendedPlan(code: string): boolean {
  return code === RECOMMENDED_PLAN_CODE;
}

/**
 * `CapabilityId` birleşimine karşı derleme-zamanı eksiksizlik kontrolü
 * sağlanır (`Record<CapabilityId, string>`) — yeni bir capability eklenip
 * burada unutulursa TypeScript derlemesi başarısız olur; bu da etiketlerin
 * kanonik kimlik kümesinden asla sessizce geride kalmamasını garanti eder.
 */
export const CAPABILITY_DISPLAY_LABELS: Record<CapabilityId, string> = {
  "reports.advanced": "Gelişmiş raporlar",
  "export.xlsx": "Excel'e aktarma",
  "export.pdf": "PDF'e aktarma",
  bank_import: "Banka içe aktarım ve mutabakat",
  ocr: "Belge/fiş OCR",
  e_document: "E-belge/muhasebe entegrasyonları",
  "ai.features": "Yapay zekâ özellikleri",
};

export function formatLimitMax(max: number | null): string {
  return max === null ? "Sınırsız" : formatNumber(max);
}

export const PRICE_PLACEHOLDER_TEXT = "Fiyat bilgisi için bize ulaşın";

export type PlanCtaKind = "current" | "contact" | "purchase";

/**
 * Hangi CTA'nın gösterileceğini belirler.
 *
 * YF-809 — kendi kendine satın alınabilen üç plan (STARTER/PROFESSIONAL/
 * BUSINESS) artık gerçek bir Stripe Checkout akışına bağlıdır (`purchase`,
 * bkz. components/app/plan-comparison-view.tsx + app/actions/billing.ts).
 * ENTERPRISE her zaman `contact` kalır — kendi-kendine ödeme YOKTUR (bkz.
 * lib/billing/stripe-config.ts CONTACT_SALES_SENTINEL).
 */
export function resolvePlanCtaKind(planCode: string, isCurrent: boolean): PlanCtaKind {
  if (isCurrent) return "current";
  if (planCode === "ENTERPRISE") return "contact";
  return "purchase";
}

export const PLAN_CTA_LABELS: Record<PlanCtaKind, string> = {
  current: "Zaten bu plandasınız",
  contact: "Bize Ulaşın",
  purchase: "Planı Seç",
};

export type FeatureCellState = "available" | "unavailable";

export function resolveFeatureCellState(allowed: boolean): FeatureCellState {
  return allowed ? "available" : "unavailable";
}
