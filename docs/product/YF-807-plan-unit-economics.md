# YF-807 — Plan Ekonomisi, Fiyatlandırma ve Birim Ekonomisi Doğrulaması

Bu doküman, YapiFin dört katmanlı plan yapısı (Starter/Professional/Business/Enterprise) için
**savunulabilir bir birim-ekonomisi ve fiyatlandırma çerçevesi** kurar. Kapsam yalnızca analiz ve
dokümantasyondur — hiçbir uygulama kodu, Prisma şeması veya migration bu görev kapsamında
değiştirilmemiştir (aşağıdaki tüm kod referansları salt-okunur incelemedir).

- **Yöntem:** `docs/PLAN_FEATURE_MATRIX.md` (kanonik plan kararı — YF-801), `lib/entitlements/plan-defaults.ts`
  (çalışma zamanı seed), `lib/ai/credits.ts` + `lib/entitlements/ai-quota-usage.ts` +
  `server/services/ai-usage-reporting-service.ts` (YF-711 AI kota motoru), OCR akışı
  (`server/services/document-extraction-service.ts`), entegrasyon sağlayıcı katmanı
  (`server/services/integrations/*`), `docker-compose.yml`, `package.json` ve `docs/PRODUCTION_READINESS.md`
  hedefli olarak incelendi. Geniş, tüm-repo taraması yapılmadı.
- **Kesin kural:** Bu doküman hiçbir gerçek sağlayıcı fiyatı UYDURMAZ. Repository'de bir maliyet
  sayısal olarak yoksa, o girdi sembolik bir sabit (`AI_COST_PER_CREDIT` gibi) ve bir kırılım-noktası
  (break-even) formülü olarak bırakılır.

---

## 1. Yönetici karar özeti

1. **Bugün hiçbir gerçek fiyat/faturalama entegrasyonu yok.** `docs/PLAN_FEATURE_MATRIX.md` §7 satır 10
   (YF-808) doğrular: ödeme sağlayıcı entegrasyonu sıfırdan başlayacak. Bu doküman bir **fiyat ilanı**
   değil, fiyat kilitlenmeden önce toplanması gereken maliyet girdilerinin ve karar noktalarının haritasıdır.
2. **AI ve OCR, tek gerçek "kullanım-değişken" maliyet kalemleridir.** Diğer tüm modüller (proje/gelir-gider/
   kasa-banka/tahsilat) sabit hesaplama yüküdür — tenant/kullanıcı sayısıyla ölçeklenir ama harici
   sağlayıcı faturası üretmez.
3. **AI kredi-maliyet dönüşümü (`usdPerCredit = 0.01`, `lib/ai/credits.ts:25`) kod içinde açıkça
   "gerçek bir sağlayıcı fiyatlandırması DEĞİLDİR" diye işaretli.** Bu, YF-807'nin en kritik bulgusudur:
   bugünkü Professional (500 kredi) ve Business (2000 kredi) aylık kota seed değerleri de aynı şekilde
   `plan-defaults.ts:17-23` yorumunda "geçici, düşük riskli başlangıç değeri… gerçek ticari değer bu
   görev (YF-807/YF-805) kapsamında netleştirilmeli" diye işaretlenmiş. **Yani plan kotalarının kendisi
   halen fiyatlama kararını bekliyor — bu doküman o kararın çerçevesini kurar, sayıyı DB'ye yazmaz.**
4. **OCR'de miktar bazlı kota hiç uygulanmamış** (yalnızca açık/kapalı `ocr` capability'si var — bkz. §9).
   Sayfa/belge bazlı bir üst sınır olmadan Professional/Business'ta OCR "sınırsız gibi" davranıyor; bu
   fiyatlandırma öncesi kapatılması gereken somut bir mühendislik boşluğudur.
5. **Enterprise için `null` limit = "sınırsız", "anlaşmalı sabit değer" değil** (`plan-defaults.ts:88-100`,
   `PLAN_FEATURE_MATRIX.md` §5 madde 7). Enterprise fiyatlaması bu yüzden zorunlu olarak özel teklif
   (custom quote) modelidir — bu doküman bir taban/guardrail çerçevesi önerir, sabit fiyat önermez.
6. **Support/onboarding maliyeti kod tabanında hiç modellenmemiş** — `sla`, `onboarding.dedicated`,
   `deployment.dedicated` yalnızca yol haritası kimlikleridir (§2.3 roadmap listesi, henüz
   `CAPABILITY_IDS` içinde değil). Bu tamamen bir iş varsayımı alanıdır (bkz. §5).

---

## 2. Bilinen kanonik plan yapısı (repository kaynağı)

Kaynak: `docs/PLAN_FEATURE_MATRIX.md` §1/§3 (kanonik karar) + `lib/entitlements/plan-defaults.ts`
(çalışma zamanı seed — YF-801-A ile hizalanmış, bkz. commit `d63aa0f`).

