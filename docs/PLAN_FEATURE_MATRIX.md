# Plan / Özellik Matrisi (YF-801)

Bu doküman, ClickUp YF-801 kapsamında karara bağlanan **tek kanonik ürün-plan matrisidir**.
Fiyat veya sağlayıcı maliyeti içermez (kapsam dışı — bkz. görev talimatı). Amaç:

1. Her mevcut ve yol haritasındaki özellik için kararlı bir yetki (entitlement) sınıfı/anahtarı tanımlamak.
2. Plan bazında Included / Not included / Quota / Configurable durumunu netleştirmek.
3. Nicel kullanıcı/proje limitlerini kaydetmek.
4. Paywall'a tabi olmayan evrensel güvenlik/bütünlük garantilerini ayrı tutmak.
5. `lib/entitlements/capabilities.ts` ve `lib/entitlements/plan-defaults.ts` içindeki mevcut çalışma zamanı kimlikleri ve varsayılanlarıyla eşlemek.
6. Kod değiştirmeden, uygulama ile bu karar matrisi arasındaki farkları (implementation-alignment gaps) açıkça kaydetmek.
7. Henüz uygulanmamış (yol haritası) özellikleri, mevcut işlevmiş gibi göstermemek.
8. YF-802/YF-711 ve sonraki görevler için uygulama sırası ve sahiplik sınırlarını belirlemek.

> Not: `lib/entitlements/plan-defaults.ts` içindeki `DEFAULT_ORGANIZATION_PLAN_CODE = "PROFESSIONAL"` seçimi bilinçli bir geçiş kararıdır (ücretli katmanlar arası gerçek satış/yükseltme akışı henüz yok); bu doküman o kararı değiştirmez, yalnızca hedef karar matrisini kaydeder.

> **Revizyon notu (YF-801 — ikinci geçiş):** Bu doküman ilk kez commit `3bdc187` ile finalize edildiğinde YF-711 (AI kota/yetkilendirme motoru) henüz koda girmemişti. YF-711, o commit'ten SONRA `main`'e eklendi (bkz. commit `01b12c4` ve takip düzeltmeleri `8c84ae1`/`3248c2c`). Bu revizyon, kaynak kodu yeniden doğrulayarak (`lib/entitlements/*`, `server/services/ai-usage-reporting-service.ts`, `prisma/schema.prisma`, `prisma/migrations/20260808210000_yf802_plan_entitlements`) §2.1/§2.2/§5/§6/§7'yi günceller ve yeni bir §8 (yükseltme/düşürme davranışı ve YF-804/YF-805/YF-807 bağımlılıkları) ekler. Karar matrisinin kendisi (§1, §3, §4) DEĞİŞMEMİŞTİR — yalnızca "bugün koddaki gerçek durum" açıklamaları güncellenmiştir.

## 1. Plan katmanları ve nicel limitler (ClickUp karar matrisi)

| Plan | `users.active` | `projects.active` | AI aylık kota (`ai.monthly_quota`) |
|---|---|---|---|
| Starter | 3 | 5 | 0 (AI yok) |
| Professional | 10 | 25 | Dahil kredi (kota > 0, değer bu dokümanın kapsamı dışında — satış/paket kararı) |
| Business | 30 | 100 | Professional'dan daha yüksek kota |
| Enterprise | Yapılandırılabilir (limit yok / özel anlaşma) | Yapılandırılabilir (limit yok / özel anlaşma) | Özel/yapılandırılabilir kota |

`users.active` ve `projects.active` tanımları `lib/entitlements/capabilities.ts` ile birebir aynıdır: sırasıyla organizasyondaki `status=ACTIVE` kullanıcı sayısı ve `status != CANCELLED` proje sayısı.

## 2. Entitlement kimlik sözlüğü

Aşağıdaki kimlikler kararlıdır; yeniden adlandırılamaz (mevcut `Plan.capabilities`/`Plan.limits` JSON anahtarları). "Durum" sütunu bu kimliğin bugün koddaki gerçek karşılığını gösterir.

### 2.1 Yetenek (capability) kimlikleri — `CAPABILITY_IDS` (lib/entitlements/capabilities.ts)

