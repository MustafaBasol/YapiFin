# Teknik Mimari

## 1. Mimari yaklaşım

İlk sürüm için modüler monolit önerilir. Tek deploy edilebilir uygulama içinde alanlar net modüllere ayrılır.

Modüller:

- auth
- organizations
- users
- invitations
- projects
- customers
- suppliers
- categories
- transactions
- payments
- financial-accounts
- transfers
- budgets
- reports
- audit
- notifications

## 2. Katmanlar

- UI: Next.js App Router, server/client component ayrımı
- Application: use-case/service katmanı
- Domain: finansal iş kuralları
- Data: Prisma repository erişimi
- API: Route handlers veya server actions

Route handler içinde doğrudan karmaşık Prisma işlemi yazılmamalıdır. Finansal işlemler transaction destekli service katmanında olmalıdır.

## 3. Tenant izolasyonu

- Tüm tenant tablolarında `organizationId` zorunlu.
- Her request oturumdan `organizationId` alır.
- İstemciden gelen `organizationId` güvenilir kabul edilmez.
- Prisma sorguları organization scope olmadan çalıştırılamaz.
- ID ile kayıt getiren her işlem `id + organizationId` birlikte sorgulamalıdır.
- Proje yöneticisinde ek olarak proje erişim scope kontrolü yapılmalıdır.

## 4. Kimlik doğrulama

- Güvenli parola hash: Argon2id veya bcrypt yüksek maliyet.
- HttpOnly, Secure, SameSite cookie.
- E-posta doğrulaması.
- Davet tokenları hashlenerek saklanmalı.
- Parola sıfırlama tokenları tek kullanımlık ve süreli olmalı.
- Login rate limit uygulanmalı.

## 5. Finansal atomiklik

Aşağıdaki işlemler DB transaction içinde yapılmalıdır:

- Tahsilat oluşturma + hesap hareketi + gelir durum güncellemesi
- Ödeme oluşturma + hesap hareketi + gider durum güncellemesi
- Transfer çıkış hareketi + giriş hareketi
- İptal/ters kayıt işlemleri

Bakiyeler yalnızca türetilmiş ledger hareketlerinden hesaplanabilir veya cache bakiye tutuluyorsa transaction içinde güvenli güncellenmelidir.

## 6. Durum hesaplama

Gelir/gider durumları kullanıcı tarafından keyfî belirlenmemeli; toplam ve ödenen/tahsil edilen tutara göre türetilmelidir:

- OPEN
- PARTIALLY_PAID
- PAID
- OVERDUE
- CANCELLED

`OVERDUE`, vade tarihi geçmiş ve kalan tutar pozitifse uygulanır.

## 7. Dosya yapısı önerisi

```text
src/
  app/
    (auth)/
    (dashboard)/
    api/
  components/
    ui/
    layout/
    finance/
  modules/
    auth/
    organizations/
    projects/
    transactions/
    payments/
    reports/
  lib/
    auth/
    db/
    permissions/
    money/
    dates/
    validation/
  server/
    services/
    repositories/
  types/
prisma/
  schema.prisma
  seed.ts
```

## 8. Para ve tarih

- DB: Decimal(18,2) veya kuruş integer.
- Uygulama içinde JS `number` ile para aritmetiği yapılmamalı.
- Currency alanı MVP'de TRY varsayılan, ileride genişletilebilir.
- Tüm timestamp'ler UTC saklanır.
- UI Türkiye saat dilimi ve `tr-TR` biçimi kullanır.

## 9. Loglama ve gözlemlenebilirlik

- Yapılandırılmış loglar
- Request correlation ID
- Hata izleme entegrasyonuna hazır yapı
- Kritik finans işlemlerinde actorId, organizationId ve entityId loglanmalı
- Hassas veri ve tokenlar loglanmamalı

## 10. Dağıtım

Önerilen başlangıç:

- Docker Compose
- Next.js uygulaması
- PostgreSQL
- Reverse proxy
- Günlük DB yedeği

## 11. Faz 3 uygulama notları — Kasa/Banka, Gelir/Gider, Tahsilat/Ödeme, Transfer

Bu bölüm, EPIC YF-300 uygulanırken netleştirilen mimari kararları belgeler
(`server/services/ledger.ts`, `account-service.ts`, `transaction-service.ts`,
`settlement-service.ts`, `transfer-service.ts`).

- **Ledger/bakiye stratejisi:** `FinancialAccount` üzerinde mutable bir
  bakiye alanı tutulmaz. Bakiye her zaman `AccountMovement` satırlarının
  (`CREDIT` toplamı − `DEBIT` toplamı) türetilmesiyle hesaplanır. Açılış
  bakiyesi de `openingBalance` alanına yazılmakla birlikte, ayrıca `OPENING`
  tipinde denetlenebilir bir hareket olarak kaydedilir; bakiye hesaplaması bu
  hareketten türer, `openingBalance` alanından değil.
