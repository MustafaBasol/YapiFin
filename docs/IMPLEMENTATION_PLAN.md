# Uygulama Planı

## Faz 0 — Proje kurulumu

- Next.js + TypeScript
- Tailwind + shadcn/ui
- PostgreSQL + Prisma
- Docker Compose
- Lint, typecheck, test ve build CI
- Ortam değişkenleri şeması
- Temel layout ve tasarım tokenları

Çıkış kriteri: Uygulama lokal ortamda tek komutla ayağa kalkar.

## Faz 1 — Auth, organizasyon ve kullanıcı yönetimi

- OWNER kayıt akışı
- Organizasyon oluşturma
- E-posta doğrulama
- Login/logout
- Parola sıfırlama
- Davet sistemi
- Rol yönetimi
- Kullanıcı pasifleştirme

Çıkış kriteri: Açık kayıt yalnız OWNER oluşturur; diğer kullanıcılar davetle katılır.

## Faz 2 — Ana kayıtlar

- Proje CRUD
- Müşteri CRUD
- Tedarikçi/taşeron CRUD
- Gelir/gider kategorileri
- Proje ekip ataması

## Faz 3 — Gelir ve gider

- Gelir CRUD
- Gider CRUD
- KDV hesaplama
- Vade ve durum hesaplama
- Filtreleme ve arama
- İptal akışı

## Faz 4 — Tahsilat, ödeme ve hesaplar

- Finansal hesap CRUD
- Tahsilat
- Ödeme
- Parçalı ödeme
- Hesap hareketleri
- Transfer
- Ters kayıt

## Faz 5 — Dashboard ve raporlar

- KPI kartları
- Aylık grafikler
- Proje kârlılık
- Alacak/borç raporları
- CSV/Excel dışa aktarma

## Faz 6 — Bütçe ve uyarılar

- Kategori bazlı bütçe
- Bütçe eşik uyarıları
- Vade uyarıları
- Bildirim merkezi

## Faz 7 — Belge yükleme ve mobil iyileştirme

- Fatura/fiş yükleme
- Mobil hızlı gider girişi
- Dosya güvenliği

## İlk geliştirme sprinti

1. Repo ve altyapı
2. Prisma temel şema
3. Auth + OWNER onboarding
4. Sidebar/layout
5. Proje CRUD
6. Tenant ve rol testleri
