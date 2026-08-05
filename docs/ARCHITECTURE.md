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
