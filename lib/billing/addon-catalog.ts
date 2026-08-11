import { getEnv } from "@/lib/env";
import { isLimitId, type LimitId } from "@/lib/entitlements/capabilities";
import { BillingConfigError } from "@/lib/billing/errors";
import { CONTACT_SALES_SENTINEL, getStripeConfig } from "@/lib/billing/stripe-config";

/**
 * YF-813 — Satın alınabilir kullanım/kota ek paketlerinin (add-on/top-up)
 * TEK sunucu tarafı kataloğu.
 *
 * ## Girdi güveni (görev talimatı ile AYNI ilke, YF-809 §3 ile AYNI desen)
 *
 * İstemciden **yalnızca** kanonik `addonKey` kabul edilir (bkz.
 * server/services/billing/addon-checkout-service.ts). Aşağıdakilerin HİÇBİRİ
 * istemciden alınmaz/güvenilmez: Stripe Price/Product ID, tutar/para birimi,
 * bağışlanacak kota miktarı, kaynak (`resource`) kimliği, `organizationId`,
 * geçerlilik penceresi — TAMAMI bu dosyadan (yalnızca `addonKey` anahtarıyla)
 * sunucu tarafında çözümlenir.
 *
 * ## Kapsam (görev talimatı madde 2 "one-time top-up packs")
 *
 * Bugün yalnızca tek seferlik (`amount` sabit, `validUntil: null` — süresiz
 * geçerli top-up) paketler desteklenir. Yinelenen (recurring) add-on
 * kotası, SMS/WhatsApp/e-belge kullanım paketleri KASITLI OLARAK
 * uygulanmamıştır — genişletme yalnızca bu diziye yeni bir girdi eklemek ve
 * ilgili `STRIPE_PRICE_ADDON_*` ortam değişkenini tanımlamak anlamına gelir
 * (bkz. lib/env.ts, `UsageAddonGrant`/`grantUsageAddon` şeması DEĞİŞMEZ —
 * `LimitId` zaten sağlayıcı-nötr bir "kaynak" soyutlamasıdır, bkz.
 * docs/architecture/YF-803_USAGE_QUOTA_ADDONS.md "genişleme noktası").
 *
 * ## Miktar/fiyat kaynağı
 *
 * `amount` (bağışlanacak kota) bu dosyada SABİT KODLANIR — Stripe'ın Price
 * nesnesinden ASLA türetilmez (Stripe yalnızca ÖDEME tutarını/para birimini
 * bilir, kota anlamını BİLMEZ). Aşağıdaki sayısal değerler, `lib/entitlements/
 * plan-defaults.ts` DEFAULT_PLANS'taki PROFESSIONAL aylık dahil kotasının
 * (`ai.monthly_quota`: 500, `ocr.monthly_quota`: 50) yarısı büyüklüğünde,
 * O DOSYAYLA AYNI gerekçeyle GEÇİCİ/düşük riskli başlangıç paket
 * büyüklükleridir — gerçek ticari paket boyutu/fiyatı
 * docs/product/YF-807-plan-unit-economics.md §8'in "top-up ekonomisi
 * ÇÖZÜLMEMİŞTİR" notuyla AYNI, henüz netleşmemiş bir fiyatlandırma/paketleme
 * kararıdır — burada UYDURULMAMIŞTIR, yalnızca altyapıyı çalışır kılacak
 * makul bir seed değeridir.
 */
export interface AddonCatalogEntry {
  readonly addonKey: string;
  readonly resource: LimitId;
  /** Bir satın almanın bağışladığı sabit kota miktarı — her zaman > 0. */
  readonly amount: number;
  /** Türkçe, kullanıcıya gösterilebilir kısa ad. */
  readonly displayName: string;
  /** Türkçe, kullanıcıya gösterilebilir kısa açıklama. */
  readonly description: string;
  /** Bu paketin fiyatını taşıyan `STRIPE_PRICE_ADDON_*` ortam değişkeninin adı (bkz. lib/env.ts). */
  readonly envVarName: string;
}

