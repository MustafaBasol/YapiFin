# YF-803 — Genelleştirilmiş kullanım/kota + add-on (top-up) mimarisi

## Amaç

YF-711 (AI kota/rezervasyon) ve YF-817 (OCR aylık kota) ayrı ayrı ama aynı
temel deseni (`Plan.limits` → dahil kota, `lib/entitlements/
entitlement-service.ts` `checkLimit`/`assertWithinLimitAtomic` → uygulama
noktası) izleyerek inşa edilmişti. YF-803 bu iki tüketiciyi (ve ileride
SMS/WhatsApp/e-belge gibi metrelenen dış maliyetli servisleri) TEK bir
genelleştirilmiş kullanım/kota mimarisinde birleştirir — **var olan AI/OCR
alt sistemlerini yeniden yazmadan**, yalnızca eksik olan tek parçayı
(satın alınan/ek "add-on" kota) merkezi katmana ekleyerek.

## Neden yeniden yazmadık

- `AiUsageLedger` (YF-711) — rezervasyon/idempotency/audit/maliyet
  muhasebesi zaten kanıtlanmış, üretime hazır. İkinci bir "AI kota alt
  sistemi" İCAT ETMEK görev talimatına açıkça aykırıdır.
- `DocumentExtraction` (YF-817) — OCR'ın "kullanım defteri" zaten kalıcı
  taslak kaydının kendisidir; ayrı bir ledger İCAT ETMEK gereksiz
  tekrardır (bkz. `lib/entitlements/ocr-quota-usage.ts` dosya başı yorumu).

Bu iki ledger, YF-803'ün "usage ledger" gereksinimini ZATEN karşılar
(tenant scope, miktar, dönem, idempotency, köken, zaman damgası — hiçbiri
ham prompt/PII taşımaz). YF-803'ün gerçek katkısı **arz (supply) tarafı**:
plan dahil kotasının üzerine satın alınan ek kotanın nasıl ekleneceği.

## Yeni parça: `UsageAddonGrant`

`prisma/schema.prisma` — tenant-scoped, `resource` (bir `LimitId` string
değeri) ile anahtarlanmış, `amount` + geçerlilik penceresi (`validFrom`/
`validUntil`) taşıyan bir "arz" kaydı. Bir TÜKETİM kaydı DEĞİLDİR —
tüketim her zaman ilgili kaynağın kendi ledger'ında kalır.

```
available(resource) = resolveLimitMax(plan, resource)      // dahil kota
                     + getActiveAddonQuota(org, resource)   // geçerli ek/top-up toplamı
                     - countUsage(org, resource)             // gerçek tüketim (mevcut ledger'lardan)
```

`lib/entitlements/usage-addons.ts`:
- `getActiveAddonQuota(client, organizationId, resource, now?)` — okuma.
- `grantUsageAddon(client, input)` — idempotent yazma (`(organizationId,
  idempotencyKey)` benzersizliği + `P2002` yarış çözümü — `AiUsageLedger`
  idempotency deseninin daha basit bir varyantı).
- `expireUsageAddonGrant(client, organizationId, grantId, at?)` — iptal/iade;
  satır SİLİNMEZ, yalnızca `validUntil` çekilir (mimari ilke "hard delete
  yok").

`lib/entitlements/entitlement-service.ts`:
- `resolveEffectiveLimitMax(client, organizationId, limitId, plan?)` —
  dahil + ek kota toplamı. Plan sınırsızsa (`null`) ek kota hiç
  sorgulanmaz.
- `checkLimit` artık bunu kullanır — `max`/`remaining`/`canAddOne`/
  `isOverLimit` HEP etkin (dahil+ek) toplama göre hesaplanır;
  `includedMax`/`addonMax` şeffaflık için ayrıca döner.
- `resolveLimitMax` (yalnızca plan dahil kotası) DEĞİŞMEDİ — YF-805 plan
  karşılaştırma ekranı (dört kanonik planın SOYUT karşılaştırması, tek bir
  organizasyonun add-on durumundan bağımsız) bunu kasıtlı olarak
  kullanmaya devam eder.
- `computeUsageStatus(max, used)` + `WARNING_THRESHOLD_RATIO` (%80) — AI
  özeti (`ai-usage-service.ts`) ve plan karşılaştırma ekranının
  (`plan-comparison-service.ts`) TEK, paylaşılan uyarı/tükenme durumu
  hesaplayıcısı.

## Atomicity

`resolveEffectiveLimitMax`, çağıranın verdiği `client`/`tx` içinde çalışır.
`server/services/ai-usage-reporting-service.ts` `checkQuota`'nın Serializable
transaction'ı (organizasyon satır kilidi altında) artık add-on'u da AYNI
tutarlı anlık görüntüde okur — bir add-on'un satın alınması ile bir AI
rezervasyonu arasında yarım/tutarsız bir toplam GÖRÜLEMEZ.
`assertWithinLimitAtomic` (OCR'ın kullandığı) zaten `checkLimit`'in üzerine
kurulu olduğundan aynı garantiyi otomatik miras alır — OCR tarafında hiçbir
değişiklik gerekmedi.

## Genişleme noktası (SMS/WhatsApp/e-belge — BU GÖREVDE UYGULANMAZ)

Yeni bir metrelenen kaynak eklemek üç adımdır ve `UsageAddonGrant`
şemasına DOKUNMAZ:

1. `lib/entitlements/capabilities.ts` `LIMIT_IDS`'e yeni bir kimlik ekle
   (ör. `"sms.monthly_quota"`).
2. `lib/entitlements/entitlement-service.ts` `countUsage`'a bir `case`
   ekle (yeni bir ledger İCAT ETMEDEN önce mevcut bir modelin yeniden
   kullanılıp kullanılamayacağını değerlendir — `ocr.monthly_quota`
   örneğine bkz.).
3. `lib/entitlements/plan-defaults.ts`'e ilgili Plan satırlarını ekle.

`UsageAddonGrant.resource` bir düz string olduğundan (DB seviyesinde enum/FK
ile ZORLANMAZ, yalnızca `isLimitId` ile servis katmanında doğrulanır) yeni
kaynak add-on/top-up desteğini OTOMATİK kazanır — sağlayıcıya özgü ikinci
bir tablo gerekmez.

## YF-813 (Stripe add-on satın alma) için sınır

Bu görev Stripe entegrasyonu İÇERMEZ. YF-813'ün tüketeceği sınır:
`grantUsageAddon(tx, { organizationId, resource, amount, idempotencyKey,
source, validFrom?, validUntil?, metadata?, createdById? })`. `organizationId`
her zaman çağıran TARAFINDAN (webhook'un Stripe customer ↔ organizasyon
eşlemesinden, bkz. `OrganizationStripeCustomer` YF-808) sunucu tarafında
çözümlenmelidir — bu fonksiyon onu asla doğrulamaz/çözümlemez.
`idempotencyKey`, Stripe event/invoice kimliğinden türetilmelidir ki bir
webhook retry'ı aynı satın almayı iki kez bağışlamasın.
