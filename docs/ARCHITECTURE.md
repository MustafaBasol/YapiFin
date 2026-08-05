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
