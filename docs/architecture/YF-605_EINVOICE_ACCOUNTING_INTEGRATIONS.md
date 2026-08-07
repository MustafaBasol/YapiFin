# YF-605 — E-belge (e-Fatura/e-Arşiv/e-İrsaliye) ve Muhasebe Entegrasyonları: Mimari ve Aşamalı Teslim Planı

**Durum:** Araştırma/mimari doküman — üretim entegrasyon kodu içermez.
**Kapsam:** Yalnızca mimari tasarım ve yasal/teknik ön koşulların netleştirilmesi. `docs/PRODUCT_REQUIREMENTS.md` §7 bu alanları açıkça **MVP dışı** sayar; bu doküman MVP finans çekirdeği tamamlandıktan sonraki bir sonraki büyük epik için hazırlıktır (bkz. CLAUDE.md: "Program, keşif, teklif ve gelişmiş hakediş özellikleri MVP finans çekirdeğinden sonra ele alınmalıdır").
**Baseline:** `origin/main` @ `be22be86b5e88c10f4deca2a07396628043ef4cb` (2026-08-07 itibarıyla doğrulandı).

## Kaynak güvenilirlik notasyonu

Bu doküman boyunca her iddia şu etiketlerden biriyle işaretlenir:

- **[A]** Resmî/birincil kaynaktan doğrulanmış (GİB tebliği, resmî portal, doğrudan okunmuş sağlayıcı dokümantasyonu)
- **[B]** Sağlayıcıya özgü uygulama gerçeği (entegratör/ERP dokümantasyonu veya güvenilir ikincil kaynaklarla tutarlı şekilde doğrulanmış)
- **[C]** Mimari çıkarım/varsayım (bu dokümanın yazarı tarafından türetilmiştir, birincil kaynağa dayanmaz)
- **[D]** Çözülmemiş — geliştirmeye başlamadan önce mali müşavir ve/veya seçilecek entegratörle teyit edilmelidir

Araştırma, GİB'in resmî portallarının (efatura.gov.tr, ebelge.gib.gov.tr, mevzuat.gov.tr) bir kısmının doğrudan alınamadığı (TLS/yönlendirme hataları) koşullarda yürütülmüştür; bu durumlarda birden fazla bağımsız ikincil kaynakla çapraz doğrulama yapılmış ve güven seviyesi buna göre etiketlenmiştir. **Hiçbir eşik, tarih veya oran bu dokümandan doğrudan ürün mantığına sabit değer olarak kopyalanmamalıdır — uygulama öncesi mali müşavir teyidi zorunludur.**

---

## 1. Yönetici özeti

YapiFin bugün bir ön muhasebe/e-fatura ürünü değildir (`docs/PRODUCT_REQUIREMENTS.md` §2, §7). Bu doküman, e-belge ve muhasebe entegrasyonlarının **mevcut finansal çekirdeği bozmadan** nasıl eklenebileceğini tanımlar. Temel sonuçlar:

1. **YapiFin'in kendisi GİB özel entegratörü olmamalıdır.** Sermaye (bir kaynakta 5.000.000 TL, **[D]** teyitsiz), zorunlu ISO 27001/22301/20000 sertifikasyonu ve sürekli GİB denetimi gerektiren bu yol, bir inşaat-finans SaaS'ının kapsamı dışındadır **[C]**. Doğru model: mevcut bir özel entegratörün (Nilvera, Uyumsoft, Sovos/Foriba, İzibiz, QNB eSolutions vb.) API'sine **müşteri** olarak bağlanmak **[B/C]** — pazardaki standart yaklaşım budur.
2. **"E-fatura entegrasyonu" ile "muhasebe senkronizasyonu" farklı kapsamlardır.** İncelenen tüm özel entegratörler yalnızca yasal belge taşımacılığı (e-Fatura/e-Arşiv/e-İrsaliye/e-Defter) sunar; genel muhasebe defteri, hesap planı veya cari senkronizasyonu sunmazlar **[B]**. Bu iki alan ayrı arayüzler ve ayrı teslim fazları olarak ele alınmalıdır.
3. **Masaüstü/on-prem ERP'lerle (Logo, Mikro, Netsis) doğrudan API senkronizasyonu MVP için gerçekçi değildir.** Bu sistemlerin API'leri müşterinin kendi sunucusunda çalışan yerel bir servise bağımlıdır (Logo Objects, Mikro API başvuru/onay gerektirir, Netsis lisanslı NetOpenX/REST) — merkezi, tek seferde entegre edilebilir bulut uç noktaları değildir **[B/C]**. Ayrıca hedef kitledeki birçok inşaat KOBİ'sinin muhasebesini kendi sisteminden değil, **muhasebecisinin ayrı sisteminden** (çoğunlukla Luca/Zirve) yürüttüğü gözlemlenmiştir **[B/C]** — bu da "müşterinin ERP'sine bağlan" stratejisinin isabet oranını daha da düşürür.
4. **Önerilen MVP-sonrası öncelik sırası:** (a) yapılandırılmış Excel/CSV dışa aktarma genişletmesi (muhasebecinin kullandığı sistemden bağımsız, mevcut export altyapısı üzerine inşa edilir) — düşük risk, hızlı teslim; (b) tek bir e-belge özel entegratörü ile sandbox seviyesinde gönderim/durum sorgulama entegrasyonu — orta risk; (c) bulut-native muhasebe API'si (ör. Paraşüt) senkronizasyonu — yalnızca iş stratejisi doğrularsa, ayrı bir epik.
5. **İnşaat sektörüne özgü iki düzenleme özellikle takip edilmelidir:** düşük e-Fatura eşiği (500.000 TL, "inşa" faaliyeti için, genel 3.000.000 TL yerine) **[A, teyitsiz ikincil doğrulama]** ve İnşaat Demiri İzleme Sistemi (İDİS) — demir/çelik ticareti yapan müşteriler için e-İrsaliye zorunluluğunu 1.000.000 TL eşiğine indiren, GİB'in 02.12.2025 tarihli duyurusuyla e-Fatura/e-İrsaliye'ye yeni zorunlu alanlar ekleyen ayrı bir sistem **[B, içerik teyitsiz]**.

