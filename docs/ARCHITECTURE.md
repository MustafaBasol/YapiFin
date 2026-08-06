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

- `ProjectBudgetItem` oluşturma/düzenleme arayüzü YF-406'da eklendi — bkz. §14.
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

## 15. Proje bütçe kalemi planlama ve yönetimi (YF-406)

Bu bölüm YF-406 uygulanırken netleştirilen kararları belgeler
(`server/services/project-budget-service.ts`, `lib/validation/project-budget.ts`,
`app/actions/project-budget.ts`, `/projects/[id]/budget`).

- **Migration gerekmedi.** `ProjectBudgetItem` şemada YF-402'de eklenmişti
  (bkz. §12) ve zaten `projectId`, `categoryId`, `plannedAmount`
  (`Decimal(18,2)`), `notes` (opsiyonel açıklama), `createdAt`/`updatedAt` ve
  proje/kategori üzerinden organizasyon ilişkisini içeriyordu. Bu görev
  yalnızca ilk create/update/delete yönetim katmanını ekledi.
- **Benzersizlik kuralı:** Şemada zaten mevcut olan `@@unique([projectId,
  categoryId])` kısıtı kullanıldı — proje başına kategori başına tek bir aktif
  planlama satırı. Bu, görev talimatının tercih edilen kuralıyla (`one active
  budget item per project and expense category`) birebir örtüştüğünden ek bir
  kısıt eklenmedi. Oluşturma/güncelleme öncesi bir "var mı" ön kontrolü
  YAPILMAZ; yalnızca DB'nin `P2002` benzersizlik ihlali yakalanıp temiz bir
  Türkçe `ServiceError("... zaten bir bütçe kalemi var", "CONFLICT")`'e
  çevrilir — bu, eşzamanlı iki oluşturma denemesinde de yalnızca birinin
  kalıcı olmasını garanti eder (bkz. `tests/project-budget.test.ts`
  "eşzamanlı mükerrer oluşturma").
