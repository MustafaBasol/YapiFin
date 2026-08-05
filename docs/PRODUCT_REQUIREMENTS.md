# Ürün Gereksinimleri

## 1. Ürün özeti

İnşaat Finans, Türkiye'deki inşaat firmalarının proje ve şantiye bazında gelir, gider, tahsilat, ödeme, kasa-banka ve bütçe takibi yapmasını sağlayan basit bir SaaS web uygulamasıdır.

## 2. Kapsam sınırı

MVP bir ön muhasebe, e-fatura, bordro veya resmî defter uygulaması değildir. Resmî muhasebe kayıtlarının yerine geçmez.

## 3. Kullanıcılar ve roller

### OWNER

- Firma kaydı oluşturur.
- Tüm modüllere erişir.
- Kullanıcı ekler, davet eder, pasifleştirir.
- Rolleri ve proje yetkilerini yönetir.
- Firma ayarlarını değiştirir.

### ADMIN

- OWNER dışındaki kullanıcıları yönetebilir.
- Tüm projeleri ve finansal verileri görebilir.
- Firma sahibini silemez veya rolünü değiştiremez.

### FINANCE

- Gelir/gider oluşturur ve düzenler.
- Tahsilat ve ödeme kaydı girer.
- Finansal hesapları yönetir.
- Raporları görür ve dışa aktarır.
- Kullanıcı ve firma ayarlarını yönetemez.

### PROJECT_MANAGER

- Sadece atandığı projeleri görür.
- Atandığı projelere gider ve belge girebilir.
- Gelir bilgilerini görme yetkisi ayrı izin olarak değerlendirilebilir; MVP'de varsayılan olarak proje finans özeti görebilir, kullanıcı yönetemez.
- Kasa/banka genel bakiyelerini göremez.

## 4. Kimlik doğrulama ve onboarding

### Firma sahibi kaydı

Alanlar:

- Ad
- Soyad
- E-posta
- Telefon
- Parola
- Firma ticari adı
- İl
- İlçe
- Vergi dairesi (opsiyonel)
- Vergi numarası (opsiyonel)

Akış:

1. OWNER hesap oluşturur.
2. E-posta doğrulaması yapılır.
3. Organizasyon oluşturulur.
4. Varsayılan kategoriler ve `Ana Kasa` hesabı otomatik oluşturulur.
5. Kullanıcı dashboard'a yönlendirilir.

### Kullanıcı ekleme

- Açık kayıt yoktur.
- OWNER/ADMIN kullanıcıyı e-posta ile davet eder.
- Davette rol ve gerekiyorsa proje erişimi seçilir.
- Davet süresi dolabilir ve yeniden gönderilebilir.

## 5. Modüller

### 5.1 Dashboard

Gösterilecek metrikler:

- Bu ay tahsil edilen
- Bu ay ödenen
- Net nakit akışı
- Bekleyen alacak
- Bekleyen borç
- Vadesi geçen alacak
- Vadesi geçen borç
- Toplam kasa/banka bakiyesi
- Aktif proje sayısı
- Bütçesi kritik projeler

Grafikler:

- Son 12 ay gelir-gider
- Projelere göre gerçekleşen maliyet
- Gider kategorisi dağılımı

Listeler:

- Yaklaşan tahsilatlar
- Yaklaşan ödemeler
- Son işlemler

### 5.2 Projeler

Alanlar:

- Proje adı
- Proje kodu
- Müşteri/işveren
- İl, ilçe, adres
- Başlangıç tarihi
- Planlanan bitiş tarihi
- Sözleşme bedeli
- Tahmini bütçe
- Durum: TASLAK, AKTİF, BEKLEMEDE, TAMAMLANDI, İPTAL
- Açıklama
- Proje sorumluları

Proje detay sekmeleri:

- Genel bakış
- Gelirler
- Giderler
- Tahsilatlar
- Ödemeler
- Bütçe
- Belgeler
- Ekip

### 5.3 Müşteriler

- Ad/ünvan
- Tür: BİREYSEL, KURUMSAL
- TCKN/VKN opsiyonel
- Telefon
- E-posta
- Adres
- İlgili kişi
- İlişkili projeler
- Toplam sözleşme bedeli
- Tahsil edilen
- Kalan alacak