---

## 2. Doğrulanmış güncel dış kısıtlar (e-belge)

| Konu | Bulgu | Etiket |
|---|---|---|
| Genel e-Fatura/e-Arşiv eşiği | Önceki yıl brüt satış hasılatı ≥ 3.000.000 TL → izleyen yılın 1 Temmuz'una kadar geçiş zorunlu (VUK Genel Tebliği Sıra No. 509 ve değişiklikleri) | **[A]** (birincil metin doğrudan okunamadı, çoklu bağımsız ikincil kaynakla doğrulandı) |
| İnşaat sektörü özel eşiği | "İnşa, imal, alım, satım veya kiralama" faaliyeti yürüten mükellefler için eşik **500.000 TL**'ye iner (2022 ve sonrası hasılat dönemleri) | **[A]**, ancak "inşa" faaliyetinin YapiFin'in farklı müşteri profillerine (genel yüklenici / taşeron / malzeme tedarikçisi) tam olarak nasıl uygulandığı **[D]** |
| 2026 eşik değişikliği | Eşiklerin daha da düşürüleceğine dair taslak tebliğ sinyalleri var; kesinleşip kesinleşmediği bu araştırmada doğrulanamadı | **[D] — kritik, çözülmeden ürün mantığına eşik sabitlenmemeli** |
| Ceza | Zorunlu mükellefin kağıt fatura düzenlemesi → fatura tutarının %10'u özel usulsüzlük cezası | **[B/A]** |
| e-Fatura vs e-Arşiv | e-Fatura yalnızca kayıtlı e-Fatura mükellefleri arasında (GİB mükellef sorgusu zorunlu); e-Arşiv, kayıtlı olmayan mükellef ve nihai tüketiciler için. Hukuki geçerlilik eşittir. | **[A/B]** |
| e-İrsaliye genel eşiği | Brüt satış hasılatı ≥ 10.000.000 TL; akaryakıt, madencilik, demir-çelik sektörleri ciro şartı olmaksızın zorunlu | **[A/B]** |
| İDİS (İnşaat Demiri İzleme Sistemi) | Demir/çelik üretici-bayii için ayrı ve daha düşük eşik (1.000.000 TL, 2024+); GİB 02.12.2025 duyurusuyla e-Fatura/e-İrsaliye'de zorunlu yeni alanlar; olası aktivasyon 02.02.2026 | **[B]** (duyurunun varlığı), **[D]** (teknik kılavuzun içeriği) |
| Kendi şantiyeler arası malzeme taşıması | Genel yüklenicinin kendi şantiyeleri arası malzeme nakliyesinin e-İrsaliye'ye tabi olup olmadığı, uygulayıcılar arasında bile tartışmalı | **[D]** |
| ETTN | 36 karakter, standart UUID biçimi (8-4-4-4-12) | **[A/B]** |
| Durum/yaşam döngüsü kodları | 1000 gönderildi, 1200 alıcıya ulaştı, 1300 tamamlandı, 1400 iptal edildi (+ ticari fatura senaryosunda ayrı kabul/red/itiraz durumları) | **[B]** — blog toplamı; GİB'in birincil "Sistem Yanıtı Şema" belgesinden doğrudan doğrulanmadı, state machine kodlanmadan önce birincil kaynak okunmalı |
| İtiraz/itiraz süresi | TTK gereği 8 gün (sessizlik = zımni kabul); ticari fatura senaryosunda sistem içi kabul/red/iade, temel senaryoda sistem dışı itiraz | **[A]** (8 günlük TTK kuralı), **[C]** (senaryo ayrımı, tek kaynaktan teyit edilmemiş) |
| Format | e-Fatura'da UBL-TR XML zorunlu; e-Arşiv'de zorunlu değil (pratikte yine üretiliyor) | **[A/B]** |
| Saklama süresi | VUK 5 yıl / TTK 10 yıl ayrımı var; pratikte 10 yıl önerilir, sorumluluk mükellefte, entegratöre devredilemez | **[B/C]**, kesin süre **[D]** |
| Değişmezlik (immutability) | Kabul edilen belge yerinde değiştirilemez; düzeltme yalnızca iptal veya yeni belge (iade faturası vb.) ile yapılır | **[C]** (evrensel e-fatura tasarım deseniyle tutarlı, GİB maddesine pinlenmedi) |
| Doğrudan özel entegratör olma | Sermaye şartı (bir kaynakta 5M TL), ISO 27001/22301/20000, GİB onaylı denetim kuruluşu denetimi, periyodik yeniden denetim | **[B]** (süreç), **[D]** (kesin sermaye rakamı) |
| Entegratöre müşteri olarak bağlanma | Pazardaki standart yol; Nilvera gibi sağlayıcılar bunu doğrudan "ERP/Muhasebe sistemleri ve diğer uygulamalar" için pazarlıyor | **[B]** |

**Sonuç:** Eşik/tarih detayları hızlı değişiyor ve bu araştırmada kesinleştirilemeyen (**[D]**) noktalar var. Mimari, eşik değerlerini **kod sabiti değil, organizasyon/ürün düzeyinde yapılandırma** olarak ele almalıdır (bkz. §7).

## 2.1 Entegratör API karşılaştırması (özet)