- **Negatif bakiye:** MVP'de engellenir (bkz. docs/SECURITY.md §3).
- **Durum türetme:** `FinancialTransaction.status` alanı `OPEN | PARTIALLY_PAID
  | PAID | OVERDUE | CANCELLED` değerlerini saklar ve her tahsilat/ödeme/iptal
  işleminde yeniden hesaplanıp kalıcı olarak güncellenir. `OVERDUE` durumu ek
  olarak **okuma anında** (liste/detay sorgularında) güncel tarihe göre canlı
  türetilir — arka planda vade taramasi yapan bir zamanlanmış görev bu fazda
  yoktur (kapsam dışı); bu nedenle iki gösterim aynı anda tutarlı olsa da,
  DB'deki `status` kolonu bir sonraki mutasyona kadar `OVERDUE`'ye
  geçmeyebilir. Bu bilinen ve kabul edilen bir sınırlamadır.
- **DRAFT durumu yok:** Şemadaki `TransactionStatus` enum'ında (ve bu
  belgenin §6'sında) `DRAFT` bulunmadığından, gelir/gider kayıtları
  oluşturulduğu anda doğrudan `OPEN` olarak postalanır. Taslak/arşiv akışı
  bu fazda uygulanmamıştır; kaldırma yalnızca iptal (ters kayıt) ile
  yapılır.
- **İptal/ters kayıt:** Settlement ve AccountTransfer iptalleri orijinal
  hareketi silmez; aynı `settlementId`/`transferId`'ye bağlı, ters yönlü
  yeni bir `AccountMovement` (`type: REVERSAL`) oluşturur. Aktif tahsilatı/
  ödemesi olan bir gelir/gider kaydı doğrudan iptal edilemez — önce ilgili
  tahsilat/ödeme hareketleri tek tek ters kayıtla düzeltilmeli, ardından
  kayıt iptal edilmelidir. Aynı hareket iki kez ters kayıtla düzeltilemez.
- **Idempotency:** `Settlement.idempotencyKey` ve `AccountTransfer.idempotencyKey`
  alanları `@unique`'dir. İstemci her form render'ında yeni bir anahtar
  üretir (`crypto.randomUUID()`); mükerrer gönderim aynı anahtarla gelir,
  DB'de tekil kısıt ihlali yakalanır ve orijinal kayıt idempotent şekilde
  geri döndürülür.
- **Eşzamanlılık kontrolü:** Kalan tutarı aşan tahsilat/ödeme veya bakiyeyi
  negatife düşüren işlemleri önlemek için, ilgili `FinancialTransaction` ve
  `FinancialAccount` satırları aynı veritabanı işlemi içinde
  `SELECT ... FOR UPDATE` ile kilitlenir (bkz. `server/services/ledger.ts`
  `lockAccount`/`lockTransaction`), kalan tutar/bakiye bu kilit altında
  yeniden okunur. Transferlerde çapraz kilitlenmeyi (deadlock) önlemek için
  iki hesap her zaman `id` sırasına göre kilitlenir — kaynak/hedef rolünden
  bağımsız.
- **Kasa/Banka görünürlüğü:** PROJECT_MANAGER, `FinancialAccount` modülüne
  (liste, detay, transfer) hiç erişemez. Gelir görünürlüğü proje bazlı
  salt-okunurdur (yalnızca atandığı projeye bağlı kayıtlar); oluşturma/
  düzenleme/iptal/tahsilat-ödeme yetkisi yoktur. Gider oluşturma yalnızca
  atandığı projeyle sınırlıdır; düzenleme ve iptal PM için kapalıdır (bu,
  docs/PRODUCT_REQUIREMENTS.md §3'teki "gider ve belge girebilir" ifadesinin
  muhafazakâr yorumudur — düzenleme/iptal hakkı açıkça belirtilmediği için
  verilmemiştir).
- Ayrı staging ve production ortamları

## 12. Faz 4 uygulama notları — Dashboard ve proje kârlılığı

Bu bölüm YF-401/YF-402 uygulanırken netleştirilen agregasyon kararlarını
belgeler (`server/services/dashboard-service.ts`,
`server/services/project-finance-service.ts`, `server/services/ledger.ts`
`getOpenAndOverdueTotals`).

- **Tahsilat/ödeme toplamları `Settlement` üzerinden hesaplanır, `AccountMovement`
  üzerinden değil.** İptal edilmiş (ters kayıtlı) bir settlement `status:
  CANCELLED` olur; bu nedenle `status: 'ACTIVE'` filtresi tek başına çift
  sayımı (orijinal hareket + ters kayıt) engeller. `AccountMovement` bazlı bir
  toplam, ters kayıt `REVERSAL` tipinde ayrı bir satır olduğundan, `type IN
  (COLLECTION, PAYMENT)` filtresiyle yanlışlıkla iptal edilmiş tutarı da
  sayardı.
