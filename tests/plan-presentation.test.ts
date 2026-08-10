import { describe, it, expect } from "vitest";
import { CAPABILITY_IDS } from "@/lib/entitlements/capabilities";
import {
  CAPABILITY_DISPLAY_LABELS,
  PLAN_TAGLINES,
  PRICE_PLACEHOLDER_TEXT,
  RECOMMENDED_PLAN_CODE,
  formatLimitMax,
  isRecommendedPlan,
  resolveFeatureCellState,
  resolvePlanCtaKind,
} from "@/lib/plan-presentation";

/**
 * YF-805 — Plan karşılaştırma ekranının SUNUM yardımcıları için saf (pure)
 * fonksiyon testleri. Repo'da React bileşen render altyapısı (RTL/jsdom)
 * olmadığından (bkz. vitest.config.ts environment: "node"), bu dosya
 * bileşenin ürettiği tüm KARARLARI (etiket, rozet, CTA türü, "Sınırsız"
 * biçimi) React'ten bağımsız olarak doğrular; components/app/plan-comparison-view.tsx
 * bu fonksiyonların ince bir JSX tüketicisidir.
 */

describe("PLAN_TAGLINES — onaylı pazarlama sloganları BİREBİR", () => {
  it("dört kanonik plan kodu için de onaylı slogan tanımlıdır", () => {
    expect(PLAN_TAGLINES.STARTER).toBe("Projelerinizin parasını tek yerde yönetin.");
    expect(PLAN_TAGLINES.PROFESSIONAL).toBe("Bütçeyi, nakit akışını ve proje kârlılığını kontrol altında tutun.");
    expect(PLAN_TAGLINES.BUSINESS).toBe("Tüm finans operasyonunuzu yönetin ve AI ile riskleri önceden görün.");
    expect(PLAN_TAGLINES.ENTERPRISE).toBe("Kurumsal ölçekte finansal kontrol, otomasyon ve entegrasyon.");
  });
});

describe("isRecommendedPlan — yalnızca Professional 'Önerilen' rozetini alır", () => {
  it("PROFESSIONAL için true döner", () => {
    expect(RECOMMENDED_PLAN_CODE).toBe("PROFESSIONAL");
    expect(isRecommendedPlan("PROFESSIONAL")).toBe(true);
  });

  it("STARTER/BUSINESS/ENTERPRISE için false döner", () => {
    expect(isRecommendedPlan("STARTER")).toBe(false);
    expect(isRecommendedPlan("BUSINESS")).toBe(false);
    expect(isRecommendedPlan("ENTERPRISE")).toBe(false);
  });
});

describe("formatLimitMax — 'Sınırsız' kuralı ve Türkçe sayı biçimi", () => {
  it("null için 'Sınırsız' döner", () => {
    expect(formatLimitMax(null)).toBe("Sınırsız");
  });

  it("sayısal limitler için tr-TR grup ayracıyla biçimlenir", () => {
    expect(formatLimitMax(0)).toBe("0");
    expect(formatLimitMax(25)).toBe("25");
    expect(formatLimitMax(2000)).toBe("2.000");
  });
});

describe("resolvePlanCtaKind — CTA türü seçimi (YF-809: kendi kendine planlar gerçek Checkout'a bağlı)", () => {
  it("mevcut plan her zaman 'current' döner (Enterprise dahil)", () => {
    expect(resolvePlanCtaKind("PROFESSIONAL", true)).toBe("current");
    expect(resolvePlanCtaKind("ENTERPRISE", true)).toBe("current");
  });

  it("mevcut olmayan Enterprise 'contact' (Bize Ulaşın) döner — kendi kendine ödeme YOK", () => {
    expect(resolvePlanCtaKind("ENTERPRISE", false)).toBe("contact");
  });

  it("mevcut olmayan Starter/Professional/Business 'purchase' döner (gerçek Stripe Checkout'a bağlı)", () => {
    expect(resolvePlanCtaKind("STARTER", false)).toBe("purchase");
    expect(resolvePlanCtaKind("PROFESSIONAL", false)).toBe("purchase");
    expect(resolvePlanCtaKind("BUSINESS", false)).toBe("purchase");
  });
});

describe("resolveFeatureCellState — mevcut olmayan özellik asla 'available' görünmez", () => {
  it("true -> available", () => {
    expect(resolveFeatureCellState(true)).toBe("available");
  });

  it("false -> unavailable (sessizce eksik DEĞİL, açıkça 'yok')", () => {
    expect(resolveFeatureCellState(false)).toBe("unavailable");
  });
});

describe("CAPABILITY_DISPLAY_LABELS — kanonik capability kimlik kümesiyle tam eşleşir", () => {
  it("her CAPABILITY_ID için tam olarak bir Türkçe etiket vardır (fazla/eksik yok)", () => {
    const labelKeys = Object.keys(CAPABILITY_DISPLAY_LABELS).sort();
    const canonicalKeys = [...CAPABILITY_IDS].sort();
    expect(labelKeys).toEqual(canonicalKeys);
  });
});

describe("fiyat — asla fabrikasyon numara üretilmez", () => {
  it("nötr placeholder metni tanımlıdır ve bir sayı İÇERMEZ", () => {
    expect(PRICE_PLACEHOLDER_TEXT).toBe("Fiyat bilgisi için bize ulaşın");
    expect(/\d/.test(PRICE_PLACEHOLDER_TEXT)).toBe(false);
  });
});
