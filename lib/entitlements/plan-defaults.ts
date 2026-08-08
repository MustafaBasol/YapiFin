import type { CapabilityId, LimitId } from "@/lib/entitlements/capabilities";

/**
 * YF-802 — Varsayılan plan tanımları. Bu, gerçek bir fiyatlandırma/satış
 * sayfası DEĞİLDİR (görev kapsamı dışı) — yalnızca kota/yetenek altyapısını
 * çalışır kılmak için gereken minimum, dahili yapılandırmadır. Kalıcı
 * kaynak yine de veritabanıdır (`Plan` tablosu, bkz.
 * prisma/migrations/*_yf802_plan_entitlements); bu dosya yalnızca o
 * migration'ın INSERT'lerini ve olası bir yeniden-tohumlama (reseed)
 * ihtiyacını TEK bir yerden belgeler/türetir — kod, planı asla bu diziden
 * çalışma zamanında okumaz (bkz. entitlement-service.ts: her zaman DB'deki
 * `Plan` satırı okunur).
 */
export interface DefaultPlanSeed {
  code: string;
  name: string;
  limits: Partial<Record<LimitId, number | null>>;
  capabilities: Partial<Record<CapabilityId, boolean>>;
}

export const DEFAULT_PLANS: DefaultPlanSeed[] = [
  {
    code: "STARTER",
    name: "Başlangıç",
    limits: { "users.active": 3, "projects.active": 3, "ai.monthly_quota": 0 },
    capabilities: {
      "reports.advanced": false,
      "export.xlsx": true,
      "export.pdf": true,
      bank_import: false,
      ocr: false,
      e_document: false,
      "ai.features": false,
    },
  },
  {
    code: "PROFESSIONAL",
    name: "Profesyonel",
    limits: { "users.active": 15, "projects.active": 25, "ai.monthly_quota": 0 },
    capabilities: {
      "reports.advanced": true,
      "export.xlsx": true,
      "export.pdf": true,
      bank_import: true,
      ocr: true,
      e_document: true,
      "ai.features": false,
    },
  },
  {
    code: "ENTERPRISE",
    name: "Kurumsal",
    limits: { "users.active": null, "projects.active": null, "ai.monthly_quota": null },
    capabilities: {
      "reports.advanced": true,
      "export.xlsx": true,
      "export.pdf": true,
      bank_import: true,
      ocr: true,
      e_document: true,
      "ai.features": true,
    },
  },
];

/**
 * Yeni kayıt olan organizasyonlara ve geriye dönük dolgu (backfill)
 * migration'ına atanan varsayılan plan. Bugün ücretli katmanlar arasında
 * gerçek bir satış/yükseltme akışı OLMADIĞI için (görev kapsamı dışı —
 * "no billing/payment-provider integration"), mevcut ürün davranışını
 * (tüm modüller herkese açık) korumak amacıyla en geniş yeteneklere sahip
 * ücretsiz-katman olmayan PROFESSIONAL seçildi; STARTER/ENTERPRISE yalnızca
 * gelecekteki plan farklılaştırması için altyapı olarak mevcuttur.
 */
export const DEFAULT_ORGANIZATION_PLAN_CODE = "PROFESSIONAL";