- **Açık/vadesi geçen alacak-borç, `getOpenAndOverdueTotals` ile tek bir
  sınırlı (bounded) ham SQL sorgusunda hesaplanır.** Kalan tutar
  (`totalAmount - Σ aktif settlement`) satır bazında türetilmesi gerektiğinden,
  tüm kayıtları uygulama belleğine çekmek yerine bu hesap PostgreSQL içinde
  yapılır. `CANCELLED` kayıtlar tamamen dışlanır; `OVERDUE`, kalan > 0 ve vade
  tarihi geçmişse (gelecek vadeler hariç) sayılır.
- **Kasa/banka bakiyesi** organizasyon genelinde tek bir `AccountMovement`
  `groupBy` sorgusuyla (CREDIT − DEBIT, yalnızca aktif hesaplar) hesaplanır;
  hesap başına ayrı sorgu yapılmaz (N+1 yok).
- **Dönem filtresi** yalnızca üç sabit seçenek sunar: bu ay, bu yıl, son 12 ay
  (tam rapor oluşturucu değildir). Filtre parasal KPI'ları (tahsilat, ödeme,
  net nakit akışı) ve kategori/proje-özel daraltmaları etkiler; açık/vadesi
  geçen tutarlar, kasa/banka bakiyesi, aktif proje/müşteri/tedarikçi sayıları
  ve bütçe-kritik proje sayısı her zaman **güncel an** itibarıyladır (dönem
  filtresinden etkilenmez) — bunlar "belirli bir tarihteki toplam" değil, canlı
  durum göstergeleridir.
- **Aylık trend grafikleri her zaman 12 aylık bir pencere gösterir**
  (`CURRENT_YEAR` → içinde bulunulan yıl Ocak-Aralık; `LAST_12_MONTHS` veya
  `CURRENT_MONTH` → bugünden geriye 12 aylık kayan pencere). Veri olmayan aylar
  sıfır olarak görünür (zero-fill); tarih sınırları `Europe/Istanbul` (sabit
  UTC+3, 2016 sonrası DST yok) esas alınarak hesaplanır.
- **Proje filtresi yalnızca parasal toplamları, aylık seriyi, kategori
  dağılımını, yaklaşanlar listesini ve son hareketleri daraltır.** Kasa/banka
  bakiyesi, aktif proje/müşteri/tedarikçi sayıları, bütçe-kritik proje sayısı
  ve proje kârlılık karşılaştırması her zaman organizasyon geneli kalır — bir
  hesap veya organizasyon sayımı tek bir projeye özgülenebilir kavramlar
  değildir; bu kasıtlı bir tasarım kararıdır.
- **PROJECT_MANAGER kapsamı:** Yalnızca atandığı projelerin toplamları
  görünür; kasa/banka bakiyesi ve organizasyon geneli müşteri/tedarikçi
  sayıları DTO'da hiç yer almaz (alan bazında yokluk — UI'da gizlenen bir
  değer değil). "Son hareketler" yerine yalnızca kendi projelerine bağlı
  gelir/gider kayıtlarından türetilen "son proje hareketleri" gösterilir; ham
  `AccountMovement` (transfer, düzeltme, diğer projelerin hareketleri)
  PROJECT_MANAGER'a hiç sunulmaz — aksi halde dashboard bileşenleri
  birleştirilerek organizasyon geneli bakiye dolaylı olarak çıkarılabilirdi.
- **Üç ayrı kâr kavramı proje finans özetinde birbirinden ayrılır:**
  Nakit Pozisyonu (tahsil edilen − ödenen), Tahakkuk Bazlı Sonuç (kaydedilen
  gelir − kaydedilen gider, iptal hariç), Tahmini Brüt Kâr (sözleşme bedeli −
  gerçekleşen gider — yalnızca sözleşme bedeli > 0 ise hesaplanır, aksi halde
  dürüstçe "desteklenmiyor" gösterilir). Şema "beklenen ek gelir" için ayrı bir
  alan içermediğinden bu metrik her zaman açıkça `unavailable` işaretlenir —
  veri uydurulmaz.
- **Bütçe:** Proje bazlı `estimatedBudget` alanı kullanılır (kategori bazlı
  `ProjectBudgetItem` dökümü kapsam dışıdır — YF-404). %80 eşiği "bütçesi
  kritik proje" sayımında (yalnızca `ACTIVE` projeler) kullanılır; bütçe
  girilmemişse (`estimatedBudget <= 0`) oran ve aşım durumu dürüstçe
  hesaplanamaz olarak işaretlenir, sıfıra bölme yapılmaz.

## 13. Faz 4 devamı — Nakit akışı ve bütçe raporları

Bu bölüm YF-403/YF-404 uygulanırken netleştirilen kararları belgeler
(`server/services/cash-flow-report-service.ts`,
`server/services/budget-report-service.ts`, `lib/dates.ts`).

