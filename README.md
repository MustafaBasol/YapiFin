# YapiFin

**İnşaat firmaları için proje bazlı finans ve maliyet yönetimi.**

YapiFin; Türkiye'deki küçük ve orta ölçekli inşaat firmalarının proje/şantiye bazında gelir, gider, tahsilat, ödeme, kasa-banka, bütçe ve kârlılık takibi yapabilmesi için geliştirilen web uygulamasıdır.

## Mevcut durum

Repository iki kaynağın bilinçli biçimde birleştirilmesiyle başlatılmıştır:

- İnşaat sektörüne göre hazırlanmış Next.js/React arayüz prototipi
- YapiFin ürün gereksinimleri, mimari, güvenlik, veri modeli ve geliştirme planı

Arayüz şu anda demo verileri kullanır. Gerçek kimlik doğrulama, PostgreSQL/Prisma bağlantısı, multi-tenant izolasyon ve finans modülleri geliştirme fazlarında eklenecektir.

## Ürün sınırları

İlk sürüm tam kapsamlı muhasebe veya ERP ürünü değildir. Odak alanları:

- Firma sahibi kaydı ve organizasyon oluşturma
- Firma sahibinin kullanıcı eklemesi/davet etmesi
- Proje bazlı gelir ve gider
- Parçalı tahsilat ve ödeme
- Kasa ve banka hesapları
- Müşteri, tedarikçi ve taşeron takibi
- Bütçe, nakit akışı ve proje kârlılığı
- Türkiye yerelleştirmesi: Türkçe, TRY, GG.AA.YYYY, 24 saat

İlk sürümde görüntüleyici rolü yoktur. Roller: `OWNER`, `ADMIN`, `FINANCE`, `PROJECT_MANAGER`.

## Teknoloji

- Next.js 16 / React 19 / TypeScript
- Tailwind CSS 4
- Prisma ORM / PostgreSQL
- Auth.js veya eşdeğer güvenli oturum yönetimi
- Recharts
- React Hook Form + Zod (uygulama fazında)

## Yerel geliştirme

```bash
npm ci
cp .env.example .env.local
docker compose up -d db
npm run dev
```

Prisma bağımlılıkları ve migration komutları ilk altyapı fazında package.json'a eklenecektir.

## Claude Code ile başlama

Claude Code önce aşağıdaki dosyaları okumalıdır:

1. `CLAUDE.md`
2. `prompts/CLAUDE_CODE_MASTER_PROMPT.md`
3. `docs/PRODUCT_REQUIREMENTS.md`
4. `docs/ARCHITECTURE.md`
5. `docs/DATA_MODEL.md`
6. `docs/UX_UI.md`
7. `docs/SECURITY.md`
8. `docs/IMPLEMENTATION_PLAN.md`
9. `docs/ACCEPTANCE_CRITERIA.md`

## Alan adı

- Ürün: **YapiFin**
- Ana alan adı: **yapifin.com**
