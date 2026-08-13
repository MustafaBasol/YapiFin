# YF-705 — AI Nakit Akışı Senaryo ve Risk Tahmini

Bu doküman YF-705 uygulanırken alınan mimari kararları belgeler.

Kaynak dosyalar:

- `server/services/cash-flow-scenario-math.ts` (saf çekirdek, DB'siz)
- `server/services/cash-flow-scenario-drivers.ts` (saf risk sürücüleri)
- `server/services/cash-flow-scenario-service.ts` (sorgular, kapsam, AI)
- `lib/ai/cash-flow-scenario/{schema,prompt}.ts`
- `app/api/ai/cash-flow-scenarios/route.ts`
- `components/app/cash-flow-scenario-panel.tsx`, `app/(app)/cash-flow-scenarios/page.tsx`

## 1. Katman sırası — LLM finansal gerçeğin kaynağı DEĞİLDİR

```
DETERMİNİSTİK MOTOR → YAPILANDIRILMIŞ SENARYO OLGULARI → AI AÇIKLAMASI
→ DOĞRULANMIŞ ÇIKTI → ARAYÜZ
```

Model yanıt şemasında (`cashFlowScenarioModelResponseSchema`) **tek bir
sayısal, parasal, tarihsel, oransal veya önem derecesi alanı yoktur**. Model
yalnızca (a) serbest metin ve (b) sunucunun önceden verdiği `scenarioKey` /
`driverId` anahtarlarına atıf üretebilir. Bilinmeyen `driverId` sessizce
düşürülür (`mergeScenarioNarrative`). Bu, YF-702/YF-704'ün `mergeHighlights`
deseninin birebir karşılığıdır ve güvenliğin taşıyıcı unsurudur — istem
metnindeki "sayı uydurma" talimatı yalnızca ikincil savunmadır.

## 2. 30/60/90 ufuk semantiği

```
todayStart = startOfIstanbulDay(now)
window(N)  = [ todayStart , addIstanbulDays(todayStart, N) )      // YARI AÇIK
```

Bugünden itibaren yuvarlanan (rolling), takvime hizalanmamış pencereler.
`N` bir **süre**dir, son dahil edilen gün indeksi değildir: 30 günlük pencere
gün indeksi 0…29'u kapsar, **N. gün hariçtir**.

Bu, `resolveCashFlowRange`'in (`cash-flow-report-service.ts:181-188`)
`NEXT_30_DAYS`/`NEXT_90_DAYS` tanımıyla **birebir aynıdır**.

**Neden vade kovası (`buildMaturityBoundaries`) semantiği KULLANILMADI:**
kod tabanında iki farklı "30 gün" vardır — `resolveCashFlowRange` 30 günlük
(`todayStart+30`), vade kova merdiveni ise 31 günlük (`todayStart+31`, çünkü
"bugün" ayrı bir kovadır). Kova merdiveni bir *yaşlandırma* aracıdır, nakit
penceresi aracı değildir. Nakit penceresi semantiği seçilerek aynı üründe
ikinci, sessizce farklı bir "önümüzdeki 30 gün" sayısı üretilmesi önlenmiştir.

## 3. Açılış nakdi

`getOrganizationCashBalance(db, organizationId)` (`ledger.ts:105-114`) aynen
yeniden kullanılır: tüm `isActive` hesapların `AccountMovement` CREDIT−DEBIT
farkı. Dokuz hücrenin tamamında **aynıdır** — senaryolar yalnızca zamanlama
kaydırır, ölçülmüş bir bakiyeyi geriye dönük değiştiremez.

**Bilinerek devralınan davranış:** bu formül hesap TÜRÜNE göre filtrelemez;
`CREDIT_CARD` (yükümlülük) hesapları da açılış nakdine dahildir. Filtrelemek,
aynı ekran ailesinde (YF-401 dashboard, YF-403 nakit akışı raporu) **üçüncü**
bir "nakit" tanımı yaratırdı. Hatanın yönü tutucudur — kart borcu `DEBIT`
hareketi olarak nakdi azaltır, dolayısıyla kırılma tarihini **erkene** alır,
geciktirmez. Kullanıcıya `CREDIT_CARD_IN_OPENING_CASH` varsayımıyla açıkça
bildirilir (yalnızca aktif kredi kartı hesabı varsa).

## 4. Senaryo varsayımları

Tümü **zamanlama** varsayımıdır; hiçbiri tutar/oran varsayımı değildir ve
hiçbiri var olmayan bir gelir/gider eklemez.

| Senaryo | Tahsilat gecikmesi | Ödeme ötelemesi | İş kuralı |
|---|---|---|---|
| BASE | 0 | 0 | Tüm tahsilat ve ödemeler kayıtlı vade tarihinde gerçekleşir. |
| RISK | **30 gün** | 0 | Her tahsilat bir tam vade dönemi gecikir; ödemeler vadesinde yapılır. |
| OPTIMISTIC | 0 | **15 gün** | Ödemeler yarım vade ötelenir; tahsilatlar vadesinde ve aynı tutarda kalır. |

**Neden 30/15, YF-403'ün 7 günü değil:** 7 günlük kaydırma 30 günlük bir rapor
için ölçeklenmiştir ve uzun ufukta sönümlenir — düzgün dağılmış bir alacak
defterinde 7 gün, 30 günlük pencereden ~%23'ünü çıkarırken 90 günlük
pencereden yalnızca ~%8'ini çıkarır. 60/90 hücrelerinde RISK ≈ BASE olur ve
senaryolar tam da en bilgilendirici olmaları gereken yerde görsel olarak
birbirine yapışır. 30 gün Türkiye B2B/inşaat pratiğinde kanonik bir tam vade
dönemidir. İyimser tarafta 15 gün (yarım vade) kasıtlı olarak asimetriktir:
tüm borçların (maaş/vergi benzeri kalemler dahil) tek taraflı 30 gün
ötelenmesi inandırıcı değildir, ve kendi ödemenizde sınırlı kontrolünüz varken
müşteri tahsilat disiplininde hiç yoktur.

Sabitler `CASH_SCENARIO_DELAY_DAYS` içinde tek bir yerde tanımlıdır.

**İyimser senaryo GELİR UYDURAMAZ — yapısal garanti:** `δin(OPTIMISTIC) = 0`
olduğundan gelir yüklemi BASE ile bayt bayt aynıdır, dolayısıyla
`expectedCollections(OPTIMISTIC, N) === expectedCollections(BASE, N)` her ufuk
için testle sabitlenmiştir. İyimser senaryo yalnızca gider yüklemini ve
yalnızca pencereden kayıt ÇIKARACAK yönde değiştirir. Negatif kaydırma kod
düzeyinde yasaklıdır.

## 5. Kırılma tarihi

```
cum[-1] = openingCash
cum[d]  = cum[d-1] + inflow[d] − outflow[d]      // Istanbul günü SONU bakiyesi
breakDayIndex = açılışta negatifse -1, değilse ilk (cum[d] < 0) günü, yoksa null
```

- **Kesin `< 0`.** Tam sıfır bakiye ödeme gücüdür, kırılma değildir. `Decimal`
  karşılaştırması tam olduğundan bu saf bir anlam kararıdır.
- **Açılışta zaten negatifse `-1` işaretçisi** ve `alreadyNegativeAtOpening =
  true`. `null` dönmek tehlikeli biçimde yanlış olurdu; `0` dönmek ise "akışlar
  bugün seni kırıyor" ile "zaten kırıksın" durumlarını karıştırırdı.
- **Ön ek değişmezi:** 30 günde bulunan kırılma 60 ve 90'da aynı kalır (30, 90
  serisinin ön ekidir).
