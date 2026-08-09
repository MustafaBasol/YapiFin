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
| `ai.features` | Yapay zekâ destekli özellikler (genel şemsiye) | Tanımlı, uygulanmıyor |

### 2.2 Nicel kota (limit) kimlikleri — `LIMIT_IDS` (lib/entitlements/capabilities.ts)

| Kimlik | Açıklama | Uygulama durumu (bugün) |
|---|---|---|
| `users.active` | Organizasyondaki aktif kullanıcı sayısı | `checkLimit`/`entitlement-service.ts` üzerinden hesaplanıyor |
| `projects.active` | Organizasyondaki arşivlenmemiş proje sayısı | `checkLimit`/`entitlement-service.ts` üzerinden hesaplanıyor |
| `ai.monthly_quota` | Aylık AI kullanım kotası | Şema/lookup hazır, hiçbir yerde tüketilmiyor (kota düşümü yok) |

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
| `ai.insights` | AI Insights (Professional) |
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
| 4 | Professional `ai.features` / `ai.monthly_quota` | `ai.features: false`, `ai.monthly_quota: 0` | `ai.features: true`, `ai.monthly_quota` dahil kredi ile > 0 | AI Insights/Ask YapiFin/AI Management Summary Professional'a dahil olmalı |
| 5 | Professional `ocr` | `true` (sınırsız gibi davranıyor — `ocr` kotası ayrı bir `LIMIT_IDS` girdisi olarak modellenmemiş) | Quota (miktar sınırlı) | Yeni bir `ocr.monthly_quota` benzeri limit kimliği ve entitlement-service hesaplayıcısı gerekir |
| 6 | `e_document` (Professional) | `true` | Karara bağlandı: Business (Not included @ Professional) | Ürün kararı kesindir (bu görev kapsamında karara bağlanmıştır, açık madde değildir): e-belge/muhasebe entegrasyon **erişimi** Business katmanına aittir. Koddaki bugünkü `PROFESSIONAL.capabilities.e_document = true` değeri yalnızca bir implementation-alignment gap'tir; YF-802 takibi bunu `false` yapmalı ve `BUSINESS` planında `true` olarak taşımalıdır |
| 7 | Enterprise limitleri | `null` (kod genelinde sınırsız) | Configurable (limitsiz VEYA anlaşmalı sabit değer) | `null` bugün "limitsiz" anlamına geliyor; "anlaşmalı sabit değer" senaryosu için ayrı bir yapılandırma alanı yok |
| 8 | `reports.advanced`, `export.xlsx`, `export.pdf`, `e_document`, `ai.features` | Tanımlı ama hiçbir servis çağrı noktasında `assertCapability`/`canUseCapability` ile uygulanmıyor (yalnızca `ocr` ve `bank_import` uygulanıyor) | Tüm plan-kısıtlı capability'lerin ilgili servis/route noktasında uygulanması beklenir | Bu, matrisin "Included/Not included" durumlarının bugün fiilen zorlanmadığı, yalnızca veri modelinde tutulduğu anlamına gelir |
| 9 | Yol haritası kimlikleri (§2.3) | `CAPABILITY_IDS`/`LIMIT_IDS` içinde tanımlı değil | Plan matrisinde referans veriliyor | Bu kimlikler ilgili özellik geliştirildiğinde `lib/entitlements/capabilities.ts` içine eklenmelidir; önceden eklenmemeleri kasıtlıdır (kullanılmayan kimlik = ölü kod riski) |

## 6. Yol haritası mı, uygulanmış mı — açık ayrım

Bu matriste yer alan ve **bugün üretimde çalışmayan** her şey açıkça burada listelenir; §3 tablolarındaki "Included" işareti bir ürün/paket kararını belirtir, bir çalışan özelliği garanti etmez. Şu anda gerçekten uygulanmış olanlar:

- Çekirdek proje/müşteri/tedarikçi-taşeron, gelir/gider, kasa-banka, tahsilat/ödeme, temel bütçe/kârlılık akışları (`docs/PRODUCT_REQUIREMENTS.md` §5 ile uyumlu).
- `bank_import` ve `ocr` capability zorlaması (`assertCapability`).
- `users.active` ve `projects.active` limit kontrolü (`checkLimit`).
- E-belge/muhasebe sandbox adaptörü (Nilvera, salt-okunur/sandbox aşaması — YF-605-D).

Aşağıdakiler **yol haritasıdır, bugün uygulanmamıştır** (`docs/PRODUCT_REQUIREMENTS.md` §7 "MVP dışı" ile uyumlu, ayrıca YF-605/YF-701 ile başlayan altyapı dışında iş mantığı henüz yok):