| Plan | `users.active` | `projects.active` | `ai.monthly_quota` | `ocr` | `bank_import` | `e_document` |
|---|---|---|---|---|---|---|
| **Starter** | 3 | 5 | 0 (AI yok) | Not included | Not included | Not included |
| **Professional** | 10 | 25 | Dahil kredi, **sayısal değer geçici seed = 500** | Quota (kanonik) / **bugün uygulanmamış açık-kapalı** | Included | Not included |
| **Business** | 30 | 100 | Professional'dan yüksek, **sayısal değer geçici seed = 2000** | Quota (kanonik) / **bugün uygulanmamış açık-kapalı** | Included | Included |
| **Enterprise** | Configurable (kod: `null` = sınırsız) | Configurable (kod: `null` = sınırsız) | Configurable (kod: `null` = sınırsız) | Quota (Configurable üst limit) | Included | Included |

Diğer plan-bağımlı yetenekler (`reports.advanced`, `budget.variance_advanced`, `progress_payments`,
`procurement`, `inventory`, `multi_company`, `api.access`, `sso`, …) ikili (dahil/dahil değil)
kimliklerdir ve **doğrudan bir birim maliyeti taşımazlar** — sabit geliştirme/bakım maliyeti dışında
kullanım başına harici fatura üretmezler; bu yüzden §3-§4'te "kullanım-değişken" değil "sabit" olarak
sınıflandırılırlar.

**Önemli nüans (fiyatlandırma öncesi kapatılması gereken 2 veri boşluğu):**

- Professional/Business AI kota sayıları (500/2000) `plan-defaults.ts:17-23` yorumunda açıkça geçici
  işaretli — YF-805/YF-807 bunları netleştirmeli.
- `ocr` bugün yalnızca ikili bir capability'dir, miktar kotası yok (§9) — Professional/Business arasında
  OCR kullanım maliyeti bugün **hiç farklılaşmıyor**, bu plan farklılaştırmasında bir tutarsızlıktır.

---

## 3. Maliyet sürücüsü envanteri

| Sürücü | Kaynak | Bugünkü durum |
|---|---|---|
| Tenant başına temel hesaplama | `docker-compose.yml`, tek `PrismaClient` (`lib/db.ts`) | Paylaşımlı Postgres + Next.js süreci; tenant başına izole altyapı yok |
| Kullanıcı başına oturum/işlem yükü | `lib/auth/session.ts`, `checkLimit("users.active")` | DB satırı + oturum kaydı; ölçek doğrusal ama küçük |
| Proje başına depolama/sorgu yükü | `checkLimit("projects.active")` | DB satırı + ilişkili işlem hacmi; ölçek doğrusal |
| Veritabanı/depolama | Postgres (`docker-compose.yml`), belge dosyaları **bytea olarak DB'de** (`document-extraction-service.ts:137`, `MAX_UPLOAD_SIZE_BYTES = 8MB`) | S3/nesne depolama **yapılandırılmamış** (`PRODUCTION_READINESS.md` §1: `S3_*` değişkenleri kodda hiç referans edilmiyor) — depolama maliyeti bugün tamamen Postgres disk/yedekleme maliyetine yansır |
| Compute | Next.js sunucu süreci (`next start`) | Bağlantı havuzlama parametresi yok (`PRODUCTION_READINESS.md` §5, R-10) — serverless/çoklu-instance ölçekte maliyet modeli değişir |
| Arka plan işleri | — | **Repository'de ayrı bir job/queue/worker sistemi bulunamadı** — OCR çıkarımı (`runExtraction`) ve AI tamamlama senkron çağrılardır, kalıcı bir kuyruk (BullMQ/Agenda/cron) yok |
| E-posta/bildirim | `lib/email/mailer.ts` (nodemailer, SMTP opsiyonel) | Sağlayıcı seçimi ortam değişkenine bağlı (`.env.example`), belirli bir vendor kod tabanında sabitlenmemiş |
| İzleme/loglama | `@sentry/node@^10.69.0` (`package.json:28`) | Sentry entegre (YF-512); plan seviyesine bakılmaksızın tüm tenant'lar için aynı altyapı |
| Rate limiting | `ioredis@^5.4.2` (`package.json:32`), `docker-compose.yml` `redis` servisi | Paylaşımlı Redis, dağıtık rate limiting (YF-509) — tenant başına izole değil |
| AI (LLM) kullanımı | `lib/ai/credits.ts`, `server/services/ai-usage-reporting-service.ts` | Sağlayıcı-nötr soyutlama (YF-701) + kota/rezervasyon motoru (YF-711); **gerçek sağlayıcı faturası kod tabanında yok** |
| OCR/belge işleme | `server/services/document-extraction-service.ts` | Capability-gated, **miktar kotası yok**, gerçek OCR sağlayıcı entegrasyonu yok (test/stub provider kullanılıyor) |
| E-belge/entegrasyon sağlayıcıları | `server/services/integrations/providers/nilvera-provider.ts` | Yalnızca **sandbox, salt-okunur** (mükellef/belge durumu sorgulama) — canlı belge gönderimi/faturalandırılabilir işlem YOK |
| Destek/onboarding | — | Kod tabanında hiç modellenmemiş; `sla`/`onboarding.dedicated`/`deployment.dedicated` yalnızca roadmap kimlikleri (§2.3) |

---

## 4. Maliyet sınıflandırması