- Günlük granülerlik seçilmiştir: aylık (`buildMonthlyProjection`) 5. günde
  kırılıp 25. günde toparlanan bir açığı göremez, olay bazlı granülerlik ise
  `dueDate` gün içi sıra taşımadığı için var olmayan bir kesinlik uydurur.

**Minimum nakit adaylarına açılış anı (`d = -1`) dahildir** — aksi halde tüm
akışların pozitif olduğu bir senaryoda "minimum nakit", organizasyonun bugün
fiilen elinde tuttuğu tutardan yüksek raporlanırdı.

## 6. Mükerrer sayım korumaları

| Yol | Koruma |
|---|---|
| Tahakkuk ve tahsilat | Yalnızca `remaining = totalAmount − Σ(aktif settlement)` toplanır; `Settlement` asla giriş olarak EKLENMEZ, yalnızca çıkarır. |
| Settlement fan-out | Settlement alt sorguda ÖNCEDEN toplanır (`GROUP BY "transactionId"`). Düz `LEFT JOIN` satırı çoğaltıp `totalAmount`'ı katlardı — bu görevin en olası hatası; test: 100.000 + 3×10.000 aktif settlement → 70.000 (210.000 değil). |
| İptal / ters kayıt | `ft.status <> 'CANCELLED'` + `Settlement.status = 'ACTIVE'`. |
| Vadesi geçmiş ve gelecek kova | Satır başına TEK `bucketDay` skaleri. `overdue*Included` bir *raporlama alt kümesidir*, hiçbir toplama eklenmez. |
| Transfer | Yapısal: `AccountTransfer` ne `FinancialTransaction` ne `Settlement` yazar. |
| Bayat `status` | `status IN (...)` KULLANILMAZ; açıklık `remaining > 0` ile türetilir. |
| Ufuklar arası | 30/60/90 **iç içe kümülatiftir**, toplanabilir dilim değildir — arayüzde asla `30 + 60 + 90` sunulmaz. |

