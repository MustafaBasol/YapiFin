# İlk repository aktarım notları

Bu başlangıç commit'i aşağıdaki kararlarla hazırlanmıştır:

- Buildr arayüz prototipi YapiFin markasına uyarlanmıştır.
- Ürün adı `YapiFin`, alan adı `yapifin.com` olarak tanımlanmıştır.
- Buildr tanıtım videoları, setup ekran görüntüleri ve eski kurulum talimatları repoya alınmamıştır.
- YapiFin ürün gereksinimleri, mimari, veri modeli, güvenlik, UX/UI, kabul kriterleri ve geliştirme planı eklenmiştir.
- Başlangıç Prisma şeması ve PostgreSQL Docker Compose dosyası eklenmiştir.
- Mevcut ekranlar hâlâ demo veri kullanmaktadır; gerçek backend ve auth henüz uygulanmış değildir.
- Ürün yalnızca Türkçe ve Türkiye pazarı için geliştirilecektir.

## İlk doğrulama

Bu paket hazırlanırken `npm ci` denendi. Çalışma ortamının özel npm registry'si `zod-validation-error@4.0.2` paketini döndürmediği için kurulum tamamlanamadı. Yerel bilgisayarda standart npm registry ile şu komutlar çalıştırılmalıdır:

```powershell
npm config set registry https://registry.npmjs.org/
npm ci
npm run lint
npm run build
```