| Sınıf | Kalemler | Not |
|---|---|---|
| **Sabit (platform)** | Sentry, Redis (rate limiting altyapısı), CI/CD, temel Next.js/Postgres barındırma tabanı, geliştirme/bakım | Tenant sayısından bağımsız taban maliyet; tenant sayısı arttıkça tenant başına düşen pay azalır (klasik SaaS sabit-maliyet amortismanı) |
| **Tenant-değişken** | Postgres depolama artışı, yedekleme hacmi, bağlantı havuzu baskısı | `organizationId` başına doğrusal değil ama kabaca orantılı; gerçek katsayı ölçülmemiş (bkz. §12 telemetri) |
| **Kullanıcı-değişken** | Oturum/kimlik doğrulama yükü, `users.active` limiti | Küçük, DB satırı + oturum token'ı düzeyinde; başlı başına anlamlı bir maliyet sürücüsü değil |
| **Kullanım-değişken (usage-variable)** | AI kredi tüketimi (`ai.monthly_quota`), OCR belge/sayfa işleme, e-belge sağlayıcı çağrıları, e-posta gönderim hacmi | Tek gerçek harici-fatura riski taşıyan kategori; **birim ekonomisinin ağırlık merkezi burasıdır** |

Plan × kullanım-değişken kalem eşlemesi:

| Plan | AI kredi kotası | OCR erişimi | E-belge erişimi | Not |
|---|---|---|---|---|
| Starter | 0 | Yok | Yok | Kullanım-değişken maliyet sıfıra yakın — tamamen sabit+tenant/kullanıcı-değişken |
| Professional | Dahil (seed 500, geçici) | Var (kotasız) | Yok | AI kredi tüketimi tek gerçek dış maliyet riski |
| Business | Dahil (seed 2000, geçici) | Var (kotasız) | Var (sandbox-only, henüz faturalandırılabilir değil) | AI + potansiyel gelecekteki e-belge maliyeti |
| Enterprise | Configurable | Configurable | Var | Anlaşmalı; guardrail bazlı (bkz. §11) |

---

## 5. Bulgu ayrımı — A/B/C/D

### A. Repository'den doğrulanmış değerler

- Plan × limit matrisi (§2 tablosu) — `plan-defaults.ts`, `PLAN_FEATURE_MATRIX.md` §1/§3.
- AI kredi politikası: 1 kredi = 100 token, çağrı başına asgari 1 kredi, rezervasyon TTL 5 dakika,
  `usdPerCredit = 0.01` **dahili yaklaşıklama** (`lib/ai/credits.ts:15-28`).
- AI kota tüketimi COMMITTED + süresi dolmamış RESERVED toplamıdır, takvim ayı bazında sıfırlanır
  (`lib/entitlements/ai-quota-usage.ts`, `lib/ai/quota-period.ts`).
- AI sert kota garantisi: gerçek tüketim rezervasyonu aşsa bile müşteriye yansıyan `consumedCredits`
  asla `reservedCredits`'i geçemez (`ai-usage-reporting-service.ts:280-282`) — bu, maliyet taşmasına
  karşı **kodda var olan bir guardrail'dir**, fiyatlandırma modelinin güvenle dayanabileceği bir gerçek.
- OCR yükleme sınırı 8 MB/dosya (`document-extraction-service.ts:29`); dosyalar Postgres'te bytea olarak
  saklanır, ayrı bir nesne depolama servisi yok.
- OCR miktar kotası **hiç yok** — yalnızca ikili capability kontrolü (§2.1/§5 madde 5,
  `PLAN_FEATURE_MATRIX.md`).
- E-belge entegrasyonu bugün yalnızca Nilvera **sandbox, salt-okunur** sorgulama (`nilvera-provider.ts`);
  `UYUMSOFT`/`IZIBIZ`/`SOVOS`/`QNB_ESOLUTIONS`/`PARASUT` şemada seçilebilir ama adaptörsüz
  (`provider-registry.ts:10-16`).
- Ödeme/faturalama sağlayıcı entegrasyonu yok (`PLAN_FEATURE_MATRIX.md` §7 satır 10, YF-808 açık).
- İzleme (Sentry) ve dağıtık rate limiting (Redis) üretimde aktif (`package.json`, `docker-compose.yml`).
- Bağlantı havuzlama parametresi yok; tek `PrismaClient` (`PRODUCTION_READINESS.md` §5, R-10).
- Ayrı bir arka plan iş kuyruğu/worker sistemi kod tabanında bulunamadı.

### B. Harici/değişken maliyetler (vendor fiyatına ihtiyaç duyar — burada UYDURULMADI)

- AI sağlayıcı gerçek token fiyatı (model/sağlayıcıya göre değişir — `lib/ai/providers/*` sağlayıcı-nötr,
  gerçek prod sağlayıcı seçimi ve fiyat listesi kod tabanında yok).
- OCR sağlayıcı gerçek sayfa/belge fiyatı (bugün gerçek bir OCR sağlayıcı entegre değil — test/stub
  provider kullanılıyor).