export const ADDON_CATALOG: readonly AddonCatalogEntry[] = Object.freeze([
  Object.freeze({
    addonKey: "ai_credits_pack",
    resource: "ai.monthly_quota",
    amount: 250,
    displayName: "Yapay Zekâ Kredi Paketi",
    description: "Aylık yapay zekâ kullanım kotanıza ek 250 kredi ekler.",
    envVarName: "STRIPE_PRICE_ADDON_AI_CREDITS",
  }),
  Object.freeze({
    addonKey: "ocr_documents_pack",
    resource: "ocr.monthly_quota",
    amount: 25,
    displayName: "OCR Belge Paketi",
    description: "Aylık belge/fiş OCR çıkarım kotanıza ek 25 belge ekler.",
    envVarName: "STRIPE_PRICE_ADDON_OCR_DOCS",
  }),
]);

// Katalog kimliklerinin `LimitId` ile hizalı kaldığını derleme zamanında
// kanıtlar — bir add-on kaynağı `isLimitId`'nin tanımadığı bir string OLAMAZ.
ADDON_CATALOG.forEach((entry) => {
  if (!isLimitId(entry.resource)) {
    throw new Error(`Katalog bütünlüğü hatası: "${entry.resource}" bilinen bir LimitId değil.`);
  }
});

export const ADDON_KEYS: readonly string[] = Object.freeze(ADDON_CATALOG.map((e) => e.addonKey));

export function isAddonKey(value: string): boolean {
  return ADDON_KEYS.includes(value);
}

function findCatalogEntry(addonKey: string): AddonCatalogEntry | undefined {
  return ADDON_CATALOG.find((e) => e.addonKey === addonKey);
}

export interface ResolvedAddonPrice {
  readonly entry: AddonCatalogEntry;
  readonly priceId: string;
}

/**
 * Bir `addonKey`'i kataloğa + yapılandırılmış Stripe Price ID'sine çözer.
 * Fail-closed: bilinmeyen `addonKey`, yapılandırılmamış fiyat veya (add-on'lar
 * için anlamsız olan) `CONTACT_SALES` sentinel'i her zaman `BillingConfigError`
 * ile reddedilir — sessizce atlanmaz (bkz. lib/billing/stripe-config.ts
 * `resolveStripePriceForPlan` ile AYNI felsefe).
 */
export function resolveAddonPrice(addonKey: string): ResolvedAddonPrice {
  // Ortam çözümlemesi ÖNCE — yapılandırılmamış/tutarsız bir Stripe
  // kurulumunda bir fiyat kimliği ASLA döndürülmez.
  getStripeConfig();

  const entry = findCatalogEntry(addonKey);
  if (!entry) {
    throw new BillingConfigError(`Bilinmeyen ek paket anahtarı: "${addonKey}".`);
  }

  const raw = getEnv().stripe.addonPrices[entry.envVarName.replace("STRIPE_PRICE_", "")] ?? null;
  if (!raw || raw === CONTACT_SALES_SENTINEL) {
    throw new BillingConfigError(`${entry.envVarName} yapılandırılmamış — "${addonKey}" paketi satın alınamaz.`);
  }
  if (!/^price_[A-Za-z0-9]+$/.test(raw)) {
    throw new BillingConfigError(`${entry.envVarName} geçerli bir Stripe Price ID değil.`);
  }

  return Object.freeze({ entry, priceId: raw });
}

/**
 * YF-813 — `resolveAddonPrice`'ın TERSİ: webhook'tan/Checkout Session'dan
 * gelen bir Stripe Price ID'sini kanonik add-on kataloğuna çözer
 * (`lib/billing/stripe-config.ts` `resolvePlanForStripePrice` ile AYNI
 * desen). Fail-closed: eşleşen bir katalog girdisi YOKSA (yapılandırılmamış/
 * ops sürüklenmesi) `null` döner, hata FIRLATMAZ — çağıran (bkz.
 * server/services/billing/addon-grant-service.ts) hiçbir bağış YAPMADAN
 * olayı güvenle yok sayar.
 */
export function resolveAddonForStripePrice(priceId: string): AddonCatalogEntry | null {
  for (const entry of ADDON_CATALOG) {
    let resolved: ResolvedAddonPrice;
    try {
      resolved = resolveAddonPrice(entry.addonKey);
    } catch {
      continue; // Bu paket yapılandırılmamış — atla.
    }
    if (resolved.priceId === priceId) return entry;
  }
  return null;
}
