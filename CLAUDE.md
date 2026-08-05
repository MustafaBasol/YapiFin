# Claude Code Proje Talimatları

## Zorunlu çalışma biçimi

1. Önce bu dosyayı ve `docs/` klasöründeki ilgili dokümanları oku.
2. Kod yazmadan önce yalnızca ilgili kaynak kökünde hedefli CodeGraph analizi yap.
3. Tüm projeyi geniş kapsamlı tarama. Yalnızca değişecek modül, bağımlı servisler, Prisma modeli ve ilgili testleri incele.
4. Token kullanımını azaltmak için hedefli arama, dar kapsamlı dosya okuma ve spesifik sembol sorguları kullan.
5. Geniş proje taraması gerekiyorsa gerekçesini görev raporunda açıkça belirt.
6. Her görevde tenant izolasyonu, rol yetkisi, veri bütünlüğü ve audit log etkisini değerlendir.
7. Büyük görevleri küçük, test edilebilir commit kapsamlarına ayır.
8. Kullanıcı arayüzündeki tüm metinler Türkçe olmalı.
9. Uygulama Türkiye pazarına göre hazırlanmalı: TRY, GG.AA.YYYY, 24 saat, Türkçe sayı biçimi.
10. MVP'yi muhasebe/ERP ürününe dönüştürecek kapsam genişletmelerinden kaçın.

## Mimari ilkeler

- Multi-tenant izolasyon zorunludur.
- Her tenant verisi `organizationId` ile scope edilmelidir.
- Yetkilendirme sadece frontend'de uygulanamaz; tüm backend işlemleri rol ve organizasyon kontrolü yapmalıdır.
- Para tutarlarında floating point kullanılmamalıdır. PostgreSQL `Decimal/Numeric` veya kuruş bazlı integer yaklaşımı kullanılmalıdır.
- Tahsilat ve ödemeler işlem kaydından ayrı tutulmalıdır; parçalı ödeme desteklenmelidir.
- Finansal kayıtlar varsayılan olarak hard delete edilmemeli; iptal/arşiv mantığı kullanılmalıdır.
- Kritik değişiklikler audit log üretmelidir.
- Form ve API doğrulaması ortak Zod şemalarıyla veya eşdeğer tek kaynak yaklaşımıyla yürütülmelidir.

## Tasarım ilkeleri

- NoraMedi benzeri temiz, profesyonel, açık renkli yönetim paneli.
- Sol sabit menü, üst bağlam çubuğu, kart tabanlı dashboard.
- Ana renk: koyu petrol/lacivert tonları.
- Vurgu rengi: turkuaz/teal.
- Tehlike: kırmızı, uyarı: amber, başarı: yeşil.
- Yoğun tablolar yerine okunabilir boşluk, güçlü filtreler ve net durum rozetleri.
- Mobilde hızlı gider girişi önceliklidir.

## Test zorunlulukları

Her işlev için en az şu katmanlar değerlendirilmelidir:

- Unit test
- Yetki/tenant izolasyon testi
- API veya service integration testi
- Kritik kullanıcı akışı testi

Özellikle test edilmesi gerekenler:

- Başka organizasyonun verisine erişim engeli
- PROJECT_MANAGER rolünün sadece atanmış projeleri görmesi
- Parçalı tahsilat/ödeme sonrası kalan tutarın doğru hesaplanması
- Hesaplar arası transferde çift yönlü bakiye etkisi
- Vadesi geçen işlem durumları
- İptal edilmiş finansal kaydın raporlardan doğru hariç tutulması

## Çıktı raporu

Her görev sonunda şunları raporla:

- Değişen dosyalar
- Uygulanan iş kuralları
- Güvenlik ve tenant etkisi
- Çalıştırılan testler
- Bilinen eksikler
- Sonraki mantıklı görev


## Mevcut arayüz prototipi

- Repository içindeki Next.js ekranları eski Buildr prototipinden uyarlanmış görsel başlangıç noktasıdır.
- `lib/demo/data.ts` gerçek veri kaynağı değildir; aşamalı olarak server-side repository/service katmanıyla değiştirilmelidir.
- Çift dil altyapısı kalıntıları bulunabilir. Ürün yalnızca Türkçe olacağı için yeni geliştirmede İngilizce metin veya dil anahtarı eklenmemelidir.
- Mevcut ekranları körlemesine koruma. `docs/PRODUCT_REQUIREMENTS.md` kapsamı kaynak doğrudur.
- Program, keşif, teklif ve gelişmiş hakediş özellikleri MVP finans çekirdeğinden sonra ele alınmalıdır.