- E-belge sağlayıcı (Nilvera veya alternatif) canlı işlem başına ücreti — sandbox'ta ücretlendirme yok.
- SMTP/e-posta gönderim sağlayıcı birim fiyatı (sağlayıcı seçimi ortam değişkenine bırakılmış).
- Barındırma platformu (Postgres/Redis/compute) birim fiyatı — `docker-compose.yml` yalnızca yerel geliştirme
  içindir, üretim barındırma sağlayıcısı/sözleşmesi kod tabanında belirtilmemiş.
- Destek personeli saatlik/aylık maliyeti (İK/organizasyon kararı, kod tabanının kapsamı dışı).

### C. İş varsayımları (repository gerçeği DEĞİL — açıkça işaretli)

- Hedef brüt marj aralığı (bkz. §7).
- Aylık/yıllık fiyat aralıkları (bkz. §14).
- Yıllık ön ödeme indirim oranı (bkz. §10).
- Deneme (trial) süresi ve promosyon politikası.
- Business destek seviyesi SLA hedefleri (yanıt süresi vb.).
- Enterprise onboarding kapsamı.

### D. Hâlâ karar bekleyen açık maddeler

1. Professional/Business AI kredi kotalarının **nihai** sayısal değeri (seed 500/2000 geçicidir).
2. OCR için miktar bazlı bir `ocr.monthly_quota` limit kimliğinin eklenip eklenmeyeceği ve değeri.
3. Gerçek AI sağlayıcı/model seçimi ve o sağlayıcının token birim fiyatı.
4. Gerçek OCR sağlayıcı seçimi ve sayfa/belge birim fiyatı.
5. E-belge sağlayıcısının canlıya alınıp alınmayacağı ve işlem başına ücreti.
6. Barındırma platformu ve tenant/kullanıcı başına gerçek altyapı maliyeti.
7. Destek modeli (kim, hangi SLA, hangi kanal) ve saatlik/aylık maliyeti.
8. Ödeme sağlayıcısı seçimi (Stripe/iyzico/Param vb.) ve işlem komisyon oranı — bu da brüt marjı
   doğrudan etkiler ama YF-808 kapsamındadır.

---

## 6. Birim ekonomisi formülü (Decimal-güvenli, sembolik)

Tüm tutarlar kavramsal/sembolik kalır; hiçbir sayısal vendor fiyatı varsayılmaz. Uygulamaya geçerken
(gerçek bir hesap tablosu/servis) tüm parasal alanlar CLAUDE.md ilkesiyle uyumlu şekilde **Decimal**
(`Prisma.Decimal` veya kuruş bazlı integer) olmalı — floating-point kısayolu YOK, tıpkı
`lib/ai/credits.ts`'in `creditsToEstimatedCostUsd` fonksiyonunun `Prisma.Decimal.mul` kullanması gibi
(`lib/ai/credits.ts:57-59`).

```
Tenant başına aylık katkı (contribution) =
    Plan_Fiyatı
  − Sabit_Platform_Payı(tenant)                 // toplam sabit maliyet / aktif tenant sayısı
  − Tenant_Değişken_Maliyet(tenant)              // depolama + yedekleme + bağlantı payı
  − Kullanıcı_Değişken_Maliyet(users.active)      // ~sabit, ihmal edilebilir düzeyde küçük
  − AI_Maliyeti(tenant)
  − OCR_Maliyeti(tenant)
  − Entegrasyon_Maliyeti(tenant)
  − Destek_Maliyeti(tenant)

Brüt_Marj_Oranı = Tenant_Başına_Katkı / Plan_Fiyatı
```

Kullanım-değişken alt formüller (sembolik girdiler — §5.D kapatılana kadar sabit sayı YAZILMAZ):

```
AI_Maliyeti(tenant) =
    min(kullanılan_kredi, ai.monthly_quota) × AI_COST_PER_CREDIT
  + max(0, kullanılan_kredi − ai.monthly_quota) × AI_OVERAGE_COST_PER_CREDIT   // top-up satılıyorsa

OCR_Maliyeti(tenant) =
    min(işlenen_sayfa, ocr.monthly_quota) × OCR_COST_PER_PAGE
  + max(0, işlenen_sayfa − ocr.monthly_quota) × OCR_OVERAGE_COST_PER_PAGE

Entegrasyon_Maliyeti(tenant) =
    e_belge_işlem_sayısı × INTEGRATION_COST_PER_DOCUMENT

Destek_Maliyeti(tenant) = SUPPORT_COST_PER_TENANT(plan_seviyesi)
```

`AI_COST_PER_CREDIT`, `OCR_COST_PER_PAGE`, `INTEGRATION_COST_PER_DOCUMENT`, `SUPPORT_COST_PER_TENANT`
sembolik sabitlerdir — gerçek değerleri §5.B'deki vendor sözleşmeleri belirlenene kadar bilinmez.
`ai.monthly_quota` ve (henüz var olmayan) `ocr.monthly_quota` plan bazlı limit kimlikleridir (bkz. §2).

**Kırılım noktası (break-even) formülü** — bir planın en az sabit+destek maliyetini karşılaması için
gereken asgari fiyat:

```
Plan_Fiyatı_Asgari ≥ Sabit_Platform_Payı(tenant)
                    + Tenant_Değişken_Maliyet(tenant)
                    + ai.monthly_quota × AI_COST_PER_CREDIT      // tam kota kullanımı varsayımıyla (kötümser)
                    + ocr.monthly_quota × OCR_COST_PER_PAGE
                    + SUPPORT_COST_PER_TENANT(plan_seviyesi)
```