| Sağlayıcı | Kimlik doğrulama | Test ortamı | Not |
|---|---|---|---|
| **Nilvera** | OAuth2 benzeri Bearer token (portal API key) | Ayrı prod/test uç noktaları, izole anahtarlar | En modern, en iyi dokümante edilmiş aday **[B, doğrudan doğrulandı]**; webhook/idempotency detayları **[D]** |
| **Uyumsoft** | SOAP, kullanıcı adı/parola | Paylaşımlı test kimlik bilgileriyle test uç noktası | Daha eski nesil entegrasyon deseni **[B]** |
| **İzibiz** | Oturum bazlı (önce login çağrısı) | Ayrı test web servisi | Eski nesil, SDK örnekleri mevcut **[B]** |
| **Sovos/Foriba** | Teyit edilemedi | Teyit edilemedi | SAP/kurumsal odaklı, non-SAP için adaptör **[B]** |
| **QNB eSolutions** | Teyit edilemedi | Resmî "Taahhütname" + Test Ortamı İstek Formu ile biçimsel onboarding | **[A]** (onboarding süreci), kimlik doğrulama **[D]** |

**Öneri:** Sandbox değerlendirmesine **Nilvera** ile başlanması (en iyi dokümante edilmiş, modern kimlik doğrulama), ancak nihai sağlayıcı seçimi öncesi (i) İDİS/e-İrsaliye kapsamı, (ii) fiyatlandırma, (iii) webhook/idempotency sözleşmesinin birincil API referansından doğrudan okunması gerekir — bu doküman bir tedarikçi taahhüdü değildir.

## 2.2 Muhasebe/ERP entegrasyon manzarası (özet)

| Platform | Genel değerlendirme |
|---|---|
| Logo (Tiger/GO), Netsis | API, müşterinin kendi sunucusunda çalışan yerel bir servise (Logo Objects/NetOpenX) bağımlı; merkezi bulut uç noktası yok. Mikro ile birlikte pazar lideri ama SaaS-to-SaaS entegrasyona uygun değil **[B/C]**. |
| Mikro | En iyi dokümante edilmiş API (`apidocs.mikro.com.tr`), ama başvuru/onay gerektiriyor; kimlik doğrulama eski usül (MD5 tabanlı, OAuth değil) **[A]**. Muhasebeci ofislerine yönelik ayrı ürünü ("Mikro Müşavir") var. |
| Paraşüt | Gerçek bulut-native REST/OAuth2 API, geniş obje modeli (fatura, cari, e-belge, bordro, stok, webhook); erişim `destek@parasut.com` üzerinden manuel talep **[B]**. DST Teknoloji grubunda (Mikro/Zirve ile aynı grup) — Doğuş/İzibiz sahipliği **yanlış varsayımdır**, düzeltilmiştir. |
| Bizim Hesap | Genele açık geliştirici API'si tespit edilmedi; yalnızca pazaryeri konnektörleri **[A]**. |
| Odoo TR | e-Dönüşüm katmanı yine bir özel entegratöre (Nilvera vb.) bağımlı topluluk modülleriyle sağlanıyor — "muhasebe API'si" değil, e-belge taşımacılığının başka bir tüketicisi **[B]**. |
| Muhasebeci ofisi gerçeği | Hedef kitledeki şirketlerin çoğu, kendi operasyonel yazılımından **bağımsız** olarak muhasebecisinin kullandığı ayrı bir sistemde (çoğunlukla Luca/Zirve) takip ediliyor olabilir **[C]** — bu, "şirketin ERP'sine entegre ol" stratejisinin gerçek kapsamını daraltır. |

**Sonuç:** MVP-sonrası ilk adım için en yüksek getiri/risk oranı **yapılandırılmış dışa aktarmadır** — hangi sistemi kullanırsa kullansın muhasebeciye ulaşır, ortaklık/lisans onayı gerektirmez, mevcut export altyapısı (`server/exports/*`) üzerine inşa edilir.

---

## 3. Mevcut YapiFin mimarisi bulguları (ilgili alan)

Hedefli CodeGraph taraması (`server/services/transaction-service.ts`, `settlement-service.ts`, `customer-service.ts`, `lib/audit.ts`, `lib/permissions.ts`, `lib/env.ts`, `server/exports/*`, `server/services/errors.ts`) şu kalıpları doğruladı:

