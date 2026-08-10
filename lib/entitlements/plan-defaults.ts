import type { CapabilityId, LimitId } from "@/lib/entitlements/capabilities";

/**
 * YF-801-A — Varsayılan plan tanımları. Bu, gerçek bir fiyatlandırma/satış
 * sayfası DEĞİLDİR (görev kapsamı dışı) — yalnızca kota/yetenek altyapısını
 * çalışır kılmak için gereken minimum, dahili yapılandırmadır. Kalıcı
 * kaynak yine de veritabanıdır (`Plan` tablosu, bkz.
 * prisma/migrations/*_yf802_plan_entitlements ve takip eden
 * *_yf801a_plan_seed_alignment); bu dosya yalnızca o migration'ların
 * INSERT/UPDATE'lerini ve olası bir yeniden-tohumlama (reseed) ihtiyacını
 * TEK bir yerden belgeler/türetir — kod, planı asla bu diziden çalışma
 * zamanında okumaz (bkz. entitlement-service.ts: her zaman DB'deki `Plan`
 * satırı okunur).
 *
 * Değerler `docs/PLAN_FEATURE_MATRIX.md` §1/§3'teki kanonik ClickUp karar
 * matrisiyle birebir hizalanmıştır (YF-801-A — bkz. o dokümanın §5 "gap"
 * tablosu için önceki çalışma zamanı değerleriyle karşılaştırma). AI aylık
 * kota (`ai.monthly_quota`) SAYISAL değerleri (Professional: 500,
 * Business: 2000) matrisin kendisinin kapsamı dışında bıraktığı bir
 * satış/paket kararı yerine geçici, düşük riskli bir başlangıç seed
 * değeridir — yalnızca "Professional > 0 ve Business, Professional'dan
 * yüksek" kanonik kısıtını sağlar; gerçek ticari değer YF-805 (fiyatlandırma/
 * paketleme) kapsamında netleştirilmelidir.
 *
 * YF-817 — OCR aylık kota (`ocr.monthly_quota`) SAYISAL değerleri
 * (Professional: 50, Business: 200) da AYNI gerekçeyle GEÇİCİ, düşük riskli
 * başlangıç seed değerleridir — yalnızca "Starter=0 (ocr zaten kapalı),
 * Professional>0, Business>Professional, Enterprise=null (configurable)"
 * kanonik kısıtını sağlarlar. Gerçek ticari OCR kota rakamları BİLİNÇLİ
 * OLARAK UYDURULMAMIŞTIR — docs/product/YF-807-plan-unit-economics.md §9,
 * gerçek bir OCR sağlayıcısı/birim fiyatı entegre edilmediğini ve
 * `OCR_COST_PER_PAGE`'in bugün tamamen sembolik kaldığını AÇIKÇA belirtir;
 * bu rakamlar yalnızca YF-817'nin (kota altyapısı) DEĞİL, ayrı bir
 * fiyatlandırma/paketleme kararının konusudur.
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
    limits: { "users.active": 3, "projects.active": 5, "ai.monthly_quota": 0, "ocr.monthly_quota": 0 },
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
    limits: { "users.active": 10, "projects.active": 25, "ai.monthly_quota": 500, "ocr.monthly_quota": 50 },
    capabilities: {
      "reports.advanced": true,
      "export.xlsx": true,
      "export.pdf": true,
      bank_import: true,
      ocr: true,
      // YF-801-A — PLAN_FEATURE_MATRIX.md §5 madde 6: e-belge/muhasebe
      // entegrasyon ERİŞİMİ karar matrisinde Business katmanına aittir;
      // Professional'daki eski `true` değeri bir implementation-alignment
      // gap'iydi. `e_document` bugün hiçbir servis noktasında
      // `assertCapability` ile uygulanmadığından (§5 madde 8) bu saf bir
      // veri düzeltmesidir, davranışsal bir kısıtlama eklemez.
      e_document: false,
      // YF-801-A — YF-711 (AI kota/rezervasyon motoru) tamamlandığı için
      // bu artık salt bir seed/veri değişikliğidir (bkz. PLAN_FEATURE_MATRIX.md
      // §5 madde 4) — motor zaten `ai.features`/`ai.monthly_quota`'yı
      // gerçekten tüketiyor, ek altyapı gerekmiyor.
      "ai.features": true,
    },
  },
  {
    code: "BUSINESS",
    name: "İşletme",
    // YF-801-A — PLAN_FEATURE_MATRIX.md §5 madde 3: Business bu görevden
    // önce hiç bir runtime Plan kaydı olarak mevcut değildi.
    limits: { "users.active": 30, "projects.active": 100, "ai.monthly_quota": 2000, "ocr.monthly_quota": 200 },
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
  {
    code: "ENTERPRISE",
    name: "Kurumsal",
    limits: { "users.active": null, "projects.active": null, "ai.monthly_quota": null, "ocr.monthly_quota": null },
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
 * (temel modüller + AI dahil, herkese açık) korumak amacıyla
 * ücretsiz-katman olmayan en düşük katman PROFESSIONAL seçildi;
 * STARTER/BUSINESS/ENTERPRISE yalnızca gelecekteki plan farklılaştırması
 * için altyapı olarak mevcuttur. YF-801-A bu seçimi DEĞİŞTİRMEZ (bkz.
 * docs/PLAN_FEATURE_MATRIX.md ilk not: bu bilinçli bir geçiş kararıdır).
 */
export const DEFAULT_ORGANIZATION_PLAN_CODE = "PROFESSIONAL";