Bu formül **kötümser** (worst-case, kota tam kullanılıyor) bir taban çizer — gerçek marj, ortalama
kullanım-oranı (utilization rate, bkz. §7) kota kullanımının altında kaldığı ölçüde bu tabanın üzerinde
gerçekleşir.

---

## 7. Kullanım senaryoları — light / expected / heavy

Bu senaryolar kavramsal bir **kota-kullanım oranı (utilization %)** üzerinden ifade edilir; mutlak kredi/
sayfa sayısı vermez çünkü nihai kota sayıları henüz kilitlenmemiştir (§5.D madde 1-2).

| Senaryo | AI kota kullanım oranı | OCR kullanım yoğunluğu | Destek talebi yoğunluğu | Yorum |
|---|---|---|---|---|
| **Light** | ~%10-20 | Düşük (birkaç belge/ay) | Minimal (self-servis dokümantasyon yeterli) | Tipik küçük yüklenici, temel finans takibi kullanan; AI/OCR'i keşif amaçlı dener |
| **Expected** | ~%40-60 | Orta (düzenli fatura/fiş yükleme) | Düşük-orta (ayda birkaç destek talebi) | Planlanan hedef kullanıcı profili — kota, bu profile göre boyutlandırılmalı |
| **Heavy** | ~%90-100+ (overage tetikler) | Yüksek (toplu belge yükleme dönemleri, örn. ay sonu hakediş) | Orta (aktif kullanım = daha fazla destek teması) | Kota aşımı/top-up ekonomisinin test edildiği senaryo; §8 abuse/outlier ile kesişir |

Her senaryo için kavramsal katkı hesabı:

```
Revenue(senaryo)
− Sabit_Platform_Payı
− Tenant/Kullanıcı_Değişken_Maliyet
− AI_Maliyeti(kullanım_oranı × ai.monthly_quota)
− OCR_Maliyeti(senaryo_yoğunluğu)
− Entegrasyon_Maliyeti(varsa)
− Destek_Maliyeti(senaryo_talep_yoğunluğu)
= Katkı / Brüt_Marj
```

**Beklenen sıralama (yön, sayı değil):** Light senaryoda brüt marj en yüksektir (kota büyük ölçüde
kullanılmaz, sabit maliyet payı fiyatla kolayca karşılanır). Heavy senaryoda AI sert kota garantisi
(§5.A — `consumedCredits ≤ reservedCredits`) marj erozyonunu **kotanın üzerine çıkmaz** şekilde sınırlar;
asıl marj riski overage/top-up fiyatlaması `AI_OVERAGE_COST_PER_CREDIT`'i doğru kapsamaması durumunda
ortaya çıkar (bkz. §8).

---

## 8. AI kota ekonomisi

- **Dönüşüm birimi:** 1 kredi = 100 token (girdi+çıktı toplamı), çağrı başına asgari 1 kredi
  (`AI_CREDIT_POLICY`, `lib/ai/credits.ts:15-19`).
- **Rezervasyon modeli:** Her çağrı öncesi tutucu (üst sınır) bir kredi rezervasyonu yapılır; gerçek
  tüketim rezervasyonu aşarsa müşteriye yansıyan tutar rezervasyona **sabitlenir** (capped) — sağlayıcıya
  ödenen gerçek maliyet ile müşteriye yansıyan kota tüketimi bu noktada ayrışabilir
  (`ai-usage-reporting-service.ts:274-282`). **Bu, platformun marjını koruyan değil, marjını riske
  atabilen bir noktadır**: gerçek token kullanımı sık sık rezervasyonu aşıyorsa (ör. modelin çıktı
  tahmini kötüyse), sağlayıcıya ödenen gerçek maliyet müşteriden alınan krediyle örtüşmeyebilir.
  **Öneri:** `estimateReservationCredits`'in gerçek/tahmini oranı üretim telemetrisiyle düzenli izlenmeli
  (bkz. §12).
- **Dahil kota maliyet tavanı (kavramsal):**
  `Included_AI_Cost_Ceiling(plan) = ai.monthly_quota(plan) × AI_COST_PER_CREDIT`.
  Bu tavan, plan fiyatının AI için ayrılabilecek azami payını belirler — plan fiyatı bu tavanı + hedef
  marjı + diğer tüm maliyet kalemlerini karşılamalıdır (bkz. §6 kırılım formülü).
