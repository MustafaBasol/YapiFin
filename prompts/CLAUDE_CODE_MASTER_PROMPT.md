# Claude Code Ana Uygulama Promptu

Bu repository içinde Türkiye'deki inşaat firmaları için proje/şantiye bazlı gelir-gider, tahsilat-ödeme, kasa-banka, bütçe ve kârlılık takip web uygulamasını geliştir.

Önce sırayla şu dosyaları oku:

1. `CLAUDE.md`
2. `docs/PRODUCT_REQUIREMENTS.md`
3. `docs/ARCHITECTURE.md`
4. `docs/DATA_MODEL.md`
5. `docs/UX_UI.md`
6. `docs/SECURITY.md`
7. `docs/IMPLEMENTATION_PLAN.md`
8. `docs/ACCEPTANCE_CRITERIA.md`

## Temel kararlar

- Hedef ülke Türkiye.
- Tek dil Türkçe.
- Varsayılan para birimi TRY.
- Tarih GG.AA.YYYY, saat 24 saat.
- Tasarım NoraMedi tarzında temiz, profesyonel, açık renkli, petrol/lacivert + turkuaz vurgu renkli yönetim paneli.
- İlk sürümde görüntüleyici rolü yok.
- Firma sahibi kendisi kayıt olur; diğer kullanıcıları OWNER veya ADMIN davet eder.
- Roller: OWNER, ADMIN, FINANCE, PROJECT_MANAGER.
- Uygulama baştan multi-tenant olmalı.
- Bu ürün tam muhasebe veya ERP değildir.

## Teknik beklenti

- Next.js App Router + TypeScript
- PostgreSQL + Prisma
- Tailwind CSS + shadcn/ui
- Güvenli session tabanlı auth
- React Hook Form + Zod
- Modüler monolit
- Docker Compose
- CI: lint, typecheck, test, build

Kesin sürümleri seçerken resmi dokümanlardan güncel kararlı sürümleri doğrula ve lockfile üret.

## Çalışma yöntemi

- Önce Faz 0 ve Faz 1'i uygula.
- Kod yazmadan önce yalnız ilgili source root ve dosyalarda hedefli CodeGraph kullan.
- Tüm projeyi tarama; token kullanımını minimize et.
- Her aşamada tenant izolasyonu ve rol testlerini öncele.
- Büyük tek commit yerine küçük, anlamlı commitler hazırla.
- Her faz sonunda çalışan uygulama, test sonucu ve kalan işleri raporla.

## İlk teslim kapsamı

1. Çalışan proje iskeleti
2. Docker ile PostgreSQL
3. Prisma şeması ve migration
4. OWNER kayıt/onboarding
5. Login/logout ve parola sıfırlama altyapısı
6. Organizasyon oluşturma
7. Kullanıcı davet ve rol sistemi
8. NoraMedi benzeri dashboard layout
9. Proje CRUD
10. Tenant/rol güvenlik testleri

UI'daki hiçbir son kullanıcı metni İngilizce kalmamalıdır. Teknik enum ve kod isimleri İngilizce olabilir.