- **Ortak Istanbul tarih yardımcıları `lib/dates.ts`'e taşındı.**
  `dashboard-service.ts` içinde özel (private) olan `TR_OFFSET_MS`/
  `toIstanbul`/`fromIstanbulComponents` artık `lib/dates.ts`'te dışa açık
  (`startOfIstanbulDay`, `addIstanbulDays` eklendi) ve `dashboard-service.ts`
  bunları içe aktarıp kullanır — davranış değişmedi, yalnızca formül tek
  kaynağa taşındı (bkz. görev talimatları "Reuse existing aggregate helpers").
  `getSettlementTotalsForRange` ve `resolveProjectFilter` de aynı gerekçeyle
  `dashboard-service.ts`'ten dışa açıldı ve YF-403/404 servislerinde
  değiştirilmeden yeniden kullanıldı. `getOrganizationCashBalance` (kasa/banka
  bakiyesi formülü) `ledger.ts`'e taşındı; `dashboard-service.ts` da artık bu
  fonksiyonu kullanır (davranış birebir aynı, tek formül kaynağı).

### 13.1 Nakit akışı raporu (YF-403)

- **Üç ayrı kavram:** Gerçekleşen (aktif `Settlement`, `settlementDate`
  seçilen aralıkta — `getSettlementTotalsForRange` ile birebir aynı formül),
  Planlanan (açık/kısmi ödenmiş kayıtların vade tarihine göre kalan tutarı) ve
  Birleşik projeksiyon (güncel bakiye + planlanan − planlanan = tahmini
  kapanış). Planlanan tutarlar UI'da hiçbir yerde "garanti nakit" olarak
  sunulmaz; tahmini kapanış bakiyesi DTO'da `projectedClosingBalanceIsEstimate:
  true` ile işaretlenir.
- **Vade bucket sınırları** (`Vadesi Geçmiş`, `Bugün Vadesi Gelen`,
  `Gelecek 7 Gün`, `Gelecek 30 Gün`, `31–60 Gün`, `61–90 Gün`, `90 Gün Üzeri`,
  `Vade Tarihi Girilmemiş`) her zaman **bugüne göre sabittir**, seçilen
  dönem filtresinden etkilenmez — bkz. `getMaturityBucketsGrouped`. Sınırlar
  Istanbul takvim günü başlangıcına göre (`startOfIstanbulDay`) önceden JS'te
  hesaplanıp SQL'e parametre olarak bağlanır; mevcut `getOpenAndOverdueTotals`
  (YF-401) `NOW()` kullanır — bu, UTC anlık zamanı temsil eder ve Istanbul
  gece yarısı sınırında yanlış sınıflandırma riski taşır. YF-403'ün
  "bugün vadesi gelen asla vadesi geçmiş sayılmaz" gereksinimi bu kesinliği
  zorunlu kıldığından, bu raporun bucket sorguları kasıtlı olarak
  `getOpenAndOverdueTotals`'tan daha kesindir; mevcut YF-401 formülü bu
  görevde değiştirilmedi (kapsam dışı, ayrı bir iyileştirme önerisi olarak
  not edilmiştir).
- **Planlanan tutarların kesim tarihi:** "Planlanan Tahsilatlar/Ödemeler"
  kartları ve aylık projeksiyon, seçilen dönem filtresinden **bağımsız
  olarak her zaman bugünden başlar** (`window.start = bugün`); yalnızca
  dönem sonu (`periodEnd`) filtreye göre değişir. Vadesi geçmiş kayıtlar da
  bu toplama dahildir (hâlâ tahsil/ödeme bekleniyor, standart alacak/borç
  nakit projeksiyon yaklaşımı) — vade tarihi `periodEnd`'den sonra olan veya
  vade tarihi girilmemiş kayıtlar hariçtir.
- **Filtre modeli** (`lib/validation/reports.ts`
  `cashFlowFilterSchema`): `CURRENT_MONTH | NEXT_30_DAYS | NEXT_90_DAYS |
  CURRENT_YEAR | CUSTOM`. `CUSTOM` başlangıç/bitiş tarihi zorunlu kılar
  (bitiş dahil, gün sonuna kadar) ve azami `366` gün ile sınırlıdır
  (`CASH_FLOW_MAX_CUSTOM_RANGE_DAYS`). Doğrulama yalnızca zod şemasında
  yapılır (dashboard'un `dashboardFilterSchema`'sıyla aynı ilke); servis
  fonksiyonları zaten doğrulanmış `CashFlowFilterInput` tipini kabul eder ve
  tekrar doğrulamaz — sayfa katmanı (`parseCashFlowFilter`) geçersiz
  filtrede sessizce varsayılana düşmez, açık bir hata durumu döndürür ve
  sayfa bunu kullanıcıya Türkçe mesajla gösterir.
- **Senaryolar** (`CASH_FLOW_SCENARIOS`): `ON_DUE_DATE | 
  COLLECTIONS_DELAYED_7D | PAYMENTS_DELAYED_7D`. Yalnızca planlanan
  tutarların karşılaştırma tarihini kaydırır (`due_date + delayDays <
  cutoff`); DB'deki `dueDate` hiçbir zaman değiştirilmez, tamamen sunum
  amaçlıdır.
- **İptal/ters kayıt/parçalı ödeme:** YF-401 ile birebir aynı kural seti
  (`FinancialTransaction.status = CANCELLED` tamamen hariç, kalan tutar
  `totalAmount - Σ(aktif settlement)`, ters kayıt orijinal `AccountMovement`'ı
  silmez ama ilişkili `Settlement` `CANCELLED` olduğundan settlement-bazlı
  toplamlarda otomatik dışlanır). Transfer hareketleri raporun kaynağı olan
  `FinancialTransaction`/`Settlement` tablolarında hiç yer almadığından
  gelir/gider olarak asla sızmaz.
- **Sorgu stratejisi:** Vade bucket'ları ve planlanan toplamlar proje bazında
  (NULL proje dahil) tek bir `GROUP BY` sorgusuyla hesaplanır
  (`getMaturityBucketsGrouped`, `getScheduledTotalsGrouped`); organizasyon
  toplamı bu map'in JS'te toplanmasıyla elde edilir — proje başına ayrı
  sorgu yapılmaz. Alacak/borç vade listeleri, `status IN
  ('OPEN','PARTIALLY_PAID','OVERDUE')` indeksli filtresiyle (mevcut
  `@@index([organizationId, dueDate, status])`) sınırlandırılır, `take: 100`
  ile sayfalanır ve `totalOpenCount` ile kesilip kesilmediği (`truncated`)
  ayrıca döndürülür. Proje bazlı karşılaştırma en riskli/hareketli ilk 50
  projeyle sınırlıdır.
- **PROJECT_MANAGER kapsamı:** Yalnızca atandığı projelerin toplamları
  görünür; DTO'da `openingBalance`/`projectedClosingBalance` alanları hiç
  bulunmaz (alan bazında yokluk), aylık projeksiyonun `runningProjectedBalance`
  sütunu her zaman `null`'dır — kasa/banka bakiyesi kavramı PM'e hiç
  sunulmaz.

### 13.2 Bütçe ve gider kategori analizleri (YF-404)

- **Merkezi eşik fonksiyonu:** `getBudgetStatus` (`budget-report-service.ts`)
  YF-402'de tanıtılan %80 kritik eşiğini (`BUDGET_CRITICAL_RATIO = 0.8`)
  yeniden kullanır: `NORMAL <%80`, `CRITICAL %80–%99.99`, `OVER_BUDGET ≥%100`,
  `NO_BUDGET` (`estimatedBudget <= 0`). Bu görevde eklenen tüm UI
  bileşenleri yalnızca bu fonksiyonu çağırır; eşik ikinci bir yerde
  tekrarlanmaz. Mevcut `dashboard-service.ts`
  (`computeBudgetCriticalCount`) ve `project-finance-service.ts`
  (`BUDGET_CRITICAL_RATIO`) içindeki önceden var olan, zaten test edilmiş
  YF-401/402 inline kullanımları bu görevde değiştirilmedi (aynı sabiti,
  0.8, kullanırlar) — gereksiz risk taşıyan bir dokunuş olacağından kapsam
  dışı bırakıldı.
- **Risk metrikleri yalnızca `ACTIVE` projeleri kapsar:** Bütçe aşan/kritik/
  bütçesiz proje sayısı ve listeleri (dashboard'daki
  `budgetCriticalProjectCount` ile aynı ilke, ve görev talimatının "list
  **active** projects" ifadesiyle birebir uyumlu). Organizasyon toplamları
  (`totalProjectBudget`, `totalRealizedExpenses` vb.) ise tüm proje
  durumlarını kapsar — tamamlanmış bir projenin harcadığı bütçe hâlâ gerçek
  finansal veridir. Ortalama bütçe kullanımı yalnızca bütçeli **ve** aktif
  projeleri kapsar; bütçesiz projeler sıfıra bölme riskinden kaçınmak için
  paydaya hiç girmez.
- **`ProjectBudgetItem` (proje + kategori bazlı planlanan tutar)** şemada
  zaten mevcuttur ve YF-402'de bilinçli olarak bu göreve ertelenmişti (bkz.
  §12). Bu servis, var olduğu proje/kategori kombinasyonlarında
  `plannedAmount`'ı proje×kategori matrisine ekler (`Planlanan (varsa)`
  sütunu); yoksa `null` döner ve UI yalnızca gerçekleşen harcama dağılımı
  olarak sunar — "kategori bütçe kullanımı" olarak etiketlenmez. **Bilinçli
  kapsam dışı bırakma:** bu modeli oluşturan/düzenleyen bir yönetim arayüzü
  bu görevde eklenmedi çünkü YF-403/404 talimatı yalnızca *mevcut* veriyle
  rapor üretmeyi kapsar ("Implement ... analysis using **existing**
  ... data"); bütçe planlama/tahsis arayüzü doğal bir sonraki görev olarak
  önerilir (aşağıdaki "Bilinen eksikler"e bakınız).
  `db.projectBudgetItem` şu an hiçbir üretim akışından doldurulmadığından bu
  matris sütunu gerçek kullanıcı verisiyle tipik olarak boş görünecektir;
  testler doğrudan Prisma ile satır ekleyerek bu yolu ayrıca doğrular.
  Migration eklenmedi — model zaten mevcuttu.
- **Sorgu stratejisi:** Ödenen gider (proje/kategori bazında) tek bir
  `JOIN ... GROUP BY` ham SQL sorgusuyla hesaplanır (`getPaidExpenseByProject`,
  `getPaidExpenseByCategory`) — `Settlement`'ın `projectId` kolonu olmadığı
  için Prisma `groupBy` ile doğrudan mümkün değildir. Proje×kategori matrisi
  tek bir `groupBy(["projectId","categoryId"])` ile hesaplanır, tutara göre
  sıralanıp ilk 200 satırla sınırlandırılır (`projectCategoryMatrixTruncated`
  ile kesilip kesilmediği ayrıca döndürülür). Aylık kategori trendi son 12
  ayı kapsar (`getDateRange("LAST_12_MONTHS", now)` — dashboard ile aynı
  pencere) ve varsayılan olarak en çok harcanan ilk 5 kategoriyi gösterir
  (`CATEGORY_TREND_TOP_N`); `categoryId` filtresi verilirse tek kategoriye
  daralır.
- **PROJECT_MANAGER kapsamı:** Yalnızca atandığı projelerin bütçe/kategori
  verileri görünür; organizasyon geneli proje listesi hiç sorgulanmaz
  (`projectIds` her zaman atanmış proje kimlikleriyle sınırlanır).

### 13.3 Bilinen eksikler / sonraki görevler

- `ProjectBudgetItem` oluşturma/düzenleme arayüzü yok (yalnızca okunuyor).
- YF-405 (Excel/PDF dışa aktarma) bu görevin kapsamı dışındadır.
- Özel tarih aralığı geçmişe dönük seçildiğinde (`CUSTOM`, hem başlangıç hem
  bitiş bugünden önce), planlanan/projeksiyon rakamları güncel (an itibarıyla)
  açık kayıtları yansıtır — o tarihteki gerçek settlement durumunun geçmişe
  dönük bir "an itibarıyla" görünümü değildir. Bu, ürün talimatının
  "deterministic scheduled cash-flow reporting" kapsamına uygundur ve
  geçmişe dönük senaryo MVP'de hedeflenmemiştir; belgelenmiş, kabul edilen
  bir sınırlamadır.

## 14. Faz 4 devamı — Rapor dışa aktarma (YF-405)

Bu bölüm YF-405 uygulanırken alınan mimari kararları belgeler
(`server/services/report-export-service.ts`, `server/exports/*`,
`app/api/exports/*/route.ts`).

### 14.1 Route/servis ayrımı

Repository'de bu göreve kadar hiçbir `app/api/` route handler'ı yoktu — tüm
mutasyonlar Server Action'lar üzerinden yürüyordu. İkili dosya indirmeleri
(gerçek `Content-Type`/`Content-Disposition` başlıkları, akış) bir Server
Action ile ifade edilemediğinden, bu görev ilk `route.ts` dosyalarını
tanıttı. Her route handler kasıtlı olarak **ince bir sarmalayıcıdır**:
yalnızca `getSessionUser()` çağırır (kimliksizse 401), ardından işin tamamını
`server/services/report-export-service.ts`'e devreder. Bu dosya `next/headers`
kullanmaz — zaten çözümlenmiş bir `SessionUser` alır — bu nedenle diğer tüm
servisler gibi (`tests/helpers.ts`'in `createOwnerOrg`/`createOrgUser`'ı ile)
doğrudan test edilebilir; gerçek yetkilendirme/tenant/PM kapsamı tamamen
YF-401–404'ün mevcut rapor servislerinden (`getDashboardData`,
`getProjectFinanceSummary`, `getCashFlowReport`, `getBudgetReport`) miras
alınır — export katmanı **hiçbir finansal hesaplama tekrarlamaz**, yalnızca
bu servislerin ürettiği DTO'ları biçimlendirir. Proje bazlı export için
cross-tenant/atanmamış proje id'si, `getProjectForUser` (mevcut,
`server/services/project-service.ts`) üzerinden zaten `NOT_FOUND` ile kapanır
— export katmanı ek bir kontrol eklemeden fail-closed davranışı ücretsiz
kazanır.

`server/exports/http.ts`, `ServiceError.code → HTTP durum kodu` eşlemesini
(`VALIDATION→400, FORBIDDEN→403, NOT_FOUND→404, CONFLICT→409`, bilinmeyen
hata → 500 + sabit Türkçe mesaj, **asla stack trace**) ve yanıt başlığı
üretimini merkezileştirir.

### 14.2 Bağımlılık seçimleri

| Paket | Sürüm | Lisans | Gerekçe |
|---|---|---|---|
| `exceljs` | `^4.4.0` | MIT | `.xlsx` üretimi için Node ekosisteminde fiili standart; stil/sayı biçimi/donmuş bölme/autoFilter desteği tam. |
| `pdfmake` | `^0.3.11` | MIT | Bildirimsel doc-definition API'si — sayfa kesmelerinde tekrarlanan tablo başlığı (`headerRows`) ve otomatik sayfa numarası (`footer` callback) hazır gelir; elle sayfalama mantığı yazmayı gerektirmez. `engines.node >=20`. |
| `@expo-google-fonts/roboto` | `^0.4.3` | MIT (paket sarmalayıcısı) + **SIL Open Font License 1.1** (yazı tipinin kendisi) | PDF'de Türkçe karakter (`ş ğ ı ö ü ç İ Ğ Ş Ö Ü Ç`) desteği. |

**Neden ayrı bir yazı tipi paketi gerekti:** `pdfmake`'in yayınlanan npm
paketi hiçbir gömülebilir `.ttf`/`.otf` içermez — yalnızca WinAnsi kodlu 5
standart PDF yazı tipini (Helvetica/Times/Courier/Symbol/ZapfDingbats) taşır
(`npm pack pdfmake --dry-run` ile doğrulandı); WinAnsi Türkçe özel karakterleri
kapsamaz. İlk değerlendirilen aday (`@openfonts/roboto_all`) yalnızca
`.woff`/`.woff2` içeriyordu — pdfmake'in belgelenen sunucu deseni (gerçek
`.ttf`/`.otf` dosya yolları) ile uyuşmadığından ve gerçek bir üretim testiyle
doğrulanmadığından reddedildi. `@expo-google-fonts/roboto` gerçek `.ttf`
dosyaları içerir (`400Regular/Roboto_400Regular.ttf`,
`700Bold/Roboto_700Bold.ttf`) ve font-özel `LICENSE_FONT` dosyası "SIL Open
Font License, Version 1.1" olduğunu ve gömme/yeniden dağıtıma izin verdiğini
açıkça belirtir ("yazı tipleri tek başına satılmadığı sürece"). Yazı tipi
dosyaları `node_modules`'tan çalışma zamanında okunur — **repoya hiçbir font
dosyası commit edilmez**; paket `dependencies`'tedir (yalnızca build/test
değil, `next start` çalışma zamanında da gerekli).

**Doğrulama:** `server/exports/font.ts`'in TTF yol çözümlemesi ve
`pdfmake`'in gerçek `PdfPrinter`/`URLResolver` sunucu API'si (yayınlanan
`.d.ts` yok — `server/exports/pdfmake-types.d.ts` bu API'yi doğrudan gözlemle
minimal ve doğru şekilde tipler) bağımlılıklar kurulduktan sonra gerçek bir
PDF üretilerek doğrulandı: `%PDF-` imzası, `%%EOF` sonlandırıcı, ve gömülü
TrueType yazı tipinin kanıtı olan `/FontFile2` + `/Subtype /CIDFontType2` +
`/Type0` (Latin-Extended/Türkçe karakterler standart WinAnsi kodlamasının
dışında kaldığından pdfkit/fontkit otomatik olarak CID-anahtarlı kompozit
yazı tipi gömme yolunu seçer). Bu programatik kanıt `tests/report-export-pdf.test.ts`'te
otomatik olarak tekrar doğrulanır (`getRobotoFontPaths()` ile dosyaların
fiziksel varlığı + üretilen her PDF'te `/FontFile2` kontrolü).

**Çalışma zamanı:** Her export `route.ts`, `export const runtime = "nodejs"`
ile açıkça sabitlenir — `exceljs`, `pdfmake`, `Buffer` ve dosya sistemi
tabanlı yazı tipi çözümlemesi Edge runtime'da çalışmaz. `next.config.ts`
`output: "standalone"` KULLANMADIĞINDAN (repo bunu hiç ayarlamaz), `next
start` tam `node_modules` üzerinde çalışır — yazı tipi dosyalarının çıktı
izlemesiyle (output tracing) budanma riski yoktur; bu nedenle
`outputFileTracingIncludes` eklenmemiştir. Proje ileride `output:
"standalone"`'a geçerse, bu ayarın gerekip gerekmediği yeniden
değerlendirilmelidir.

### 14.3 Decimal → Excel sayısal hassasiyet sınırı

`prisma/schema.prisma` her para alanını `Decimal(18,2)` olarak tanımlar (16
tam sayı hanesi + 2 ondalık = 18 anlamlı hane); bir Excel/JS `number` ise
IEEE-754 double'dır (~15–17 anlamlı ondalık hane kesin hassasiyet). Yani
Decimal hassasiyeti bir Excel sayısal hücresine dönüştürülerek koşulsuz
korunamaz. `server/exports/money.ts`'in `EXCEL_EXACT_SAFE_MAX =
999.999.999.999,99` sınırı (12 tam sayı hanesi + 2 ondalık = 14 anlamlı hane,
en kötü durum yuvarlama hatası ≈ değer × 2,22e-16, yarım kuruşun çok altında)
bu sınırın altındaki tutarları sayısal hücreye, üstündeki (gerçekçi
olmayan ama şema düzeyinde mümkün) tutarları ise tam Decimal biçimli bir
metin hücresine yazar — hiçbir tutar sessizce yanlış gösterilmez.

### 14.4 Satır sınırları ve kesilme (truncation) göstergesi

Export katmanı **kendi satır sınırını tanımlamaz** — YF-401–404 rapor
servislerinin zaten uyguladığı sınırları miras alır (`MATURITY_LIST_LIMIT=100`,
`NO_DUE_DATE_LIST_LIMIT=50`, `PROJECT_CATEGORY_MATRIX_LIMIT=200`,
`INCOME_EXPENSE_LIST_LIMIT=100`, vb. — bkz. §12/§13). DTO'daki `truncated`/
`...Truncated` bayrakları (cash-flow, budget) doğrudan sayfaya bir uyarı
satırı olarak yazılır. Proje finans özetinin gelir/gider listelerinde DTO
düzeyinde bir kesilme bayrağı yoktur (bu servis YF-405 kapsamında
değiştirilmedi); bunun yerine sabit bir açıklama notu her zaman gösterilir
("en fazla 100 kayıt gösterir; KPI toplamları tüm kayıtları kapsar").

### 14.5 Formül/CSV enjeksiyon koruması

`server/exports/excel-exporter.ts`'in `sanitizeExcelText`'i, baştaki
boşluk/denetim karakterlerini (`\s`, `\t`, `\r`, `\n` ve diğer C0 denetim
baytları — yalnızca görünür boşluk değil) atlayarak ilk "gerçek" karakteri
kontrol eder; bu karakter `= + - @` ise orijinal (kırpılmamış) dizgenin
başına bir apostrof (`'`) eklenir, böylece hücre daima düz metin olarak
yazılır (asla formül tipi değil). Her serbest metin hücresine (açıklama, ad,
belge no vb.) uygulanır; para/tarih/yüzde/etiket hücrelerine uygulanmaz.