- **Yetki matrisi:** `canManageProjectBudget` (`lib/permissions.ts`) —
  OWNER/ADMIN/FINANCE oluşturma/güncelleme/**silme** dahil tam CRUD
  yapabilir. FINANCE için silme yetkisi kasıtlı bir karardır: mevcut
  `canManageExpenses`/`canCancelFinancialRecord` ilkesiyle aynı çizgide
  (finans rolü zaten gider kaydını iptal/düzenleyebiliyor), ve bütçe kalemi
  kayıtlı bir finansal işlem olmadığından (§ aşağı, "Silme semantiği") bu en
  az şaşırtıcı, tutarlı seçimdir. PROJECT_MANAGER için **kasıtlı olarak
  yazma yetkisi tanımlanmadı** — salt-okunur kalır (yalnızca atandığı
  projeler için, `getProjectForUser` üzerinden). Gerekçe: bütçe planlaması
  kategori/tedarikçi ana veri yönetimine benzer bir organizasyon-düzeyi
  finansal planlama işlevidir (PM bunlara da erişemez); PM'in var olan tek
  ilgili yetkisi "gider *kaydı* oluşturma" (`canCreateExpense`) olup bu farklı
  bir işlemdir (gerçek harcama vs. plan/tahsis kararı) ve doğrudan
  genellenemez. Belirsizlik durumunda salt-okunur varsayılan tercih edildi
  (görev talimatı: "if there is no established write permission... default to
  read-only").
- **Kapsam çözümleme:** Her create/update/delete önce
  `getProjectForUser(actor, projectId)` ile projeyi aktörün
  organizasyon/PM-atama kapsamında çözer (cross-tenant veya atanmamış proje →
  `NOT_FOUND`, sızıntı yok), ardından kategoriyi `organizationId` + `type:
  "EXPENSE"` ile aynı organizasyonda arar. Update/delete, kalemi önce
  `id + organizationId` ile bulur, sonra `updateMany`/`deleteMany`'i yine
  `id + organizationId` koşuluyla çalıştırıp etkilenen satır sayısını
  (`count`) kontrol eder — sıfırsa `NOT_FOUND` döner. Bu, "unsafe read +
  unscoped write" deseninden kaçınır ve kayıp güncelleme (lost update)
  riskini pratik ölçüde azaltır; bütçe kalemleri türetilmiş bir bakiye
  olmadığından (Settlement/AccountMovement'ın aksine) satır kilitleme
  (`SELECT ... FOR UPDATE`) burada gerekli görülmedi — mevcut Project/Category
  CRUD'larıyla aynı basit atomik update deseni izlendi.
- **Gerçekleşen gider ve durum eşiği yeniden kullanılır, tekrar hesaplanmaz.**
  `getProjectBudgetPlanning`, proje×kategori gerçekleşen gider dağılımı için
  `getProjectFinanceSummary` (YF-402) `categoryDistribution`/
  `totalRecordedExpense` alanlarını doğrudan kullanır (iptal edilmiş kayıtlar
  zaten bu formülde hariç tutulur); durum eşiği için `getBudgetStatus`
  (YF-404, `BUDGET_CRITICAL_RATIO = 0.8`) hem kalem bazında hem proje
  toplamında birebir çağrılır. UI bileşenleri (`ProjectBudgetStatusBadge`)
  yalnızca dönen `status` değerini gösterir, eşiği yeniden hesaplamaz.
  Toplam sorgu sayısı kalem sayısından bağımsızdır: tek bir
  `projectBudgetItem.findMany` + `getProjectFinanceSummary`'nin zaten sınırlı/
  gruplu sorguları (N+1 yok).
- **Decimal doğrulama:** `lib/validation/project-budget.ts`
  `plannedAmountSchema`, tutarı bir ondalık **string** olarak doğrular
  (`^(0|[1-9]\d{0,15})(\.\d{1,2})?$` — en fazla 16 tam sayı hanesi + en fazla 2
  ondalık, `Decimal(18,2)` kolonuna sığar), üstel gösterim/virgüllü
  yerelleştirilmiş girdi/`NaN`/`Infinity`'yi reddeder. Sıfır kontrolü de saf
  metin eşleştirmesiyle (`^0(\.0{1,2})?$`) yapılır — yetkili tutar hiçbir
  zaman `Number()` aritmetiğinden geçmez; doğrulanmış string doğrudan
  Prisma'nın Decimal alanına yazılır. Sıfır/negatif tutar reddedilir —
  bütçe kaldırma her zaman silme ile yapılır, sıfır-tutarlı satır
  desteklenmez (mevcut satırlar zaten `plannedAmount` üzerinde `NOT NULL`,
  varsayımsız bir Decimal kolonu olduğundan bu kural yeni bir kısıtlama
  getirmez).
- **Kategori doğrulama:** Yalnızca aynı organizasyona ait, `type: "EXPENSE"`
  ve `isActive: true` kategoriler yeni bütçe kalemi için seçilebilir.
  Kategori sonradan pasifleştirilirse, ona bağlı var olan bütçe kalemi
  **görüntülenmeye devam eder** (`categoryIsActive: false` alanıyla UI'da
  işaretlenir) ama o kategoriye yeni kalem eklenemez/var olan kalem o
  kategoriye taşınamaz.
- **Silme semantiği: hard delete.** Bütçe kalemleri, tahsilat/ödemesi olan
  kayıtlı bir finansal işlem değil, bir plan/tahmin satırıdır; iptal/ters
  kayıt (Settlement/AccountTransfer) mantığı burada uygulanmaz. Silme,
  transaction/settlement kayıtlarını hiç etkilemez (yalnızca
  `ProjectBudgetItem` satırı kaldırılır) ve `AuditLog`'a
  `project_budget_item.delete` olarak (proje/kategori adı ve silinen
  planlanan tutarla, ham Prisma nesnesi olmadan) yazılır — mevcut audit log
  altyapısı (`lib/audit.ts`) kullanılır, yeni bir çerçeve eklenmedi.
- **Server Actions:** `app/actions/project-budget.ts` mevcut desenle
  (`requireRole` + Zod `safeParse` + servis + `toActionError` + `revalidatePath`)
  birebir uyumludur; ayrı bir API route eklenmedi. Yalnızca
  `/projects/[id]/budget` ve `/projects/[id]` yolları revalidate edilir —
  `/reports/budget` (YF-404) bu görevde değiştirilmedi ve YF-405 ile paralel
  izolasyon gereği dokunulmadı.
- **UI:** `/projects/[id]/budget`, proje detay sayfasından ("Bütçe
  Planlaması" bağlantısı) ayrı, izole bir rotadır — YF-404'ün tam rapor
  sayfası burada tekrarlanmaz. PROJECT_MANAGER (veya `canManage=false` olan
  herhangi bir rol) için ekleme/düzenleme/silme kontrolleri hiç render
  edilmez (gizli buton değil, koşullu render + sunucu tarafı yetki kontrolü
  ile çift katmanlı korunur).
- **Test kapsamı sınırı (mevcut depo kuralıyla tutarlı):** Bu depoda hiçbir
  test dosyası `app/actions/*.ts` içindeki "use server" fonksiyonlarını
  doğrudan çağırmaz (hepsi `next/headers` gerektiren `requireUser`/
  `requireRole` kullanır) — testler her zaman servis katmanını doğrudan
  hedefler. YF-406 testleri de bu kuralı izler; Türkçe doğrulama mesajları
  doğrudan Zod şemaları üzerinden, "Prisma hatası sızdırmama" ve audit log
  davranışı servis katmanından doğrulanır. `revalidatePath` çağrılarının
  doğru yolları hedeflediği ve action'ların ürettiği başarı/hata metinleri
  yalnızca kod incelemesi + manuel/üretim modu smoke testiyle doğrulanmıştır
  (bkz. görev raporu) — bu, depodaki mevcut test stratejisiyle tutarlı,
  bilinçli bir sınırdır.

## 16. Proje bütçe sapma analizi ve tamamlanma tahmini (YF-407)

Bu bölüm YF-407 uygulanırken netleştirilen kararları belgeler
(`server/services/project-budget-variance-service.ts`,
`components/app/project-budget-variance-section.tsx`,
`/projects/[id]/budget` sayfasının genişletilmesi). Bu görev **salt okunur**
bir analiz katmanıdır — yeni bir mutasyon, yeni bir Prisma modeli veya yeni
bir yönetim izni eklemez.

- **Migration gerekmedi.** Sapma ve tahmin tamamen mevcut verilerden
  (`ProjectBudgetItem.plannedAmount`, `FinancialTransaction` üzerinden
  hesaplanan gerçekleşen gider, `Project.startDate`/`Project.plannedEndDate`)
  türetilir; hiçbir alan kalıcı olarak saklanmaz.
- **Sıfır ek sorgu.** `getProjectBudgetVarianceReport(actor, projectId)`,
  YF-406'nın `getProjectBudgetPlanningForResolvedProject`'ini (bkz. §15)
  aynen çağırır — proje erişimi tek bir `getProjectForUser` ile çözülür,
  bütçe kalemleri tek bir `findMany` ile, gerçekleşen gider ve kategori
  dağılımı `getProjectFinanceSummaryForResolvedProject`'in zaten var olan
  gruplu/sınırlı sorgularıyla gelir. Sapma tutarı/yüzdesi ve tamamlanma
  tahmini bunların üzerine **yalnızca bellek içi Decimal aritmetiği** olarak
  eklenir — kalem sayısından bağımsız, ek DB round-trip'i yoktur (bkz.
  `tests/project-budget-variance.test.ts`, "N+1 yaratmadan tek sorguyla
  çözülür" yapısal testi).
- **Gerçekleşen gider tanımı değişmedi.** YF-402/404/406'da tanımlanan
  aynı gerçekleşen gider kullanılır: iptal edilmiş (`CANCELLED`)
  `FinancialTransaction` kayıtları hariç, tahakkuk bazlı (Settlement/tahsilat
  durumundan bağımsız), `AccountTransfer` hiç dahil değil (ayrı bir model,
  gider kaydı üretmez). Bu tanım burada **tekrar hesaplanmaz**, YF-406'nın
  `realizedExpense`/`totalRealizedExpense` alanları doğrudan kullanılır.
- **Sapma formülleri** (kategori bazında ve proje toplamında aynı):
  - `sapma tutarı = gerçekleşenGider - planlananTutar` (pozitif = aşım,
    negatif = tasarruf/az kullanım)
  - `sapma yüzdesi = (sapma tutarı / planlananTutar) × 100`, planlanan
    tutar ≤ 0 ise `null` (YF-404/406'daki `NO_BUDGET` durumuyla tutarlı —
    sıfır bütçeye karşı anlamlı bir yüzde ifade edilemez)
  - Durum (`Normal`/`Kritik`/`Bütçe Aşıldı`/`Bütçe Girilmemiş`) YF-404'ün
    `getBudgetStatus`/`BUDGET_CRITICAL_RATIO` (0.8) eşiği yeniden kullanılır,
    burada ikinci bir eşik tanımlanmaz.
- **Tamamlanma tahmini tamamen deterministiktir**, hiçbir veri uydurulmaz.
  Aşağıdaki koşullardan biri geçerliyse tahmin üretilmez ve
  `forecast.forecastAvailable = false` + `forecast.unavailableReason`
  alanı nedeni taşır (kontrol sırası, önce geçerli olan neden döner):
  1. `NO_START_DATE` — `Project.startDate` boş
  2. `NOT_STARTED` — başlangıç tarihi gelecekte (`startDate > bugün`)
  3. `NO_ELAPSED_TIME` — başlangıçtan bugüne geçen tam gün sayısı 0
     (`floor((bugün - startDate) / 1 gün) < 1`)
  4. `NO_EXPENSE` — toplam gerçekleşen gider ≤ 0
  5. `NO_BUDGET` — toplam planlanan bütçe (bütçe kalemleri toplamı) ≤ 0

  Bu beş koşuldan hiçbiri geçerli değilse tahmin formülleri (tümü
  `Prisma.Decimal` ile, JS `number` aritmetiği kullanılmadan):
  - `elapsedDays = floor((bugün - startDate) / 1 gün)`
  - `dailyBurnRate = toplamGerçekleşenGider / elapsedDays`
  - `plannedEndDate` doluysa VE `plannedEndDate > startDate` ise
    (`projectedTotalExpenseAvailable = true`):
    - `planlanan proje süresi (gün) = ceil((plannedEndDate - startDate) / 1 gün)`
    - `projectedTotalExpense = dailyBurnRate × planlanan proje süresi`
    - `projectedOverrunOrSavings = projectedTotalExpense - toplamPlanlananBütçe`
      (pozitif = tahmini aşım, negatif = tahmini tasarruf)
  - `plannedEndDate` yoksa (veya başlangıçtan önceyse) yalnızca
    `estimatedDaysRemainingOnBudget` üretilir, `projectedTotalExpense`/
    `projectedOverrunOrSavings` `null` kalır — veri uydurulmaz (görev
    talimatı: "bitiş tarihi yoksa yalnızca mevcut bütçenin tahmini kaç gün
    yeteceği hesaplanabilir").
  - `estimatedDaysRemainingOnBudget`:
    - kalan bütçe (`toplamPlanlananBütçe - toplamGerçekleşenGider`) ≤ 0 ise
      **`0`** döner (negatif gün üretilmez; "bütçe zaten tükendi/aşıldı"
      anlamına gelir, UI'da ayrı bir vurgu ile gösterilir)
    - aksi halde `floor(kalanBütçe / dailyBurnRate)`
- **Bu bir muhasebesel kesin sonuç değildir.** Tahmin, mevcut harcama
  hızının (`dailyBurnRate`) değişmeden devam edeceği varsayımına dayanan
  **operasyonel bir projeksiyondur** — mevsimsellik, kalan işin fiili
  kapsamı veya gelecekteki fiyat değişimleri hesaba katılmaz. Hem servis
  doc-yorumunda hem de UI'da ("Bu tahmin muhasebesel bir kesin sonuç
  değildir...") bu açıkça belirtilir.
- **DTO tasarımı — üst küme (superset) deseni.** `ProjectBudgetVarianceReport`
  ve `ProjectBudgetVarianceCategoryRow`, YF-406'nın `ProjectBudgetPlanning`/
  `ProjectBudgetPlanningItem` tiplerinin bir üst kümesidir (aynı alanlar +
  sapma/tahmin alanları). Bu sayede `/projects/[id]/budget` sayfası tek bir
  servis çağrısıyla (`getProjectBudgetVarianceReport`) hem mevcut
  `ProjectBudgetSection` (kalem CRUD tablosu, YF-406) hem yeni
  `ProjectBudgetVarianceSection`'ı besler — proje erişimi ve finans özeti
  sayfa başına yalnızca bir kez hesaplanır, YF-406 UI'sı hiç değiştirilmeden
  yeniden kullanılır (regresyon riski yok, bkz. görev talimatı "proje
  erişimini birden fazla kez gereksiz yükleme").
- **Yetkilendirme değişmedi.** Tamamen §15'teki `getProjectForUser` kapsam
  çözümlemesine dayanır: OWNER/ADMIN/FINANCE tüm projeleri görür, atanmış
  PROJECT_MANAGER yalnızca kendi projesini görür, atanmamış PROJECT_MANAGER
  ve cross-tenant proje ID'si `NOT_FOUND` döner (varlık sızıntısı yok). Bu
  görev salt okunur olduğu için yeni bir yazma izni tanımlanmadı;
  `canManage` alanı yalnızca YF-406 kalem tablosunun düzenleme/silme
  kontrollerini göstermek için taşınır, sapma/tahmin bölümünün kendisi
  hiçbir zaman düzenlenebilir değildir.

## 17. Bütçe sapması ve tamamlanma tahmini verilerinin export'a eklenmesi (YF-512)

Bu bölüm YF-512 uygulanırken alınan kararları belgeler
(`server/exports/excel-exporter.ts`, `server/exports/pdf-exporter.ts`,
`server/services/report-export-service.ts`,
`server/services/project-budget-variance-service.ts`). Kapsam yalnızca
**proje finans export'u** (`/api/exports/project-finance`,
`exportProjectFinance`) — dashboard, nakit akışı ve organizasyon geneli
bütçe export'ları bu görevde değiştirilmedi.

- **Hangi export'lar etkilendi.** Yalnızca proje finans raporu (`yapifin-proje-finans-*.xlsx` / `.pdf`).
  xlsx çıktısına yeni bir **"Bütçe Sapması ve Tahmin"** sayfası eklendi
  (proje özeti sayfası ile gelir/gider sayfaları arasında); pdf çıktısına
  proje özetinden hemen sonra, gelir/gider tablolarından önce yeni bir
  **"Bütçe Sapması ve Tamamlanma Tahmini (YF-407)"** bölümü eklendi. Dashboard/
  nakit akışı/organizasyon bütçe export'larının sayfa yapısı ve alanları
  değişmedi (bkz. `tests/report-export-excel.test.ts` mevcut testleri —
  regresyonsuz).
- **Hesaplama yeniden yapılmaz.** Export katmanı, §16'nın
  `getProjectBudgetVarianceReport`'unu değil, onun
  `getProjectBudgetVarianceReportForResolvedProject` varyantını çağırır —
  sapma tutarı/yüzdesi, tahmin formülleri ve durum eşiği bu görevde
  **tekrar yazılmaz**; DTO'nun ürettiği string'ler doğrudan biçimlendirilir.
- **Ek proje sorgusu yok.** `exportProjectFinance` artık `project`'i
  `getProjectForUser` ile **tek sefer** çözer ve hem
  `getProjectFinanceSummaryForResolvedProject` hem
  `getProjectBudgetVarianceReportForResolvedProject`'e aynı nesneyi
  paylaştırır (`Promise.all` ile paralel) — YF-407 verisi eklenmeden önce bu
  fonksiyon `getProjectForUser`'ı iki kez çağırıyordu (biri açıkça, biri
  `getProjectFinanceSummary` içinde); bu görev bunu tek sorguya indirger
  (bkz. `tests/report-export-service.test.ts`, "N+1 yok" testi).
- **Veri yoksa uydurulmaz.** `forecast.forecastAvailable = false` olduğunda
  Excel/PDF'de `0` veya boş hücre değil, ekrandakiyle (`ProjectBudgetVarianceSection`)
  birebir aynı `FORECAST_UNAVAILABLE_LABELS` Türkçe nedeni gösterilir. Bütçe
  kalemi girilmemiş projelerde kategori tablosu yerine açık bir not satırı
  gösterilir.
- **Sapma yönü yalnızca renge bırakılmaz.** Hem Excel hem PDF'te sayısal
  tutarın yanında ayrı bir metinsel etiket bulunur: pozitif → "Aşım",
  negatif → "Tasarruf", sıfır → "Dengede" (aynı sözlü kural
  `components/app/project-budget-variance-section.tsx`'teki ok
  ikonlarıyla aynı anlama gelir).
- **Formül enjeksiyonu ve Decimal→Excel sınırı korunur.** Yeni sayfa da
  diğer tüm sayfalar gibi `writeCell`/`sanitizeExcelText` ve
  `toExcelAmountCell` üzerinden geçer; kategori adı gibi kullanıcı
  girdisi içerebilecek serbest metin alanları ayrı bir kod yolundan
  geçirilmez.
- **API sözleşmesi kırılmadı.** `exportProjectFinance(actor, projectId, format)`
  imzası değişmedi; route handler (`app/api/exports/project-finance/route.ts`)
  hiç değiştirilmedi. `401`/cross-tenant `404`/geçersiz format `400`
  davranışları aynen korunur (bkz. `tests/report-export-integration.test.ts`,
  değiştirilmedi).