- **Kullanım oranı senaryoları:** §7'deki light/expected/heavy — kota boyutlandırması "expected"
  senaryodaki ortanca kullanıcının kotanın **altında** kalacağı, "heavy" kullanıcının overage'a
  düşeceği şekilde ayarlanmalı (klasik SaaS kota tasarımı: kota bir üst sınır değil, "çoğu kullanıcı
  bunun altında kalır" hedefidir).
- **Kötüye kullanım/aykırı değer (abuse/outlier) senaryosu:** Sert kota garantisi (`AI_QUOTA_EXCEEDED`
  reddi, `checkQuota`, Serializable transaction + organizasyon satır kilidi —
  `ai-usage-reporting-service.ts:126-235`) tek bir organizasyonun kotasını **aşarak** platformu
  zarara sokmasını mimari olarak engeller. Kalan risk yüzeyi: (a) idempotency-key yeniden kullanımıyla
  ücretsiz tekrar deneme (kod bunu `attemptCount`/recycle ile engelliyor), (b) tahmini rezervasyon
  gerçek maliyetin çok altında kalırsa sağlayıcı tarafında marj erozyonu (yukarıdaki madde).
- **Hedef brüt marj koruması:** `AI_COST_PER_CREDIT` bilinmeden sayısal bir marj hedefi verilemez;
  ancak yapısal kural şudur: `ai.monthly_quota(plan) × AI_COST_PER_CREDIT` toplam plan fiyatının
  **belirlenecek bir tavan yüzdesini** (iş varsayımı, örn. "AI dahil maliyeti plan fiyatının %X'ini
  geçmemeli") aşmamalıdır — bu yüzde YF-805 kapsamında iş kararı olarak belirlenmeli.
- **Overage/top-up ekonomisi:** Bugün kod tabanında **top-up/ek kredi satın alma akışı yok** — kota
  dolduğunda yalnızca `AI_QUOTA_EXCEEDED` ile yeni istek reddediliyor (sert duvar, kredi kartı
  tahsilatı yok). Bir top-up modeli eklenirse: `AI_OVERAGE_COST_PER_CREDIT ≥ AI_COST_PER_CREDIT ×
  (1 + hedef_marj)` olmalı — aksi halde overage geliri, dahil kotanın altındaki marjı seyreltir.

---

## 9. OCR/belge işleme ekonomisi

- **Bugünkü durum — kritik boşluk:** `ocr` yalnızca ikili bir capability'dir (Starter: kapalı,
  Professional/Business/Enterprise: açık). **Miktar bazlı bir kota (`ocr.monthly_quota` benzeri bir
  `LIMIT_IDS` girdisi) hiç yok** — `PLAN_FEATURE_MATRIX.md` §5 madde 5 ve §6 son madde bunu açıkça
  "implementation-alignment gap" olarak işaretliyor. Bugün bir Professional organizasyon teorik olarak
  sınırsız belge yükleyebilir (yalnızca 8 MB/dosya sınırı var).
- **Belge/sayfa bazlı değişken maliyet modeli (önerilen, uygulanmamış):**
  `OCR_Maliyeti = min(işlenen_belge, ocr.monthly_quota) × OCR_COST_PER_PAGE_OR_DOCUMENT + overage`.
  Bugün gerçek bir OCR sağlayıcısı entegre olmadığından (`document-extraction-service.ts` bir
  `DocumentExtractionProvider` soyutlaması kullanıyor, gerçek prod sağlayıcısı seçilmemiş),
  `OCR_COST_PER_PAGE` tamamen sembolik kalır.
- **Dahil kota + overage/add-on modeli (öneri çerçevesi):**
  - Starter: OCR yok (bugünkü karar korunur).
  - Professional: aylık dahil belge/sayfa kotası + üzerinde add-on paket satışı (ör. "+N belge paketi").
  - Business: Professional'dan daha yüksek dahil kota (mevcut AI kota farklılaşma deseniyle tutarlı).
  - Enterprise: Configurable (mevcut `null`-limit yaklaşımıyla tutarlı, anlaşmalı sabit değer seçeneği
    de değerlendirilebilir — §5.D madde 2 ile birlikte kapatılmalı).
- **Ön koşul mühendislik görevi:** Bu ekonomi modelinin canlıya alınabilmesi için önce bir
  `ocr.monthly_quota` limit kimliği eklenmeli ve `entitlement-service.ts`'teki `countUsage` switch'ine
  bir case eklenmeli (mevcut `ai.monthly_quota` deseniyle birebir aynı mimari, bkz.
  `lib/entitlements/entitlement-service.ts:157-180`) — bu, YF-807'nin kapsamı dışında ayrı bir
  mühendislik görevidir (bkz. §12 sonraki görev).

---

## 10. Yıllık indirim çerçevesi

Repository'de herhangi bir faturalama döngüsü/indirim mantığı yok (ödeme sağlayıcı entegrasyonu YOK,
§5.A). Bu tamamen bir iş varsayımı alanıdır:

- **Yapısal gerekçe:** Yıllık ön ödeme, platformun nakit akışı öngörülebilirliğini artırır ve churn
  riskini azaltır — karşılığında müşteriye indirim vermek standart SaaS pratiğidir.
- **Öneri (iş varsayımı, aralık olarak):** Yıllık ödemede aylık fiyatın **%15-%20'si** kadar indirim
  (yani yıllık fiyat ≈ 10-10.2 aylık fiyat) — bu bir pazar/rekabet kararıdır, repository'den türetilemez.
- **Guardrail:** İndirim oranı, o plandaki hedef brüt marjı (bkz. §7) sıfırın altına düşürmemelidir;
  yani `Yıllık_İndirimli_Fiyat / 12 ≥ Plan_Fiyatı_Asgari` (§6 kırılım formülü) her zaman sağlanmalı.