## 7. Vadesi girilmemiş kayıtlar

`dueDate IS NULL` olan kayıtlar zaman çizelgesine yerleştirilemez ve tahminden
**tamamen hariç** tutulur. `issueDate`, "bugün" veya uydurma bir vade koşulu
(ör. "+30 gün") **kullanılmaz** — `Customer`/`Supplier`/`Project`/
`Organization` üzerinde ödeme vadesi alanı yoktur, bir varsayılan saf uydurma
olurdu. Hariç tutulan tutar ve adet ayrı bir sorguyla ölçülür,
`NULL_DUE_DATE_EXCLUDED` varsayımı ve bir `dataCoverage` girdisiyle
kullanıcıya ve isteme bildirilir.

## 8. Yetkilendirme ve nakit görünürlüğü

Kapsam istek başına **tek kez** `resolveActorReportScope` ile çözülür;
`getCashFlowScenariosWithScope` gövdeye girmeden önce
`assertResolvedScopeForActor` ile kapsamın kanonik çözümleyiciden geldiğini ve
bu aktöre ait olduğunu kanıtlar ("zaten güvenli bir yerden çağrılıyor"
istisnası tanınmaz).

**Nakit çapalı alanlar** (`openingCash`, `endingCash`, `minimumCashPoint`,
`breakDate`) YALNIZCA `scope === "ORGANIZATION"` **ve** `projectFilter === null`
iken üretilir; aksi halde `null` olur ve `cashUnavailableReason` nedeni taşır:

- `PROJECT_MANAGER_NO_CASH_VISIBILITY` — `canViewCashAndBank` PM'i dışlar
  (`lib/permissions.ts:15-16`); PM akışları görür, nakit bakiyesini görmez.
  Bu, `ProjectManagerCashFlowReport`'un alan bazında yokluk sözleşmesiyle
  aynı ilkedir.
- `PROJECT_FILTER_SCOPED` — kasa/banka bakiyesi organizasyon geneli bir
  ölçüdür; proje filtreli akışlarla birleştirilirse anlamsız bir "bu projenin
  kapanış nakdi" sayısı üretir. Aynı kural YF-704'te de uygulanır
  (`management-summary-service.ts:308-327`).

**Fail-closed:** atanmış projesi olmayan PROJECT_MANAGER için organizasyon
geneline düşülmez; hiçbir finansal sorgu çalıştırılmadan boş tahmin döner ve
sağlayıcı çağrılmaz.

**Sessiz geri düşüş sözleşmesi korunur:** yetkisiz veya başka tenant'a ait
`projectId` hata DEĞİLDİR — filtre düşer, aktör kendi kapsamında kalır
(`resolveActorReportScope` sözleşmesi). İstenen projenin verisi sızmaz.

## 9. Risk sürücüleri

Yedi deterministik tür: `PROJECTED_CASH_BREAK`,
`NEGATIVE_PROJECTED_ENDING_CASH`, `CASH_BUFFER_EROSION`,
`OVERDUE_RECEIVABLE_EXPOSURE`, `OVERDUE_PAYABLE_EXPOSURE`,
`NEAR_TERM_PAYABLE_CONCENTRATION`, `RECEIVABLE_CONCENTRATION`.

**Yeni eşik İCAT EDİLMEZ.** Önem derecesi gereken her yerde YF-702'nin zaten
belgelenmiş `InsightThresholds` değerleri yeniden kullanılır
(`cashProjectionWarningRatio`, `overdueReceivableHighRatio`,
`collectionPaymentImbalance*`, `expenseConcentration*`). Sıralama bir eşik
değil, `Decimal.comparedTo` ile tutar büyüklüğüdür.