### 14.6 Geçici dosya ve bellek stratejisi

Hiçbir export adımı diske geçici dosya yazmaz — `ExcelJS.Workbook.xlsx.writeBuffer()`
ve `pdfmake`'in `PDFDocument` akışı doğrudan bellekte bir `Buffer`'a
toplanır ve tek bir `NextResponse` gövdesi olarak döndürülür (base64 yok,
`public/`'e yazma yok, öngörülebilir geçici dosya yok). Üretim, üzerine
bindiği rapor servisleriyle aynı sınırlı sorgularla sınırlı olduğundan yeni
bir bellek/DB riski eklenmez.

### 14.7 Test stratejisi

Repodaki mevcut testler tamamen servis katmanındadır (`tests/*.test.ts`,
gerçek disposable Postgres'e karşı). `getSessionUser()` `next/headers`'ın
istek-kapsamlı `cookies()`'ine bağlı olduğundan, bir `route.ts`'in `GET`'ini
doğrudan (gerçek bir HTTP isteği olmadan) çağırmak bu mekanizmayı tetiklemez.
Bu nedenle üç katman ayrı test edilir:

1. **`tests/report-export-service.test.ts`** — gerçek disposable Postgres,
   `report-export-service.ts`'in fonksiyonlarını doğrudan çağırır (rol/tenant/PM
   kapsamı, format/filtre doğrulama, satır sınırı, iptal/parçalı ödeme
   davranışının export'a doğru yansıması).
2. **`tests/report-export-excel.test.ts`** / **`tests/report-export-pdf.test.ts`** —
   DB yok, sentetik DTO'larla ikili yapı doğrulaması (imza, sayfa adları,
   hücre tipleri, formül enjeksiyon senaryoları, Decimal hassasiyet sınırı).
3. **`tests/report-export-integration.test.ts`** — `scripts/run-export-integration-tests.mjs`
   tarafından gerçek bir `next start` sunucusu ayağa kaldırılıp gerçek
   `fetch()` + gerçek `Cookie` başlığıyla çalıştırılır (401/200/404/400,
   başlıklar). Standart `npm run test`'in (`vitest.config.ts`) DIŞINDadır —
   `npm run test:report-export-integration` ile ayrı çalıştırılır (bkz.
   `vitest.integration.config.ts`) çünkü her `next build` + `next start`
   çalıştırması standart birim test paketini önemli ölçüde yavaşlatırdı.