- **Trial/promosyon:** Kod tabanında trial/deneme süresi mantığı yok. Öneri (iş varsayımı): süreli
  deneme (ör. 14 gün) sırasında AI/OCR kotası **düşük, sabit bir keşif kotasıyla** sınırlanmalı (tam
  plan kotası değil) — aksi halde deneme süresi kötüye kullanımı (abuse) sert AI kota duvarının dışında
  kalan tek risk yüzeyi olur.

---

## 11. Enterprise özel teklif çerçevesi

- **Bugünkü kod gerçeği:** Enterprise'da `users.active`/`projects.active`/`ai.monthly_quota` hepsi
  `null` = **sınırsız** (`plan-defaults.ts:88-100`). "Anlaşmalı sabit değer" senaryosu için ayrı bir
  yapılandırma alanı **yok** (`PLAN_FEATURE_MATRIX.md` §5 madde 7).
- **Guardrail çerçevesi (repository'nin sunduğu gerçek sinyaller üzerine kurulu):**
  1. Enterprise teklifi, tahmini `ai.monthly_quota` ve (eklendiğinde) `ocr.monthly_quota` üzerinden
     §6'daki kırılım formülüyle **asgari fiyat tabanı** hesaplanarak başlamalı — "sınırsız" pazarlama
     dili olsa bile satış içi model gerçek bir üst sınır varsayımıyla fiyatlanmalı.
  2. `deployment.dedicated` (opsiyonel özel dağıtım, roadmap kimliği) seçilirse sabit platform payı
     tek-tenant'a yüklenir — paylaşımlı altyapı amortismanı geçersiz olur, fiyat tabanı buna göre
     yeniden hesaplanmalı.
  3. `sla`/`onboarding.dedicated` seçilirse `SUPPORT_COST_PER_TENANT` sembolik girdisi Enterprise
     için ayrı (yüksek) bir değerle modellenmeli — bugün kod tabanında bu maliyetin hiçbir izlenebilir
     karşılığı yok, tamamen İK/organizasyon kararı.
  4. **Enterprise için sabit bir liste fiyatı ÖNERİLMEZ** — yalnızca yukarıdaki taban + kâr marjı
     formülüyle satış ekibinin teklif hazırlarken kullanacağı bir hesap çerçevesi.

---

## 12. Fiyat kilidi öncesi toplanması gereken telemetri

Bugün varsayım olan her girdiyi gerçek veriyle değiştirmek için gereken ölçümler:

| Telemetri | Neden gerekli | Bugünkü durum |
|---|---|---|
| Tenant/organizasyon başına gerçek AI kredi tüketim dağılımı (p50/p90/p99) | §7 utilization senaryolarını gerçek sayıya çevirir, kota boyutlandırmasını doğrular | `AiUsageLedger` tablosunda veri birikiyor (`ai-usage-reporting-service.ts`) ama bir raporlama/analiz görünümü yok |
| `estimateReservationCredits` tahmini vs. gerçek `tokensToCredits` oranı | AI marj erozyon riskini ölçer (bkz. §8) | Ham veri ledger'da var, agregasyon yok |
| Tenant başına yüklenen belge sayısı/ayı | OCR kota boyutlandırması için zorunlu ön koşul | `DocumentExtraction` tablosunda birikiyor, kota mantığı henüz yok |
| Tenant başına Postgres depolama büyüme oranı | Tenant-değişken maliyet katsayısını gerçek veriyle kalibre eder | Ölçülmüyor |
| Organizasyon başına aktif kullanıcı/proje sayısının plan limitine yakınlık dağılımı | Downgrade/grandfathering (§8.3, `PLAN_FEATURE_MATRIX.md`) sıklığını ve upgrade dürtüsünü gösterir | `getOrganizationLimitSummary` altyapısı var (`entitlement-service.ts:291-301`), UI/rapor yok |
| Destek talebi hacmi ve ortalama çözüm süresi, plan bazında | `SUPPORT_COST_PER_TENANT`'ı gerçek veriyle doldurur | Kod tabanında hiç yok — harici bir destek aracı (Zendesk/Intercom vb.) seçilmeli |
| Barındırma faturası — Postgres/Redis/compute, tenant sayısına bölünmüş | Sabit platform payını gerçek veriyle kalibre eder | Barındırma sağlayıcısı henüz seçilmemiş |
| E-belge sandbox → canlı geçiş sonrası işlem başına gerçek sağlayıcı faturası | `INTEGRATION_COST_PER_DOCUMENT`'ı doldurur | Sandbox'ta ücretlendirme yok |

**Öncelik sırası:** AI kredi tüketim dağılımı ve OCR belge hacmi ilk ikisi olmalı — bunlar hem en
büyük marj riskini taşıyor hem de mevcut altyapı (ledger/extraction tabloları) zaten veriyi topluyor,
yalnızca bir raporlama katmanı eksik.

---

## 13. Çözülmemiş vendor-maliyet girdileri (özet)

| Sembolik girdi | Ne için kullanılır | Neden çözülemedi |
|---|---|---|
| `AI_COST_PER_CREDIT` | §6 formülü, §8 AI ekonomisi | Gerçek sağlayıcı/model seçimi ve fiyat listesi kod tabanında yok |
| `AI_OVERAGE_COST_PER_CREDIT` | Top-up ekonomisi (§8) | Top-up akışı henüz uygulanmadı, fiyat da seçilmedi |
| `OCR_COST_PER_PAGE` (veya `_PER_DOCUMENT`) | §6, §9 | Gerçek OCR sağlayıcısı entegre değil |
| `INTEGRATION_COST_PER_DOCUMENT` | §6, e-belge ekonomisi | Nilvera (veya alternatif) yalnızca sandbox'ta, ücretlendirme yok |
| `SUPPORT_COST_PER_TENANT` | §6, §11 | Destek modeli/aracı seçilmedi, İK kararı |
| Barındırma birim maliyeti (tenant/kullanıcı başına) | Sabit + tenant-değişken payı | Üretim barındırma sağlayıcısı/sözleşmesi seçilmedi |
| Ödeme sağlayıcı komisyon oranı | Net gelir hesabı (Plan_Fiyatı sonrası gerçek tahsilat) | YF-808 kapsamında, henüz seçilmedi |

---

## 14. Nihai fiyatlandırma karar tablosu

> **Uyarı:** Bu tablodaki TRY tutarları **iş varsayımıdır, repository gerçeği DEĞİLDİR** — hiçbir
> vendor maliyetine dayanmaz, yalnızca plan farklılaştırma oranına (kullanıcı/proje/AI kota
> katsayılarına, bkz. §2) dayalı göreli bir başlangıç noktasıdır. §13'teki girdiler netleşmeden
> **kesinleştirilmemelidir** ve pazar testi (fiyat duyarlılığı görüşmeleri, rakip analizi) gerektirir.

| Plan | Aylık fiyat (TRY, **varsayım aralığı**) | Yıllık indirim (varsayım) | Dahil AI kota | Dahil OCR kota | Not |
|---|---|---|---|---|---|
| Starter | Düşük bant (giriş fiyatı) — aralık belirlenmeli | §10 çerçevesi | 0 | Yok | AI/OCR maliyeti sıfır; fiyat tamamen sabit+tenant/kullanıcı maliyetini + hedef marjı karşılamalı |
| Professional | Orta bant | §10 çerçevesi | Seed 500 kredi (§5.D madde 1 kapanana kadar geçici) | **Kota tanımı eksik (§9) — önce mühendislik görevi gerekli** | Fiyat, `500 × AI_COST_PER_CREDIT` tavanını + hedef marjı karşılamalı (§6, §8) |
| Business | Professional'ın üzerinde, kullanıcı/proje/AI oranına orantılı bant | §10 çerçevesi | Seed 2000 kredi (geçici) | Kota tanımı eksik + e-belge (sandbox-only) | Fiyat, `2000 × AI_COST_PER_CREDIT` tavanını + destek maliyeti artışını + hedef marjı karşılamalı |
| Enterprise | **Fiyat yok — özel teklif** | Anlaşmalı | Configurable | Configurable | §11 guardrail çerçevesiyle satış-içi hesaplanır |

**Şimdi verilebilecek kararlar (§5.A'ya dayanır, ek veri gerektirmez):**
- Dört katmanlı yapı ve göreli farklılaştırma sırası (Starter < Professional < Business < Enterprise) kilitlenebilir.
- Starter'da AI/OCR'nin tamamen dışarıda bırakılması kararı kilitlenebilir (zaten kod ve kanonik matriste böyle).
- AI sert kota duvarının (overage yok, `AI_QUOTA_EXCEEDED`) launch-day davranışı olarak kalması kararı verilebilir — top-up modeli sonraki bir sürüme ertelenebilir.

**Şimdi verilemeyecek kararlar (§5.D'ye bağlı):**
- Herhangi bir TRY tutarının kesinleştirilmesi.
- Professional/Business AI kota sayılarının nihai (seed olmayan) değerleri.
- OCR dahil kota miktarı (önce `ocr.monthly_quota` mühendislik görevi gerekir).
- Enterprise taban fiyatı.

---

## Sonraki mantıklı görev

1. **Mühendislik (küçük, izole):** `ocr.monthly_quota` limit kimliğini `LIMIT_IDS`'e eklemek ve
   `entitlement-service.ts` `countUsage`'a `DocumentExtraction` sayımı için bir case eklemek —
   `ai.monthly_quota` ile birebir aynı desen (bkz. §9). Bu, OCR'yi fiyatlandırılabilir hale getirmenin
   ön koşuludur.
2. **Veri/telemetri:** §12'deki AI kredi tüketim dağılımı ve OCR belge hacmi için bir raporlama görünümü
   (mevcut `AiUsageLedger`/`DocumentExtraction` tablolarının üzerine, yeni bir tablo gerekmez).
3. **İş kararı (YF-805 ön koşulu):** Gerçek AI sağlayıcı/model seçimi ve OCR sağlayıcı seçimi — bu ikisi
   çözülmeden `AI_COST_PER_CREDIT`/`OCR_COST_PER_PAGE` sembolik kalmaya devam eder ve §14 tablosu
   kesinleştirilemez.