### 5.4 Tedarikçi ve taşeronlar

- Ad/ünvan
- Tür: TEDARİKÇİ, TAŞERON, HER_İKİSİ
- VKN/TCKN opsiyonel
- Vergi dairesi
- Telefon
- E-posta
- Adres
- İlgili kişi
- İlişkili projeler
- Toplam borç ve ödeme

### 5.5 Gelirler

Alanlar:

- Proje
- Müşteri
- Kategori
- Açıklama
- Belge/fatura no
- Belge tarihi
- Vade tarihi
- Ara toplam
- KDV oranı
- KDV tutarı
- Genel toplam
- Para birimi
- Durum
- Not

Varsayılan kategoriler:

- Avans
- Hakediş
- Ara ödeme
- Ek iş
- Proje teslim ödemesi
- Malzeme satışı
- Diğer gelir

### 5.6 Giderler

Alanlar:

- Proje
- Tedarikçi/taşeron
- Kategori ve alt kategori
- Açıklama
- Belge/fatura no
- Belge tarihi
- Vade tarihi
- Ara toplam
- KDV oranı
- KDV tutarı
- Genel toplam
- Para birimi
- Durum
- Not

Varsayılan ana kategoriler:

- İnşaat malzemesi
- İşçilik
- Taşeron
- Nakliye
- Makine ve ekipman
- Araç ve yakıt
- Kira
- Ruhsat ve resmî harçlar
- Sigorta
- Vergi
- Personel
- Ofis
- Diğer

### 5.7 Tahsilat ve ödemeler

- Bir gelir birden fazla tahsilata bölünebilir.
- Bir gider birden fazla ödemeye bölünebilir.
- Her hareket bir finansal hesaba bağlanır.
- Fazla ödeme varsayılan olarak engellenir.
- İptal edilen hareket bakiyeyi ters kayıtla düzeltmelidir.

### 5.8 Kasa ve banka

Hesap türleri:

- NAKİT
- BANKA
- KREDİ_KARTI
- ORTAK_HESABI
- DİĞER

İşlemler:

- Açılış bakiyesi
- Tahsilat
- Ödeme
- Hesaplar arası transfer
- Manuel düzeltme: yalnız OWNER/ADMIN ve zorunlu açıklama ile

### 5.9 Bütçe

- Proje genel bütçesi
- Kategori bazlı bütçe kalemleri
- Gerçekleşen gider
- Kalan bütçe
- Gerçekleşme oranı
- %80 ve %100 eşik uyarıları

### 5.10 Raporlar

MVP raporları:

- Proje kârlılık özeti
- Aylık gelir-gider
- Nakit akışı
- Bekleyen/vadesi geçen alacaklar
- Bekleyen/vadesi geçen borçlar
- Tedarikçi bazlı borç
- Müşteri bazlı alacak
- Gider kategorisi analizi

Dışa aktarma:

- Excel/CSV ilk tercih
- PDF sonraki iterasyonda

## 6. Finansal hesaplama kuralları

- `Toplam gelir`: iptal edilmemiş gelirlerin toplamı
- `Tahsil edilen`: aktif tahsilatların toplamı
- `Bekleyen alacak`: gelir toplamı - tahsilat toplamı
- `Toplam gider`: iptal edilmemiş giderlerin toplamı
- `Ödenen`: aktif ödemelerin toplamı
- `Bekleyen borç`: gider toplamı - ödeme toplamı
- `Nakit akışı`: tahsilatlar - ödemeler
- `Tahmini proje kârı`: toplam beklenen gelir - tahmini bütçe
- `Gerçekleşen kâr`: hak edilmiş/oluşmuş gelir - gerçekleşen gider

## 7. MVP dışı

- E-fatura/e-arşiv
- Banka API entegrasyonu
- Bordro
- Stok/depo yönetimi
- Satın alma onay akışları
- Hakediş metraj motoru
- OCR ve yapay zekâ
- Mobil native uygulama
- Çoklu dil
- Çoklu ülke vergi kuralları