**Türe göre tekilleştirme zorunludur:** sürücüler dokuz hücrenin her biri için
üretilir, dolayısıyla aynı risk en fazla dokuz kez görünebilir. Tekilleştirme
olmadan tek bir tür listeyi doldurur ve daha kritik ama tek örnekli bir tür
(kırılma tarihi) listeden taşar. Her tür için en kötü örnek saklanır (en
yüksek önem → en büyük tutar → en KISA ufuk).

**Neden YF-702 kuralları yeniden çalıştırılmıyor:** YF-702 kuralları
tamamlanmış bir DÖNEMİ ("geçen hafta ne oldu") değerlendirir; YF-705 bir
ÖNGÖRÜ UFKUNU ve BİR SENARYOYU ("tahsilatlar 30 gün gecikirse ne olur")
değerlendirir. Kanıt tabanları farklıdır. Ayrıca yeniden çalıştırmak bütçe +
marj + settlement servislerini çağırmayı gerektirir ve bilinen YF-702-TD1
mükerrer nakit akışı SQL yükünü bu göreve taşırdı. Bütçe aşımı ve marj
bozulması sessizce atlanmaz — `dataCoverage` ile açıkça kapsam dışı bildirilir.

## 10. Yetki, kota ve sorgu bütçesi

`ai.features` şemsiye yeteneği, ağır sorgulardan ÖNCE fail-closed doğrulanır.
`ai.cash_flow_scenario` kimliği `docs/PLAN_FEATURE_MATRIX.md` §2.3'te tanımlı
olsa da `CAPABILITY_IDS` içinde yoktur; eklenmesi dört kanonik `Plan` satırını
güncelleyen bir migration (yani plan matrisi değişikliği) gerektirir ve bu
görevin kapsamı dışıdır. Plan matrisinde iki kimlik tüm planlarda aynı değere
sahip olduğundan şemsiye kapı bugün birebir aynı erişimi verir; hiçbir
organizasyonun erişimi genişlemez. Aynı gerekçe YF-704 ve Ask YapiFin'de de
uygulanmıştır.

Kota YF-711 motoruyla yönetilir (`requestAiCompletion`): rezervasyon sağlayıcı
çağrısından ÖNCE, commit SONRA. **Vade tarihli açık kayıt yoksa sağlayıcı HİÇ
çağrılmaz ve kota tüketilmez** (`isEmptyForecast`); test `aiUsageLedger`
sayısının 0 kaldığını doğrular. Uç nokta yalnızca `POST`'tur — `GET`
önbellek/prefetch/bot taraması ile sessizce tetiklenip kota yakabilirdi.

**Sorgu bütçesi sabittir (ölçülen: 21).** Dokuz hücrenin tamamı TEK satır
kümesinden bellek içinde türetilir; senaryo/ufuk/hücre başına sorgu yoktur ve
sorgu sayısı proje sayısıyla ölçeklenmez. Naif alternatif 3 × 3 × 2 = 18
toplama sorgusu, proje bazlı varyantı `18 + N` olurdu.
`ft."dueDate" < end90` sınırı ispatlıdır: `dueDate + δ < end_N` ⇔
`dueDate < end_N − δ` ve tüm `δ ≥ 0`, `N ≤ 90` için `end_N − δ ≤ end_90`.

## 11. Bilinen sınırlamalar (kabul edilmiş)

- `CREDIT_CARD` hesapları açılış nakdine dahildir (§3) — YF-403/YF-401 ile
  tutarlı, tutucu yönde, kullanıcıya bildirilir.
- Farklı para birimleri kur çevrimi yapılmadan toplanır (mevcut yardımcıların
  davranışı devralınır); birden fazla para birimi varsa
  `MULTI_CURRENCY_NOT_CONVERTED` bildirilir.
- Onaylanmamış hakedişler (DRAFT/SUBMITTED) `FinancialTransaction`
  üretmedikleri için tahminde yer almaz; varsayım olarak bildirilir.
- Karşı taraf bazlı gecikme geçmişi (ortalama gecikme günü) uygulamada hiç
  tutulmadığından senaryo gecikmeleri veriden türetilmez, açıkça belgelenmiş
  iş kurallarıdır.
