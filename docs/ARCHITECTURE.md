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
- Ayrı staging ve production ortamları