- **Tenant izolasyonu:** Her sorgu `id + organizationId` birlikte filtrelenir; hiçbir servis fonksiyonu istemciden gelen `organizationId`'ye güvenmez (`docs/ARCHITECTURE.md` §3 ile birebir).
- **Para semantiği:** `Prisma.Decimal` + `toDecimal()` yardımcıları; hiçbir yerde JS `number` ile para aritmetiği yok. Excel export'u bile Decimal hassasiyeti Excel double sınırını aşarsa metne düşüyor (`server/exports/money.ts`).
- **İptal = ters kayıt:** `cancelSettlement`/`cancelTransaction` hiçbir zaman satır silmez; `AccountMovement` üzerinde `REVERSAL` tipinde yeni hareket üretir, satır kilidi (`lockTransaction`/`lockAccount`/`lockSettlement`) ile eşzamanlı çift iptali engeller.
- **Idempotency deseni zaten var:** `Settlement.idempotencyKey` ve `AccountTransfer.idempotencyKey` `@unique` alanlardır; Prisma `P2002` çakışması yakalanıp orijinal kayıt idempotent şekilde döndürülür. **Bu, e-belge gönderim/senkronizasyon işlemleri için doğrudan yeniden kullanılabilecek, kanıtlanmış bir desendir.**
- **Audit log:** `writeAuditLog(tx, entry)` her zaman çağıran transaction içinde çalışır; `before`/`after` JSON alanları serbest biçimlidir ama mevcut kullanım disiplini "ham Prisma nesnesi asla loglanmaz, yalnızca ilgili alanlar" ilkesini izler (bkz. `docs/ARCHITECTURE.md` §15, proje bütçe kalemi silme örneği).
- **Hata modeli:** `ServiceError` (`VALIDATION | FORBIDDEN | NOT_FOUND | CONFLICT`) → route handler'da HTTP koduna merkezi çevrim (`server/exports/http.ts`). Aynı model entegrasyon servisleri için de kullanılmalı.
- **Rol yetkilendirme:** `lib/permissions.ts`'teki her fonksiyon yalnızca UI görünürlüğü içindir; gerçek kontrol her zaman servis katmanında tekrarlanır. Yeni entegrasyon yetkileri de bu ikili modele uymalıdır.
- **Ortam değişkeni/sır yönetimi:** `lib/env.ts`, Zod ile doğrulanan tek bir `getEnv()` kaynağı sunar; production'da placeholder/zayıf sır tespiti yapılır (`AUTH_SECRET` örneği). **Şu anda uygulamada herhangi bir şifreleme/KMS kütüphanesi yok** (`package.json` bağımlılıkları arasında crypto/KMS paketi bulunmuyor) — sağlayıcı kimlik bilgilerini şifreli saklamak için bu, yeni bir yetenek olarak eklenmelidir (bkz. §8).
- **Route handler deseni zaten kuruldu:** `app/api/exports/*/route.ts`, `getSessionUser()` çağıran ince bir sarmalayıcıdır, işin tamamını servis katmanına devreder ve `runtime = "nodejs"` sabitler. Webhook uç noktaları için de aynı ince-wrapper deseni izlenmelidir.
- **Arka plan işi/kuyruk altyapısı yok:** Bugün hiçbir zamanlanmış görev/kuyruk sistemi yok (`docs/ARCHITECTURE.md` §11'de OVERDUE canlı türetilir çünkü zamanlanmış tarama yoktur, bilinçli bir sınırlama olarak not edilmiş). Dış API polling/retry için bu altyapı eksikliği açıkça ele alınmalı (bkz. §10).
- **Dosya depolama iskeleti mevcut ama uygulanmamış:** `.env.example`'da `S3_*` değişkenleri "sonraki faz" olarak yer alıyor; `Document` modeli zaten `storageKey`/`mimeType`/`size` alanlarına sahip. Ham e-belge XML/PDF saklama bu deseni yeniden kullanmalı, DB'ye blob yazmamalı.

---

## 4. Önerilen entegrasyon sınırı

Mevcut mimari terminolojisiyle uyumlu iki sağlayıcı-nötr arayüz önerilir (`server/services/` altında, mevcut servislerle aynı üslupta — sınıf hiyerarşisi değil, fonksiyon tabanlı servis modülleri):

```
server/services/integrations/
  einvoice-provider.ts        # EInvoiceProvider sözleşmesi (arayüz + tip tanımları)
  einvoice-service.ts         # provider-nötr iş kuralları (org yetkisi, idempotency, audit)
  providers/
    nilvera-adapter.ts        # ilk somut adaptör (YF-605-B fazında)
  accounting-export-service.ts # Excel/CSV muhasebe dışa aktarma (mevcut server/exports/* üzerine)
  accounting-sync-provider.ts  # (gelecek, YF-605-F) API tabanlı senkronizasyon sözleşmesi
```

**`EInvoiceProvider` sözleşmesinin kapsamı (kavramsal, kod değil):**

- `lookupTaxpayer(vknOrTckn)` → kayıtlı e-Fatura mükellefi mi (e-Fatura/e-Arşiv branching kararı için)
- `submitDocument(document, idempotencyKey)` → ETTN + ilk durum
- `getDocumentStatus(ettn)` → yaşam döngüsü durumu
- `cancelDocument(ettn, reason)` → iptal talebi
- `listInboundDocuments(cursor)` / `fetchInboundDocument(ettn)` → gelen belge listeleme (polling modeli için)
- `verifyWebhookSignature(payload, headers)` → webhook modeli seçilirse

**Neden bu sınır:** Her somut sağlayıcı (Nilvera, Uyumsoft, İzibiz vb.) kendi kimlik doğrulama/protokol detayını (OAuth2 Bearer vs SOAP+parola) `providers/*-adapter.ts` içinde saklar; `einvoice-service.ts` hiçbir zaman sağlayıcıya özgü alan adı/protokol bilgisi içermez. Bu, `docs/ARCHITECTURE.md`'nin genel "Application/Domain/Data" katman ayrımıyla tutarlıdır ve tek bir sağlayıcıya kilitlenmeden sandbox denemesi yapılmasını sağlar.

**`AccountingIntegrationProvider` için MVP-sonrası öncelik farklıdır:** İlk somut uygulama bir API adaptörü değil, **mevcut `server/exports/excel-exporter.ts` deseninin genişletilmiş bir varyasyonudur** (muhasebeci fiş şablonuna uygun sütunlar). Gerçek API tabanlı `AccountingIntegrationProvider` sözleşmesi (Paraşüt gibi bir hedef için) yalnızca §2.2'deki iş gerekçesi doğrulanırsa, ayrı ve daha sonraki bir fazda tasarlanmalıdır.

---

## 5. E-belge yaşam döngüsü (tasarım düzeyinde)

```
[Taslak: internal FinancialTransaction'dan türetilir]
        │  (kullanıcı onayı — otomatik değil)
        ▼
   QUEUED  ──lookupTaxpayer──▶  (e-Fatura mı e-Arşiv mi kararı)
        │
        ▼
     SENT  ──submitDocument──▶  ETTN atanır, ham XML immutable storage'a yazılır
        │
        ▼
  DELIVERED / FAILED  (provider durumu; FAILED → sınırlı retry, sonra DEAD_LETTER)
        │
        ├──▶ ACCEPTED (ticari fatura senaryosu, sistem içi)
        ├──▶ REJECTED (ticari fatura senaryosu, sistem içi)
        └──▶ (temel senaryo: 8 gün TTK itiraz penceresi, sistem dışı — durum açıkça
              "itiraz penceresi açık" olarak gösterilir, otomatik "kabul edildi"
              varsayılmaz)
        │
        ▼
   CANCELLED (yalnızca provider'ın izin verdiği durumlarda; iptal de ayrı bir
              olay olarak loglanır, orijinal belge asla silinmez/değiştirilmez)
```

**Kritik tasarım kararı:** Bu durum makinesi, mevcut `FinancialTransaction.status` (`OPEN|PARTIALLY_PAID|PAID|OVERDUE|CANCELLED`) türetme mantığından **tamamen ayrıdır**. Bir e-Fatura'nın `REJECTED` olması, ilgili gelir kaydının finansal durumunu **otomatik değiştirmez** — kullanıcı açıkça karar vermelidir (bkz. "harici bir belge alındı diye otomatik mutasyon yok" ilkesi, §9).

---

## 6. Muhasebe senkronizasyon mimarisi

### 6.1 Faz 1 — Dışa aktarma tabanlı (önerilen ilk somut teslim)

Mevcut `server/services/report-export-service.ts` + `server/exports/excel-exporter.ts` deseni genişletilir:

- Yeni bir export türü: "Muhasebe Fiş Aktarımı" — gelir/gider/tahsilat/ödeme kayıtlarını, yaygın masaüstü muhasebe yazılımlarının (Logo/Mikro/Netsis/Luca/Zirve) fiş içe aktarma şablonlarına yakın, yapılandırılabilir sütun eşlemesiyle üretir.
- **Hesaplama tekrarlanmaz** — mevcut rapor servislerinin (`getCashFlowReport`, dashboard toplamları) DTO'ları biçimlendirilir, YF-405'teki ilke birebir uygulanır.
- Kategori/müşteri/tedarikçi eşleme tablosu (bkz. §7) yalnızca **etiket/kod dönüşümü** için kullanılır (ör. YapiFin kategorisi → muhasebecinin kullandığı hesap kodu); bu eşleme organizasyon bazında opsiyonel bir yapılandırmadır, zorunlu değildir.

### 6.2 Faz 2 (gelecek, ayrı iş kararı gerektirir) — API tabanlı senkronizasyon

Yalnızca somut bir hedef platform (muhtemelen Paraşüt, en olgun bulut-native aday) için iş gerekçesi netleşirse:

- **Yön:** Başlangıçta tek yönlü (YapiFin → muhasebe platformu), çünkü YapiFin "source of truth" ilkesini korumalıdır (§9). İki yönlü senkronizasyon (ör. muhasebe platformunda girilen bir ödemenin YapiFin'e yansıması) yalnızca kullanıcı onayına bağlı, açık bir "içe aktar/eşleştir" akışıyla yapılmalı — otomatik mutasyon yok.
- **Senkronizasyon birimi:** Müşteri/tedarikçi (cari), kategori (hesap planı eşlemesi), gelir/gider (fatura/fiş), tahsilat/ödeme.
- **Checkpoint modeli:** Her `IntegrationConnection` için kaynak tipi bazında (`customer`, `transaction`, `settlement`) son senkronize edilen `updatedAt`/cursor değeri (`IntegrationSyncCheckpoint`, bkz. §7).
- **Çakışma çözümü:** YapiFin tarafı her zaman kazanır (source of truth ilkesi); harici platformda yapılan bir değişiklik yalnızca kullanıcının açıkça başlattığı bir "harici değişikliği incele" akışıyla YapiFin'e yansıtılabilir, hiçbir zaman sessizce üzerine yazılmaz.

---

## 7. Önerilen veri modeli eklemeleri (yalnızca tasarım — migration yok)

Tüm yeni tablolar mevcut kuralı izler: `organizationId` zorunlu ve indekslenir, hard delete yok (durum/iptal alanları), audit log entegrasyonu.

| Model (taslak adı) | Amaç | Ana alanlar (taslak) |
|---|---|---|
| `IntegrationConnection` | Organizasyon başına sağlayıcı bağlantı yapılandırması | `organizationId`, `providerType` (`E_INVOICE_NILVERA`, `ACCOUNTING_PARASUT` vb.), `environment` (`SANDBOX/PRODUCTION`), `status` (`INACTIVE/ACTIVE/SUSPENDED`), `externalCompanyId` nullable, `createdById`, zaman damgaları |
| `IntegrationCredential` | Şifreli kimlik bilgisi referansı | `connectionId`, `encryptedPayload` (AES-256-GCM, envelope encryption — bkz. §8), `keyVersion`, **asla düz metin sır alanı yok** |
| `EInvoiceDocument` | Gönderilen/alınan e-belge kaydı | `organizationId`, `connectionId`, `direction` (`OUTBOUND/INBOUND`), `docType` (`E_FATURA/E_ARSIV/E_IRSALIYE`), `ettn` unique, `transactionId` **nullable** (bkz. aşağı), `status`, `rawDocumentStorageKey`, `providerDocumentId`, `issuedAt`, zaman damgaları |
| `IntegrationEventLog` | Her dış API çağrısının/webhook olayının denetim izi | `organizationId`, `connectionId`, `eventType`, `httpStatus` nullable, `requestId`/`idempotencyKey`, `errorSummary` (asla ham sır/tam payload değil), `createdAt` |
| `IntegrationSyncCheckpoint` | Artımlı senkronizasyon imleci (Faz 2) | `connectionId`, `resourceType`, `lastSyncedCursor`, `lastSyncedAt` |
| `ExternalEntityMapping` | Müşteri/tedarikçi/kategori ↔ harici sistem kimliği eşlemesi | `organizationId`, `connectionId`, `internalEntityType` (`CUSTOMER/SUPPLIER/CATEGORY`), `internalEntityId`, `externalEntityId`, unique(`connectionId`,`internalEntityType`,`internalEntityId`) |

### Çekirdek finansal modellere EKLENMEMESİ gereken alanlar

- `FinancialTransaction`, `Settlement`, `AccountMovement`, `AccountTransfer` üzerine **doğrudan** `ettn`, `externalInvoiceId`, `providerStatus` gibi alanlar **eklenmemelidir**. Gerekçe:
  1. İlişki isteğe bağlı ve gelişebilir olmalı (bir gelir kaydının sıfır, bir veya — iade/düzeltme senaryolarında — birden fazla ilişkili e-belgesi olabilir); bu, ayrı bir tablo + FK ile doğal şekilde modellenir.
  2. Çekirdek defter şeması, entegrasyona özgü alanlarla kirletilmemelidir — `docs/ARCHITECTURE.md`'nin katman ayrımı ve "finansal işlem servis katmanının tek doğruluk kaynağı olması" ilkesiyle tutarlı.
  3. Sağlayıcı değişirse (ör. Nilvera'dan başka bir entegratöre geçiş) çekirdek şema etkilenmemelidir.
- **Kimlik bilgisi/sır hiçbir zaman** `IntegrationConnection` üzerinde düz metin olarak, audit log `before`/`after` JSON'unda, veya konsol/monitoring loglarında yer almamalıdır (bkz. §8).
- Ham XML/PDF belge içeriği **DB blob'u olarak değil**, mevcut `Document` modelinin `storageKey` desenine benzer şekilde nesne depolamada (S3 uyumlu, `.env.example`'daki `S3_*` değişkenleri zaten iskelet halinde mevcut) saklanmalıdır.

---

## 8. Güvenlik modeli

- **Kimlik bilgisi şifreleme:** Şu an projede herhangi bir şifreleme/KMS kütüphanesi yok — bu **yeni bir yetenek** olarak eklenmelidir. Öneri: `lib/env.ts`'e `AUTH_SECRET` ile aynı disiplinde ayrı bir `INTEGRATION_ENCRYPTION_KEY` (production'da placeholder/kısa değer reddi, `envSchema.superRefine` ile), Node'un yerleşik `crypto` modülüyle AES-256-GCM envelope encryption. `AUTH_SECRET` bu amaçla **yeniden kullanılmamalı** (farklı tehdit modeli, farklı rotasyon ihtiyacı).
- **Loglama disiplini:** `writeAuditLog` çağrılarında ve `IntegrationEventLog` kayıtlarında **hiçbir zaman** ham kimlik bilgisi, tam webhook payload'ı veya tam API isteği/yanıtı yazılmaz — yalnızca bağlantı kimliği, olay tipi, HTTP durumu ve insan-okunur özet. Bu, mevcut projede zaten gözlemlenen "ham Prisma nesnesi asla loglanmaz" disiplininin genişletilmesidir.
- **Webhook kimlik doğrulama:** Sağlayıcı imza doğrulaması (HMAC, varsa) tercih edilir; yoksa paylaşılan sır + IP allowlist. Replay koruması: (`connectionId`, `providerEventId`) üzerinde unique kısıt + zaman damgası penceresi.
- **Idempotency:** Mevcut `Settlement.idempotencyKey`/`AccountTransfer.idempotencyKey` deseni (unique kolon + Prisma `P2002` yakalama) hem kullanıcı tarafından tetiklenen gönderimler hem de gelen webhook/polling olayları için **birebir yeniden kullanılır**.
- **PII:** TCKN/VKN zaten `Customer`/`Supplier` modellerinde var; e-belge XML'i bu verileri taşıyacağından erişim kontrollü depolama (organizasyon bazlı, imzalı URL) zorunludur.
- **Saklama:** Kesin süre **[D]** (§2) olduğundan, mimari **en az 10 yıllık değişmez (WORM tarzı, ör. object-lock) saklama** varsayımıyla tasarlanmalı, mali müşavir teyidiyle kesinleştirilmelidir. Aşırı saklama, yetersiz saklamadan daha güvenli bir varsayılan konumdur.
- **Sağlayıcı kesintisi:** Giden gönderim her zaman kullanıcı tarafından tetiklenen bir eylemdir; kesinti anında sınırlı sayıda yeniden deneme (exponential backoff) + `FAILED`/`PENDING_RETRY` durumu kullanıcıya açıkça gösterilir — asla sessizce "başarılı" varsayılmaz. Gelen tarafta (polling/webhook) checkpoint tabanlı yakalama, kesinti sonrası kayıp olmadan devam etmeyi sağlar.

---

## 9. Tenant izolasyon modeli

- Tüm yeni tablolar `organizationId` taşır ve mevcut kuralı izler: her sorgu `id + organizationId` birlikte filtrelenir (fail-closed).
- `IntegrationConnection` organizasyon başına sağlayıcı tipine göre benzersizdir (`unique(organizationId, providerType, environment)` önerisi).
- **Webhook uç noktası tenant çözümlemesi istemciden gelen bir `organizationId`'ye asla güvenmemelidir.** Uç noktanın kendisi bağlantıya özgü olmalı (ör. `/api/integrations/webhooks/:connectionId`), gelen isteğin `connectionId`'si DB'de çözülür ve o bağlantının `organizationId`'si kullanılır — payload içindeki hiçbir alan organizasyon kararını etkilemez.
- Mevcut PROJECT_MANAGER kapsam daraltma ilkesiyle tutarlı olarak, entegrasyon yönetimi (bağlantı kurma/kimlik bilgisi görüntüleme) yalnızca OWNER/ADMIN'e açık olmalı (öneri — `canManageOrganizationSettings` ile aynı ilke); FINANCE rolü yalnızca senkronizasyon/dışa aktarma **tetikleme** ve durum **görüntüleme** yetkisine sahip olabilir.

---

## 10. Idempotency/retry stratejisi

- **Kullanıcı tetiklemeli gönderimler:** İstemci her form render'ında yeni bir `idempotencyKey` üretir (mevcut `crypto.randomUUID()` deseni, ör. tahsilat formu) — mükerrer gönderim aynı anahtarla gelir, unique kısıt ihlali yakalanır, orijinal sonuç idempotent döner.
- **Gelen webhook/polling:** (`connectionId`, `providerEventId` veya `ettn`) üzerinde unique kısıt; tekrar eden teslimat yeni satır oluşturmaz, mevcut kaydı günceller/no-op yapar.
- **Retry politikası:** Sınırlı sayıda deneme (öneri: 5, exponential backoff), her deneme `IntegrationEventLog`'a yazılır; son denemeden sonra `DEAD_LETTER` durumuna geçer ve yöneticiye görünür hale gelir — sonsuz sessiz retry döngüsü yok.
- **Not:** Repo'da bugün hiçbir zamanlanmış görev/kuyruk altyapısı yok (§3). Polling tabanlı bir gelen belge akışı seçilirse, bu **yeni bir altyapı bileşeni** (ör. periyodik iş çalıştırıcı) gerektirir ve bu, YF-605-C'nin kapsamına açıkça dahil edilmelidir — mevcut mimaride örtük olarak var sayılmamalıdır.

---

## 11. Gözlemlenebilirlik/audit gereksinimleri

- Her `EInvoiceDocument` durum geçişi hem `IntegrationEventLog` (teknik detay) hem `AuditLog` (iş olayı — `writeAuditLog` üzerinden, ör. `einvoice.submit`, `einvoice.status_change`, `einvoice.cancel`) kaydı üretir.
- Sistem tetiklemeli olaylar (webhook/polling) için `actorId: null` + açık `action` etiketi kullanılır (mevcut `AuditLog.actorId nullable` şemasıyla uyumlu).
- Mevcut Sentry/monitoring altyapısı (`lib/monitoring`, YF-512) yeniden kullanılır — entegrasyon hataları için ayrı bir izleme yığını kurulmaz; sağlayıcı kimlik bilgileri monitoring breadcrumb/context'lerine asla eklenmez.

---

## 12. Sağlayıcı seçim kriterleri

1. API olgunluğu ve dokümantasyon kalitesi (self-servis geliştirici portalı > kapalı/talep-bazlı erişim)
2. Kimlik doğrulama modeli (OAuth2/Bearer tercih edilir; eski SOAP+paylaşımlı-parola modelleri daha yüksek entegrasyon riski taşır)
3. Ayrı sandbox/test ortamı ve izole test kimlik bilgileri
4. Webhook desteği + imza doğrulama (yoksa polling + checkpoint modeli gerekir)
5. İnşaat sektörü kapsamı: e-İrsaliye ve İDİS alan gereksinimlerini destekliyor mu
6. Fiyatlandırma modeli ve YapiFin'in çok-kiracılı (multi-tenant) yapısına uygunluğu (kiracı başına ayrı sözleşme mi, YapiFin şemsiye sözleşmesi mi — **[D]**, ticari karar)
7. Türkiye pazarında kanıtlanmış operasyonel geçmiş

Bu araştırmada **Nilvera** dokümantasyon kalitesi ve modern kimlik doğrulama modeli açısından öne çıkmıştır, ancak bu bir tedarikçi taahhüdü değildir — sandbox denemesi (YF-605-B) öncesi ticari görüşme ve birincil API referansının tam okunması gerekir.

---

## 13. Uygulama fazları (önerilen ClickUp görevleri)

| Görev | Kapsam | Bağımlılık |
|---|---|---|
| **YF-605-A** — Provider-nötr entegrasyon temeli | `IntegrationConnection`/`IntegrationCredential`/`IntegrationEventLog` modelleri + migration; `INTEGRATION_ENCRYPTION_KEY` altyapısı (`lib/env.ts` genişletmesi); yetki matrisi (yalnızca OWNER/ADMIN bağlantı yönetir); boş CRUD admin ekranı. **Gerçek sağlayıcı çağrısı yok.** | Bu doküman |
| **YF-605-B** — İlk e-belge sağlayıcı sandbox adaptörü | `EInvoiceProvider` arayüzü + tek somut adaptör (öneri: Nilvera test ortamı); yalnızca `lookupTaxpayer` + `getDocumentStatus` (salt okunur, belge göndermeden doğrulama) | YF-605-A |
| **YF-605-C** — Gelen e-belge akışı | Polling veya webhook (altyapı ihtiyacı netleştirilmeli, bkz. §10); `EInvoiceDocument` (INBOUND) oluşturma; ham XML immutable storage; **el ile** mevcut `FinancialTransaction` ile eşleştirme ekranı — otomatik mutasyon yok | YF-605-B |
| **YF-605-D** — Giden e-belge akışı | Gelir kaydından taslak oluşturma; mükellef sorgusu ile e-Fatura/e-Arşiv dallanması; gönderim; durum takibi; iptal/itiraz UI'ı | YF-605-B |
| **YF-605-E** — Muhasebe dışa aktarma genişletmesi | Mevcut export altyapısı üzerine "Muhasebe Fiş Aktarımı" formatı; `ExternalEntityMapping` (kategori/cari eşleme, opsiyonel) | Bağımsız — YF-605-A/B/C/D'den ayrı paralel yürütülebilir |
| **YF-605-F** (opsiyonel, gelecek) — Bulut muhasebe API senkronizasyonu | Yalnızca iş gerekçesi netleşirse (§2.2); `AccountingIntegrationProvider` sözleşimi + tek somut hedef (öneri: Paraşüt) | YF-605-E + ayrı iş kararı |

Her görev, mevcut projedeki gibi küçük, test edilebilir commit kapsamlarına bölünmelidir (CLAUDE.md §"Zorunlu çalışma biçimi" madde 7).

---

## 14. Test stratejisi

Mevcut repo deseniyle tutarlı üç katman:

1. **Servis katmanı testleri** (gerçek disposable Postgres, `tests/helpers.ts` desenleri) — tenant/rol izolasyonu, idempotency (mükerrer webhook/gönderim), durum geçiş kuralları, audit log içeriği (sır sızmadığının doğrulanması).
2. **Sağlayıcı adaptör testleri** — gerçek sandbox'a karşı **yalnızca CI dışı/manuel** çalıştırılan sözleşme testleri (kayıtlı fixture/cassette tabanlı testler CI'da); **production sağlayıcıya asla CI'dan istek atılmaz**.
3. **Entegrasyon/route testleri** — mevcut `tests/report-export-integration.test.ts` deseniyle aynı şekilde gerçek `next start` + webhook imza doğrulama, yetkisiz erişim (401/403), cross-tenant izolasyon (404).

