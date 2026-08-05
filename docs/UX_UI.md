# UX/UI Tasarım Dokümanı

## 1. Görsel yön

NoraMedi benzeri modern, güven veren ve sade bir yönetim paneli hedeflenir.

Karakter:

- Profesyonel
- Temiz
- Kurumsal
- Fazla renkli olmayan
- Finansal veriyi hızlı okumaya uygun

## 2. Ana iskelet

### Sol menü

- Dashboard
- Projeler
- Gelirler
- Giderler
- Tahsilatlar
- Ödemeler
- Kasa ve Banka
- Müşteriler
- Tedarikçiler / Taşeronlar
- Raporlar
- Kullanıcılar
- Ayarlar

PROJECT_MANAGER için yetkisiz menüler gizlenir.

### Üst bar

- Sayfa başlığı
- Aktif proje filtresi
- Hızlı işlem butonu
- Bildirimler
- Kullanıcı menüsü

## 3. Tasarım tokenları

Önerilen CSS değişkenleri:

```css
:root {
  --background: 210 25% 98%;
  --foreground: 218 30% 15%;
  --card: 0 0% 100%;
  --card-foreground: 218 30% 15%;
  --primary: 202 65% 23%;
  --primary-foreground: 0 0% 100%;
  --accent: 174 62% 40%;
  --accent-foreground: 0 0% 100%;
  --muted: 210 20% 94%;
  --muted-foreground: 215 15% 45%;
  --border: 214 22% 88%;
  --success: 152 55% 38%;
  --warning: 38 92% 50%;
  --danger: 0 72% 51%;
  --radius: 0.75rem;
}
```

## 4. Dashboard düzeni

Üst sıra:

- Bu Ay Tahsilat
- Bu Ay Ödeme
- Net Nakit Akışı
- Toplam Bakiye

İkinci sıra:

- 12 aylık gelir-gider grafiği: geniş kart
- Vadesi yaklaşanlar: sağ kolon

Üçüncü sıra:

- Proje kârlılık tablosu
- Gider kategori dağılımı

## 5. Tablo standardı

- Arama
- Tarih aralığı
- Proje filtresi
- Durum filtresi
- Kategori filtresi
- Sütun seçimi opsiyonel
- Sağda satır aksiyon menüsü
- Mobilde kart listesine dönüşüm

## 6. Form standardı

- İki kolon desktop, tek kolon mobil
- Tutar alanında binlik ayraçlı Türkçe giriş
- KDV oranı için 0, 1, 10, 20 ve özel oran
- Hesaplanan KDV ve genel toplam anlık gösterilir
- Kaydet ve yeni ekle seçeneği
- Zorunlu alanlar açıkça belirtilir

## 7. Hızlı gider girişi

Mobil öncelikli modal/sayfa:

1. Proje
2. Tedarikçi
3. Kategori
4. Toplam tutar
5. Belge tarihi
6. Fotoğraf/belge
7. Kaydet

Gelişmiş alanlar açılır bölümde bulunur.

## 8. Durum rozetleri

- Açık: gri/mavi
- Kısmen ödendi: amber
- Ödendi/Tahsil edildi: yeşil
- Vadesi geçti: kırmızı
- İptal: nötr kırmızı çizgili

## 9. Türkçe metin örnekleri

- “Yeni gelir ekle”
- “Yeni gider ekle”
- “Tahsilat kaydet”
- “Ödeme kaydet”
- “Bu işlem iptal edilecek ve hesap hareketi ters kayıtla düzeltilecektir.”
- “Henüz proje eklenmemiş.”
- “Vadesi geçen 4 alacak bulunuyor.”