| Kimlik | Açıklama | Uygulama durumu (bugün) |
|---|---|---|
| `reports.advanced` | Gelişmiş rapor görünümleri (bütçe/nakit akışı vb.) | Tanımlı, hiçbir servis noktasında `assertCapability`/`canUseCapability` ile uygulanmıyor (yalnızca şema/lookup) |
| `export.xlsx` | Excel (XLSX) dışa aktarma | Tanımlı, uygulanmıyor |
| `export.pdf` | PDF dışa aktarma | Tanımlı, uygulanmıyor |
| `bank_import` | Banka ekstresi içe aktarım ve mutabakat (YF-602) | **Uygulanıyor** — `server/services/bank-import-service.ts` içinde `assertCapability(..., "bank_import")` |
| `ocr` | Belge/fiş OCR çıkarım (YF-601) | **Uygulanıyor** — `server/services/document-extraction-service.ts` içinde `assertCapability(..., "ocr")` |
| `e_document` | E-belge/muhasebe sağlayıcı entegrasyonları (YF-605) | Tanımlı, uygulanmıyor (YF-605-B/D sandbox adaptörleri capability kontrolünden bağımsız çalışıyor) |
| `ai.features` | Yapay zekâ destekli özellikler (genel şemsiye) | **Uygulanıyor (YF-711)** — `server/services/ai-usage-reporting-service.ts` içinde hem `requestAiCompletion`'ın erken kontrolünde hem de atomik `checkQuota` (Serializable tx) içinde `checkCapability(..., "ai.features")` çağrılır; izin yoksa `AI_PLAN_REQUIRED` reddi |
| `ai.insights` | AI Insights / finansal erken uyarı modülü (YF-702) | **Uygulanıyor (YF-702 sertleştirme)** — `ai.features` şemsiyesinin ALTINDA, ona EK bir özellik kapısı. İki noktada uygulanır: (1) `server/services/ai-insights-service.ts` `getAiInsights` başında, rapor sorgularından ÖNCE (böylece yetkisiz bir organizasyon "sinyal yok" yerine açık bir yetki hatası alır), (2) `requestAiCompletion`'ın yeni `featureCapability` parametresiyle hem erken hem de atomik `checkQuota` (Serializable tx) katmanında. İzin yoksa `AI_PLAN_REQUIRED`. Paylaşımlı `ai.monthly_quota` havuzu DEĞİŞMEZ — paralel bir abonelik/kota sistemi kurulmamıştır |

### 2.2 Nicel kota (limit) kimlikleri — `LIMIT_IDS` (lib/entitlements/capabilities.ts)

| Kimlik | Açıklama | Uygulama durumu (bugün) |
|---|---|---|
| `users.active` | Organizasyondaki aktif kullanıcı sayısı | `checkLimit`/`entitlement-service.ts` üzerinden hesaplanıyor |
| `projects.active` | Organizasyondaki arşivlenmemiş proje sayısı | `checkLimit`/`entitlement-service.ts` üzerinden hesaplanıyor |
| `ai.monthly_quota` | Aylık AI kullanım kotası | **Uygulanıyor (YF-711)** — `lib/entitlements/ai-quota-usage.ts` `getCurrentPeriodAiCreditsUsed` (COMMITTED + süresi dolmamış RESERVED toplamı), `resolveLimitMax`/`checkLimit` ile birleşerek atomik rezervasyon (`AiUsageLedger`, RESERVED→COMMITTED/FAILED) üzerinden gerçekten düşülüyor; aşımda `AI_QUOTA_EXCEEDED` |
| `ocr.monthly_quota` | Aylık OCR/belge çıkarım kotası | **Uygulanıyor (YF-817)** — `lib/entitlements/ocr-quota-usage.ts` `getCurrentPeriodOcrExtractionsUsed` (geçerli UTC takvim ayında PENDING dışı `DocumentExtraction` sayısı, ayrı bir kullanım defteri YOK), `assertWithinLimitAtomic` ile `server/services/document-extraction-service.ts` `uploadAndExtractDocument` içinde satır oluşturulmadan/sağlayıcı çağrılmadan ÖNCE, aynı transaction/organizasyon kilidi altında uygulanıyor; PROFESSIONAL/BUSINESS SAYISAL değerleri (50/200) geçici seed placeholder'ıdır (bkz. docs/product/YF-807-plan-unit-economics.md §9 — gerçek ticari değer henüz çözümlenmemiştir) |

### 2.3 Yol haritası kimlikleri (henüz `CAPABILITY_IDS`/`LIMIT_IDS` içinde YOK)

Bu kimlikler bu görevin ürün kararı gereği matriste yer alır; `lib/entitlements/capabilities.ts` içine eklenmeleri ayrı bir mühendislik görevidir (bu dokümanın kapsamı değildir, kod değiştirilmedi):