Özellikle test edilmesi gerekenler (CLAUDE.md ile uyumlu):
- Başka organizasyonun `IntegrationConnection`/`EInvoiceDocument` kaydına erişim engeli
- Mükerrer webhook teslimatının ikinci kaydı oluşturmadığı
- Sağlayıcı hatasının finansal kaydı **hiçbir zaman** otomatik değiştirmediği
- Kimlik bilgisinin hiçbir log/audit/hata mesajında düz metin görünmediği

---

## 15. Rollout/feature-flag stratejisi

- Repo'da bugün genel bir feature-flag sistemi yok. Öneri: `IntegrationConnection.status` varsayılan `INACTIVE` — modül organizasyon bazında **opt-in**'dir, global bir anahtar eklenmez.
- İlk sürümler yalnızca dahili/pilot organizasyonlarda (öneri: OWNER hesabında manuel aktivasyon) denenmeli; genel kullanıcı kitlesine açılmadan önce YF-605-B/C/D'nin gerçek sandbox verisiyle doğrulanması gerekir.
- Bu epik, `docs/PRODUCT_REQUIREMENTS.md` §7'nin "MVP dışı" listesini güncelleyecek bir ürün kararı gerektirir — bu doküman o kararı almaz, yalnızca mimariyi hazırlar.