- Gelişmiş bütçe/varyans, tamamlanma maliyeti, gelişmiş nakit akışı projeksiyonu.
- Hakediş/ara ödeme (temel ve gelişmiş).
- Satın alma, stok/malzeme yönetimi.
- API erişimi, çoklu şirket, gelişmiş roller/audit arayüzü.
- Tüm AI Insights / Ask YapiFin / AI Management Summary / AI Cash Flow Scenario / AI Budget Copilot / AI Collection Assistant / gelişmiş anomali tespiti özellikleri (yalnızca sağlayıcı-nötr temel altyapı YF-701 ile mevcut; uçtan uca özellik yok).
- SSO, özel API/entegrasyon, SLA, özel onboarding/migrasyon, opsiyonel dedicated deployment.
- OCR kota (miktar) uygulaması (bugün `ocr` yalnızca açık/kapalı; kota düşümü yok).

## 7. Takip görev sırası ve sahiplik sınırları

| Sıra | Görev | Kapsam | Bu matrisle ilişki |
|---|---|---|---|
| 1 | YF-802 (entitlement altyapısı — tamamlandı, iyileştirme gerekiyor) | `lib/entitlements/*`, `Plan` tablosu, `checkLimit`/`assertCapability` | §5 farklarından 1, 2, 3, 4, 5, 8 numaralı maddeleri kapatır: limit değerleri düzeltme, `BUSINESS` planı ekleme, eksik capability zorlamalarını ilgili servis noktalarına bağlama |
| 2 | YF-711 (AI plan yetkilendirmesi ve kullanım/faturalama altyapısı — raporlama, bütçe-varyans veya hakediş görevi DEĞİLDİR) | AI plan entitlement kontrolü (`ai.features`/`ai.monthly_quota`), tenant-scoped aylık AI kredi/kota hesabı, atomik kullanım defteri (usage ledger) ve rezervasyon, sağlayıcı/model bazlı token ve maliyet kaydı, idempotent ücretlendirme, deterministik faturalama dönemleri, kota uyarıları, `AI_PLAN_REQUIRED`/`AI_QUOTA_EXCEEDED` reddetme kapıları, plan düşürme/iptal davranışı, kullanım görünürlüğü, ileride kota üstü ek paket (top-up) desteği | §3.2'deki `ai.monthly_quota` Quota durumunu ve §5 madde 4'teki Professional `ai.features`/`ai.monthly_quota` farkını fiilen tüketilebilir hale getiren temel altyapıyı kurar; AI Insights/Ask YapiFin/AI Management Summary gibi somut AI **özelliklerinin** kendi iş mantığı bu görevin kapsamı değildir (bkz. sıra 3) |
| 3 | Sonraki AI özellik görevleri (AI Insights, Ask YapiFin, AI Management Summary → Professional; AI Cash Flow Scenario, AI Budget Copilot, AI Collection Assistant, gelişmiş anomali tespiti → Business) | `lib/ai/*` (YF-701 sağlayıcı-nötr temel üzerine), yeni capability kimlikleri, `ai.monthly_quota` tüketim mantığı | §3.2/§3.3 AI satırlarını fiilen uygular; kota düşüm mantığı olmadan hiçbir AI capability'si "Included" olarak pazarlanmamalı |
| 4 | Satın alma/stok/malzeme (Business) | Yeni Prisma modelleri + servisler + `procurement`/`inventory` capability | §3.3'ü uygular; MVP finans çekirdeğinden sonra ele alınmalı (CLAUDE.md madde 10 ile uyumlu) |
| 5 | E-belge/muhasebe tam entegrasyon genişletmesi | YF-605 serisinin devamı (sandbox ötesi canlı entegrasyon) | Plan yerleşimi karara bağlandı (§5 madde 6: Business); bu görev doğrudan başlayabilir, yalnızca YF-802'nin `e_document` capability'sini Business'a taşımasını (madde 6) beklemesi gerekir |
| 6 | Enterprise yapılandırma katmanı (SSO, özel SLA, dedicated deployment) | Yeni yapılandırma/anlaşma modeli, mevcut `null`-limit yaklaşımının ötesinde | §5 madde 7'yi kapatır; ayrı bir görev olarak ele alınmalı, YF-802 kapsamına dahil edilmemeli |

Sahiplik sınırı: Entitlement **altyapısı** (kimlik listesi, limit/capability kontrol mekanizması, Plan veri modeli) YF-802 kapsamındadır. Her **özelliğin kendi iş mantığı** (hakediş hesaplama, AI çıktı üretimi, satın alma onay akışı vb.) ilgili özellik görevinin kapsamındadır ve YF-802'nin genişletilmesi olarak yapılmamalıdır.