| Önerilen kimlik | Açıklama |
|---|---|
| `budget.variance_advanced` | Gelişmiş bütçe/varyans analizi |
| `cost_to_complete` | Tamamlanma maliyeti tahmini |
| `cash_flow.advanced` | Gelişmiş nakit akışı projeksiyonu |
| `progress_payments` | Hakediş/ara ödeme takibi |
| `progress_payments.advanced` | Gelişmiş hakediş (metraj/kademeli onay) |
| `procurement` | Satın alma modülü |
| `inventory` | Stok/depo/malzeme takibi |
| `api.access` | Genel API erişimi |
| `multi_company` | Çoklu şirket/organizasyon yönetimi |
| `roles.advanced_audit` | Gelişmiş roller ve audit erişimi |
| `ai.cash_flow_scenario` | AI Nakit Akışı Senaryosu |
| `ai.budget_copilot` | AI Bütçe Copilot |
| `ai.collection_assistant` | AI Tahsilat Asistanı |
| `ai.anomaly_detection.advanced` | Gelişmiş anomali tespiti |
| `ai.ask_yapifin` | Ask YapiFin (Professional) |
| `ai.management_summary` | AI Yönetim Özeti (Professional) |
| `org.advanced` | Gelişmiş organizasyon yönetimi (Enterprise) |
| `sso` | Tek oturum açma (SSO) |
| `api.custom_integrations` | Özel API/entegrasyonlar (Enterprise) |
| `sla` | SLA taahhüdü |
| `onboarding.dedicated` | Özel onboarding/migrasyon |
| `deployment.dedicated` | Opsiyonel özel (dedicated) dağıtım |

## 3. Plan × Özellik karar tablosu