---

## 16. Çözülmemiş sorular (profesyonel teyit gerektirir)

1. 2026 için güncel e-Fatura/e-Arşiv eşikleri kesinleşti mi (taslak tebliğ durumu)?
2. "İnşa" faaliyeti tanımı YapiFin'in farklı müşteri profillerine (genel yüklenici/taşeron/tedarikçi) tam olarak nasıl uygulanır?
3. Genel yüklenicinin kendi şantiyeleri arası malzeme taşıması e-İrsaliye'ye tabi mi?
4. İDİS teknik kılavuzunun tam içeriği ve kesin aktivasyon tarihi nedir?
5. Saklama süresi VUK (5 yıl) mı TTK (10 yıl) mı, yoksa ikisinin daha katı olanı mı esas alınmalı?
6. GİB'in birincil "Sistem Yanıtı Şema" belgesindeki durum kodları, bu dokümandaki blog-kaynaklı tabloyla birebir örtüşüyor mu?
7. Seçilecek entegratörün (öneri: Nilvera) webhook imza doğrulama ve idempotency sözleşmesi tam olarak nedir (birincil API referansından okunmalı)?
8. Mikro/Logo/Netsis API erişimi için gerçek maliyet/onay süresi nedir (bu araştırmada teyit edilemedi)?
9. Paraşüt'ün 2026 itibarıyla erişim süreci tam self-servis mi, hâlâ manuel talep mi?
10. YapiFin'in kendisinin özel entegratör olma maliyeti (sermaye şartı dahil) güncel olarak ne kadar ve bu iş kararı olarak yeniden değerlendirilmeli mi?