Durumlar: **Included** (dahil), **Not included** (dahil değil), **Quota** (miktar/kotayla sınırlı), **Configurable** (Enterprise'da anlaşmayla belirlenir).

### 3.1 Çekirdek MVP (bugün büyük ölçüde uygulanmış; bkz. §5 uygulama durumu notları)

| Özellik / entitlement kimliği | Starter | Professional | Business | Enterprise |
|---|---|---|---|---|
| Proje/müşteri/tedarikçi-taşeron yönetimi | Included | Included | Included | Configurable |
| Gelir/gider yönetimi | Included | Included | Included | Configurable |
| Kasa/banka hesapları | Included | Included | Included | Configurable |
| Tahsilat/ödeme (parçalı ödeme dahil) | Included | Included | Included | Configurable |
| Temel kârlılık/bütçe/nakit görünümü | Included | Included | Included | Configurable |
| `export.xlsx` | Included | Included | Included | Included |
| `export.pdf` | Included | Included | Included | Included |
| `ai.features` (genel) | Not included | Included | Included | Included |

### 3.2 Professional ve üstü eklemeleri

| Özellik / entitlement kimliği | Starter | Professional | Business | Enterprise |
|---|---|---|---|---|
| `reports.advanced` | Not included | Included | Included | Included |
| `budget.variance_advanced` | Not included | Included | Included | Included |
| `cost_to_complete` | Not included | Included | Included | Included |
| `cash_flow.advanced` | Not included | Included | Included | Included |
| `bank_import` | Not included | Included | Included | Included |
| `progress_payments` | Not included | Included | Included | Included |
| `ocr` | Not included | Quota | Quota | Quota (Configurable üst limit) |
| `ai.insights` | Not included | Included | Included | Included |
| `ai.ask_yapifin` | Not included | Included | Included | Included |
| `ai.management_summary` | Not included | Included | Included | Included |
| `ai.monthly_quota` | 0 | Quota (dahil kredi) | Quota (Professional'dan yüksek) | Configurable |

### 3.3 Business ve üstü eklemeleri

| Özellik / entitlement kimliği | Starter | Professional | Business | Enterprise |
|---|---|---|---|---|
| `procurement` | Not included | Not included | Included | Included |
| `inventory` | Not included | Not included | Included | Included |
| `progress_payments.advanced` | Not included | Not included | Included | Included |
| `e_document` | Not included | Not included | Included | Included |
| `api.access` | Not included | Not included | Included | Included |
| `multi_company` | Not included | Not included | Included | Included |
| `roles.advanced_audit` | Not included | Not included | Included | Included |
| `ai.cash_flow_scenario` | Not included | Not included | Included | Included |
| `ai.budget_copilot` | Not included | Not included | Included | Included |
| `ai.collection_assistant` | Not included | Not included | Included | Included |
| `ai.anomaly_detection.advanced` | Not included | Not included | Included | Included |

### 3.4 Enterprise özel eklemeleri

| Özellik / entitlement kimliği | Starter | Professional | Business | Enterprise |
|---|---|---|---|---|
| `org.advanced` | Not included | Not included | Not included | Included |
| `sso` | Not included | Not included | Not included | Included |
| `api.custom_integrations` | Not included | Not included | Not included | Included |
| `sla` | Not included | Not included | Not included | Included |
| `onboarding.dedicated` | Not included | Not included | Not included | Included |
| `deployment.dedicated` | Not included | Not included | Not included | Configurable (opsiyonel) |
| `users.active` / `projects.active` / `ai.monthly_quota` üst sınırları | Sabit (3 / 5 / 0) | Sabit (10 / 25 / kota) | Sabit (30 / 100 / kota) | Configurable (limitsiz veya anlaşmalı) |

## 4. Evrensel güvenceler (paywall'a tabi DEĞİL — tüm planlarda zorunlu)

Aşağıdakiler hiçbir planda kısıtlanamaz, düşürülemez veya "quota"ya bağlanamaz; ürün genelinde geçerli mimari zorunluluklardır (proje CLAUDE.md "Mimari ilkeler" ile birebir uyumludur):

- **Tenant izolasyonu**: Tüm veri erişimi `organizationId` ile scope edilir; bir organizasyon başka bir organizasyonun verisine hiçbir planda erişemez.
- **Yetkilendirme**: Rol ve proje bazlı yetki kontrolleri sunucu tarafında zorunludur (frontend kontrolü tek başına yeterli değildir); plan seviyesi rol/yetki modelini gevşetemez.
- **Audit log bütünlüğü**: Kritik finansal ve yönetimsel değişiklikler audit log üretir; bu davranış plan bağımsızdır.
- **Finansal doğruluk**: Para tutarlarında floating point kullanılmaz (Decimal/Numeric veya kuruş bazlı integer); parçalı tahsilat/ödeme, ters kayıt ve bakiye tutarlılığı tüm planlarda aynı kurallarla çalışır.
- **Veri dışa aktarma sahipliği**: Bir organizasyon kendi verisini (asgari olarak dahil olduğu export formatlarıyla) her zaman dışa aktarabilir; bu, veri kilitlenmesini (vendor/plan lock-in) önler.
- **Yedekleme/kurtarma doğruluğu**: Yedekleme ve kurtarma süreçlerinin doğruluğu plan bazlı bir özellik değil, tüm organizasyonlar için geçerli bir işletim garantisidir.
- **Erişilebilirlik**: Arayüz erişilebilirlik standartları (okunabilir kontrast, klavye erişimi, form etiketleri vb.) plan farkı gözetmeksizin tüm katmanlarda uygulanır.

## 5. Uygulama-hizalama farkları (implementation-alignment gaps)

Kod bu görev kapsamında değiştirilmedi. Aşağıdaki farklar `lib/entitlements/plan-defaults.ts` ve `lib/entitlements/capabilities.ts` içindeki **bugünkü** durum ile bu kararlı matris arasındaki sapmalardır; YF-802 (veya takip görevi) tarafından kapatılmalıdır.

| # | Alan | Bugünkü çalışma zamanı değeri | Bu matristeki karar | Not |
|---|---|---|---|---|
| 1 | Starter `projects.active` | 3 | 5 | `DEFAULT_PLANS[0].limits["projects.active"]` güncellenmeli |
| 2 | Professional `users.active` | 15 | 10 | `DEFAULT_PLANS[1].limits["users.active"]` güncellenmeli |
| 3 | Business planı | **Yok** — yalnızca STARTER/PROFESSIONAL/ENTERPRISE tanımlı | Ayrı bir `BUSINESS` plan kaydı gerekli | `DEFAULT_PLANS` dizisine yeni giriş + ilgili migration/seed |
| 4 | Professional `ai.features` / `ai.monthly_quota` | `ai.features: false`, `ai.monthly_quota: 0` (YF-711 sonrası da DEĞİŞMEDİ — bkz. `prisma/migrations/20260808210000_yf802_plan_entitlements/migration.sql` INSERT satırı) | `ai.features: true`, `ai.monthly_quota` dahil kredi ile > 0 | YF-711 ile tüketim/rezervasyon MOTORU tamamlandı (bkz. §2.1/§2.2) — artık bu satırı kapatmak SALT BİR SEED/VERİ DEĞİŞİKLİĞİDİR, ek altyapı gerekmez: `DEFAULT_PLANS[1]` (`plan-defaults.ts`) ve karşılık gelen `Plan` satırı (yeni bir migration ile) güncellenmeli. AI Insights/Ask YapiFin/AI Management Summary gibi somut ürün özellikleri ayrıca yazılmalı (bkz. §7 sıra 3) |
| 5 | Professional `ocr` | ~~`true` (sınırsız gibi davranıyor — `ocr` kotası ayrı bir `LIMIT_IDS` girdisi olarak modellenmemiş)~~ **Kapatıldı (YF-817)**: `ocr.monthly_quota` eklendi ve uygulanıyor (bkz. §2.2) | Quota (miktar sınırlı) | `ocr.monthly_quota` limit kimliği + `entitlement-service.ts` `countUsage` case'i + `uploadAndExtractDocument` içinde `assertWithinLimitAtomic` uygulaması tamamlandı. SAYISAL değerler (Professional: 50, Business: 200) hâlâ geçici placeholder'dır — gerçek ticari değer YF-807 §9'un açıkça bıraktığı ayrı bir fiyatlandırma kararıdır |
| 6 | `e_document` (Professional) | `true` | Karara bağlandı: Business (Not included @ Professional) | Ürün kararı kesindir (bu görev kapsamında karara bağlanmıştır, açık madde değildir): e-belge/muhasebe entegrasyon **erişimi** Business katmanına aittir. Koddaki bugünkü `PROFESSIONAL.capabilities.e_document = true` değeri yalnızca bir implementation-alignment gap'tir; YF-802 takibi bunu `false` yapmalı ve `BUSINESS` planında `true` olarak taşımalıdır |
| 7 | Enterprise limitleri | `null` (kod genelinde sınırsız) | Configurable (limitsiz VEYA anlaşmalı sabit değer) | `null` bugün "limitsiz" anlamına geliyor; "anlaşmalı sabit değer" senaryosu için ayrı bir yapılandırma alanı yok |
| 8 | `reports.advanced`, `export.xlsx`, `export.pdf`, `e_document` | Tanımlı ama hiçbir servis çağrı noktasında `assertCapability`/`canUseCapability` ile uygulanmıyor (bugün yalnızca `ocr`, `bank_import` VE — YF-711 sonrası — `ai.features` uygulanıyor; bkz. §2.1) | Tüm plan-kısıtlı capability'lerin ilgili servis/route noktasında uygulanması beklenir | Bu, matrisin "Included/Not included" durumlarının bu dört kimlik için bugün fiilen zorlanmadığı, yalnızca veri modelinde tutulduğu anlamına gelir |
| 9 | Yol haritası kimlikleri (§2.3) | `CAPABILITY_IDS`/`LIMIT_IDS` içinde tanımlı değil | Plan matrisinde referans veriliyor | Bu kimlikler ilgili özellik geliştirildiğinde `lib/entitlements/capabilities.ts` içine eklenmelidir; önceden eklenmemeleri kasıtlıdır (kullanılmayan kimlik = ölü kod riski) |

## 6. Yol haritası mı, uygulanmış mı — açık ayrım

Bu matriste yer alan ve **bugün üretimde çalışmayan** her şey açıkça burada listelenir; §3 tablolarındaki "Included" işareti bir ürün/paket kararını belirtir, bir çalışan özelliği garanti etmez. Şu anda gerçekten uygulanmış olanlar:

- Çekirdek proje/müşteri/tedarikçi-taşeron, gelir/gider, kasa-banka, tahsilat/ödeme, temel bütçe/kârlılık akışları (`docs/PRODUCT_REQUIREMENTS.md` §5 ile uyumlu).
- `bank_import`, `ocr` ve `ai.features` capability zorlaması (`assertCapability`/`checkCapability`).
- `users.active` ve `projects.active` limit kontrolü (`checkLimit`).
- **AI kota/yetkilendirme motoru (YF-711)**: `ai.monthly_quota` gerçekten düşülüyor — atomik rezervasyon (RESERVED) → kesinleşme (COMMITTED) veya başarısızlıkta serbest bırakma (FAILED), Serializable izolasyon altında organizasyon satırı kilidiyle eşzamanlılığa karşı korumalı (`lockOrganizationForEntitlement`), idempotency-key ile çift ücretlendirme engeli, bayat rezervasyonların geri kazanımı (recycle), `AI_PLAN_REQUIRED`/`AI_QUOTA_EXCEEDED` reddetme kapıları. **Önemli nüans**: bu yalnızca genel `ai.features` şemsiyesini ve kota muhasebesini uygular — AI Insights/Ask YapiFin/AI Management Summary gibi SOMUT AI özelliklerinin kendi iş mantığı henüz yazılmadı (aşağıya bakınız).
- E-belge/muhasebe sandbox adaptörü (Nilvera, salt-okunur/sandbox aşaması — YF-605-D).

Aşağıdakiler **yol haritasıdır, bugün uygulanmamıştır** (`docs/PRODUCT_REQUIREMENTS.md` §7 "MVP dışı" ile uyumlu, ayrıca YF-605/YF-701 ile başlayan altyapı dışında iş mantığı henüz yok):

- Gelişmiş bütçe/varyans, tamamlanma maliyeti, gelişmiş nakit akışı projeksiyonu.
- Hakediş/ara ödeme (temel ve gelişmiş).
- Satın alma, stok/malzeme yönetimi.
- API erişimi, çoklu şirket, gelişmiş roller/audit arayüzü.
- Tüm AI Insights / Ask YapiFin / AI Management Summary / AI Cash Flow Scenario / AI Budget Copilot / AI Collection Assistant / gelişmiş anomali tespiti özellikleri (sağlayıcı-nötr temel altyapı YF-701 İLE ve genel yetkilendirme/kota motoru YF-711 İLE mevcut; ancak bu özelliklerin kendi uçtan uca iş mantığı/istemleri/UI'ı henüz yok — YF-711 yalnızca "AI kullanılabilir mi ve kota var mı" sorusunu cevaplar, HANGİ AI özelliğinin ne ürettiğini değil).
- SSO, özel API/entegrasyon, SLA, özel onboarding/migrasyon, opsiyonel dedicated deployment.
- ~~OCR kota (miktar) uygulaması~~ **Kapatıldı (YF-817)** — bkz. §2.2/§5 madde 5; SAYISAL değerler hâlâ geçici placeholder (bkz. YF-807 §9).

## 7. Takip görev sırası ve sahiplik sınırları

| Sıra | Görev | Durum | Kapsam | Bu matrisle ilişki |
|---|---|---|---|---|
| 1 | YF-802 (entitlement altyapısı) | **Tamamlandı** (`lib/entitlements/*`, `Plan` tablosu canlı) | `lib/entitlements/*`, `Plan` tablosu, `checkLimit`/`assertCapability` | Altyapıyı kurdu; ancak §5 madde 1, 2, 3, 4, 5, 8'deki KARAR/VERİ farkları hâlâ açık (altyapı ≠ seed verisi/kapsama genişletme — aşağıya bakınız) |
| 2 | YF-711 (AI plan yetkilendirmesi ve kullanım/faturalama altyapısı) | **Tamamlandı** (bkz. §2.1/§2.2/§6 — `checkQuota`/`reportUsage`, atomik rezervasyon, `AI_PLAN_REQUIRED`/`AI_QUOTA_EXCEEDED`) | AI plan entitlement kontrolü, tenant-scoped aylık AI kredi/kota hesabı, atomik kullanım defteri (usage ledger) ve rezervasyon, sağlayıcı/model bazlı token ve maliyet kaydı, idempotent ücretlendirme, deterministik faturalama dönemleri | §3.2'deki `ai.monthly_quota` Quota durumunu fiilen tüketilebilir hale getiren motoru kurdu. AI Insights/Ask YapiFin/AI Management Summary gibi somut AI **özelliklerinin** kendi iş mantığı bu görevin kapsamında DEĞİLDİ (bkz. sıra 4) |
| 3 | Seed/veri düzeltmesi — Starter/Professional limit değerleri + Professional `ai.features`/`ai.monthly_quota` + `BUSINESS` planı ekleme | **Açık** (bu YF-801 revizyonunda tespit edildi, kod değiştirilmedi) | `lib/entitlements/plan-defaults.ts` (`DEFAULT_PLANS`) + yeni bir Prisma migration (`Plan` INSERT/UPDATE) | §5 madde 1, 2, 3, 4'ü kapatır. Küçük, düşük riskli, saf veri değişikliği — YF-802/YF-711'in kod/altyapısına DOKUNMAZ. `BUSINESS` eklenmesi dört-katman modelini (bu görevin hedefi) koda yansıtan TEK zorunlu adımdır |
| 4 | Eksik capability zorlamalarını ilgili servis noktalarına bağlama (`reports.advanced`, `export.xlsx`, `export.pdf`, `e_document`) | **Açık** | İlgili rapor/export/e-belge servis fonksiyonlarına `assertCapability` çağrısı eklemek (bkz. `bank_import`/`ocr`/`ai.features` örüntüsü) | §5 madde 8'i kapatır |
| 5 | Sonraki AI özellik görevleri (AI Insights, Ask YapiFin, AI Management Summary → Professional; AI Cash Flow Scenario, AI Budget Copilot, AI Collection Assistant, gelişmiş anomali tespiti → Business) | **Açık** (yol haritası) | `lib/ai/*` (YF-701 sağlayıcı-nötr temel + YF-711 kota motoru üzerine), yeni capability kimlikleri (§2.3) | §3.2/§3.3 AI satırlarını fiilen uygular; sıra 2 (YF-711) tamamlandığı için kota düşüm mantığı ZATEN mevcut — bu sıra yalnızca her AI özelliğinin kendi istem/çıktı mantığını ekler |
| 6 | Satın alma/stok/malzeme (Business) | **Açık** (yol haritası) | Yeni Prisma modelleri + servisler + `procurement`/`inventory` capability | §3.3'ü uygular; MVP finans çekirdeğinden sonra ele alınmalı (CLAUDE.md madde 10 ile uyumlu) |
| 7 | E-belge/muhasebe tam entegrasyon genişletmesi | **Açık** (yol haritası) | YF-605 serisinin devamı (sandbox ötesi canlı entegrasyon) | Plan yerleşimi karara bağlandı (§5 madde 6: Business); yalnızca sıra 3/4'ün `e_document`'ı Business'a taşımasını beklemesi gerekir |
| 8 | Enterprise yapılandırma katmanı (SSO, özel SLA, dedicated deployment) | **Açık** (yol haritası) | Yeni yapılandırma/anlaşma modeli, mevcut `null`-limit yaklaşımının ötesinde | §5 madde 7'yi kapatır; ayrı bir görev olarak ele alınmalı, YF-802 kapsamına dahil edilmemeli |
| 9 | YF-804 (yükseltme/düşürme akışı) | **Bloklanmış değil, ön koşullu** — bkz. §8 | Organizasyonun `planId`'sini değiştiren bir servis/route (bugün YOK — yalnızca kayıt anında tek seferlik atama var), yükseltme/düşürme UI'ı | §8'i uygular; sıra 3'teki `BUSINESS` planı DB'de mevcut olmadan dört-katmanlı bir yükseltme akışı sunulamaz |
| 10 | YF-805 (muhtemel: fiyatlandırma/checkout/faturalama sağlayıcı entegrasyonu) | **Açık** — bu görevin kapsamı dışında, kod tabanında henüz hiçbir iz yok | Ödeme sağlayıcı entegrasyonu, fatura/checkout akışı | §8'deki "plan değişikliğini kim tetikler" sorusunun gerçek dünya cevabıdır; YF-804'ün planId-değiştirme servisini bir ödeme olayına bağlar |
| 11 | YF-807 (muhtemel: kullanım/kota görünürlüğü ve uyarı arayüzü) | **Açık** — `getOrganizationLimitSummary`/`GET /api/ai/usage` altyapısı zaten mevcut (bkz. §6), yalnızca kullanıcıya dönük arayüz/uyarı eksik | Kullanıcı arayüzünde limit/kota özeti, aşım/yaklaşma uyarıları | §8'deki "kullanıcı kotasının doluğunu nasıl görür" sorusunu kapatır; backend zaten hazır olduğu için bu görev SALT arayüzdür |

Sahiplik sınırı: Entitlement **altyapısı** (kimlik listesi, limit/capability kontrol mekanizması, Plan veri modeli, AI kota motoru) YF-802/YF-711 kapsamındadır ve TAMAMLANMIŞTIR. Her **özelliğin kendi iş mantığı** (hakediş hesaplama, AI çıktı üretimi, satın alma onay akışı vb.) ilgili özellik görevinin kapsamındadır ve YF-802/YF-711'in genişletilmesi olarak yapılmamalıdır.

## 8. Yükseltme/Düşürme (Upgrade/Downgrade) davranışı — YF-804/YF-805/YF-807 bağımlılıkları

Bu bölüm billing/checkout UYGULAMAZ (kapsam dışı — bkz. görev talimatı); yalnızca bugün koddaki gerçek çalışma zamanı davranışını belgeler ve YF-804'ün üzerine inşa etmesi gereken zemini netleştirir.

### 8.1 Bugün ne var, ne yok

- **Plan değişikliği için hiçbir servis/route YOK.** `server/services/organization-service.ts` yalnızca yeni bir organizasyon oluşturulurken `planId`'yi bir kez atar (bkz. `DEFAULT_ORGANIZATION_PLAN_CODE`); mevcut bir organizasyonun planını değiştiren (`OWNER`/admin eylemiyle veya bir ödeme olayıyla tetiklenen) hiçbir fonksiyon yoktur. **YF-804'ün ilk ve zorunlu adımı budur** — repo genelinde arama teyit eder: `planId` yalnızca oluşturma anında ve YF-802 backfill migration'ında yazılıyor.
- **Plan okuma her zaman taze ve önbelleksiz.** `getEffectivePlan` (`lib/entitlements/entitlement-service.ts:67`) her çağrıda doğrudan DB'den okur — "hiçbir yerde önbelleğe alınmaz (plan değişikliği anında yansımalıdır)" (kod içi yorum). Bu, YF-804 `planId`'yi güncellediği anda TÜM sonraki `checkCapability`/`checkLimit`/AI kota kontrollerinin YENİ planı kullanacağı anlamına gelir — ayrı bir cache invalidation adımı gerekmez.

### 8.2 Yükseltme (upgrade) davranışı

Anlık ve sorunsuzdur: `planId` güncellenir güncellenmez daha geniş `capabilities`/`limits` bir sonraki istekte devreye girer. Geriye dönük hiçbir düzeltme gerekmez (ör. önceden `bank_import` kapalıyken oluşturulmuş hiçbir kayıt yoktur, çünkü capability zaten oluşturmayı engellemiştir).

### 8.3 Düşürme (downgrade) davranışı — kritik nüans

- **Nicel limitler (`users.active`, `projects.active`) geriye dönük ZORLANMAZ.** `checkLimit` (`entitlement-service.ts:213`) `isOverLimit: max !== null && used > max` alanını döner ama hiçbir çağıran kod mevcut kullanıcı/projeyi otomatik pasifleştirmez/arşivlemez. Downgrade sonrası mevcut kullanım yeni limitin üzerindeyse: (a) organizasyon "grandfathered" kalır — mevcut kayıtlar durur, (b) yalnızca YENİ bir kayıt eklenmesi engellenir (`canAddOne: false`). YF-804/YF-807 bu durumu kullanıcıya açıkça göstermelidir (`isOverLimit` alanı bu amaçla zaten mevcuttur), aksi halde sessiz bir "neden ekleyemiyorum" şaşkınlığı yaratır.
- **`ai.monthly_quota` her takvim dönemi başında doğal olarak sıfırlanır** (bkz. `lib/ai/quota-period.ts` `getAiQuotaPeriodStart` — deterministik UTC takvim ayı; `getCurrentPeriodAiCreditsUsed` yalnızca CARİ dönemi toplar). Bu yüzden bir AI kota düşürmesinin etkisi mevcut dönem içinde ANINDA (kalan kredi azalır/tükenirse yeni rezervasyonlar reddedilir), yeni dönemde ise yeni (düşük) tavanla başlar — ayrı bir "dönem sıfırlama" mantığına gerek yoktur.
- **`ocr.monthly_quota` (YF-817) AYNI `lib/ai/quota-period.ts` UTC takvim ayı dönemini reuse eder** (bkz. `lib/entitlements/ocr-quota-usage.ts` `getCurrentPeriodOcrExtractionsUsed`) — AYNI "doğal sıfırlama" davranışı geçerlidir, ayrı bir dönem/sıfırlama mantığı yoktur.
- **`ai.features` kapatılırsa** mevcut RESERVED bir rezervasyon varsa bile bir sonraki `checkQuota` çağrısı (Serializable tx içinde, her seferinde taze okunur) `AI_PLAN_REQUIRED` ile reddeder — yarım kalmış bir rezervasyon sonsuza kadar askıda kalmaz, TTL (`reservationTtlMs`, 5 dakika) sonunda bayat sayılır ve kota toplamından düşer.
- **Capability kapatma (`bank_import`, `ocr`, `ai.features`) geçmiş kayıtları SİLMEZ/gizlemez** — yalnızca YENİ işlem oluşturmayı engeller (`assertCapability` her zaman bir "create/import" akışının başında çağrılır, listeleme/görüntüleme uç noktalarında değil). Bu, CLAUDE.md'nin "finansal kayıtlar varsayılan olarak hard delete edilmez" ilkesiyle tutarlıdır.

### 8.4 YF-804/YF-805/YF-807 için açık bağımlılık listesi

| Görev | Bu görevden (YF-801) ne bekliyor | Kod tabanında bugün ne hazır | Kod tabanında bugün ne EKSİK |
|---|---|---|---|
| YF-804 (yükseltme/düşürme akışı) | §1/§3 karar matrisi + §7 sıra 3'teki `BUSINESS` planının DB'de var olması | `getEffectivePlan`'in önbelleksiz/anlık yansıma garantisi, `isOverLimit` sinyali, capability/limit kontrol mekanizması | `planId` değiştiren bir servis fonksiyonu + rol/yetki kontrolü (kim değiştirebilir) + audit log kaydı (CLAUDE.md "kritik değişiklikler audit log üretmelidir" ile uyumlu olmalı — `server/services/organization-service.ts` zaten diğer organizasyon güncellemelerinde `writeAuditLog` kullanıyor, aynı örüntü izlenmeli) |
| YF-805 (fiyatlandırma/checkout/faturalama, varsayım) | Plan kimlikleri (`STARTER`/`PROFESSIONAL`/`BUSINESS`/`ENTERPRISE`) ve bunların `Plan.code` ile birebir eşleşmesi | `Plan` tablosu `code` alanıyla stabil, yeniden adlandırılmaz kimlikler taşıyor | Herhangi bir ödeme/checkout entegrasyonu YOK — bu görev sıfırdan başlıyor, YF-804'ün `planId`-değiştirme servisini bir "ödeme başarılı" olayına bağlaması gerekecek |
| YF-807 (kullanım/kota görünürlüğü, varsayım) | §2.2 limit kimlik sözlüğü + §8.3 downgrade/grandfathering davranışı | `getOrganizationLimitSummary` (tüm limitlerin özeti) ve `GET /api/ai/usage` (`app/api/ai/usage/route.ts`) zaten backend'de mevcut | Bu verileri gösteren kullanıcı arayüzü (kart/uyarı bileşeni) yok; `isOverLimit`/kota-yaklaşma eşiği için bir UYARI eşiği (ör. "%80 doldu") tanımlı değil |