---

## 17. Açık kapsam dışı kararlar (non-goals)

- YapiFin'in GİB nezdinde sertifikalı özel entegratör olması — açıkça hariç (§1, §2).
- Genel bir ERP/muhasebe/bordro/stok ürününe dönüşüm — `docs/PRODUCT_REQUIREMENTS.md` §7 ve CLAUDE.md madde 10 ile tutarlı şekilde hariç.
- Masaüstü ERP'lerle (Logo/Mikro/Netsis) gerçek zamanlı iki yönlü tam defter senkronizasyonu — MVP-sonrası ilk fazlarda hariç; yalnızca somut bir kurumsal müşteri talebiyle, ayrı bir hizmet kalemi olarak değerlendirilebilir.
- Harici bir belge/senkronizasyon olayının tek başına mevcut finansal kaydı otomatik değiştirmesi — her zaman kullanıcı onayı gerekir.
- OCR/yapay zekâ tabanlı belge okuma — mevcut MVP dışı listesiyle tutarlı, bu doküman kapsamında değil.
- Birden fazla sağlayıcı için aynı anda üretim entegrasyonu — önce tek sağlayıcı uçtan uca kanıtlanmadan çoklu-sağlayıcı soyutlaması genişletilmez.
- Bu fazda gerçek üretim entegrasyon kodu, migration veya bağımlılık eklenmesi — bu doküman yalnızca mimaridir.

---

## Ek: Danışılan kaynaklar

**e-Belge araştırması:** GİB portalları (ebelge.gib.gov.tr, kısmi erişim), VUK Genel Tebliği Sıra No. 509 ve ilişkili tebliğler (ikincil doğrulama), İDİS mevzuatı (Resmî Gazete No. 32134), TTK itiraz kuralı, `developer.nilvera.com` (doğrudan alındı), Uyumsoft/İzibiz/Sovos entegratör dokümantasyonu (ikincil), çeşitli mali müşavirlik/entegratör blog kaynakları (Sovos Türkiye, Token, TÜRMOB, çeşitli muhasebe danışmanlık siteleri).

**Muhasebe entegrasyonu araştırması:** `apidocs.mikro.com.tr` (doğrudan alındı), `bizimhesap.com/destek` (doğrudan alındı), Logo/Netsis entegratör dokümantasyonu (ikincil), `github.com/parasutcom/api-doc`, FinTech İstanbul (Paraşüt sahiplik doğrulaması), Odoo Türkiye topluluk modülleri (GitHub).

Tüm birincil olmayan kaynaklar metin içinde **[B]**/**[C]**/**[D]** etiketleriyle işaretlenmiştir; bu doküman yasal görüş yerine geçmez.
