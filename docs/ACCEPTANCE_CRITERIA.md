# Kabul Kriterleri

## Firma kaydı

- Yeni kullanıcı firma sahibi olarak kayıt olabilir.
- Aynı işlemde organizasyon oluşturulur.
- Varsayılan gelir/gider kategorileri ve Ana Kasa oluşur.
- OWNER dışındaki kullanıcılar açık kayıt yapamaz.

## Kullanıcı daveti

- OWNER/ADMIN e-posta, rol ve proje erişimi seçerek davet gönderebilir.
- Süresi dolmuş veya kullanılmış davet tekrar kullanılamaz.
- PROJECT_MANAGER en az bir projeye atanabilir.

## Tenant izolasyonu

- Organizasyon A kullanıcısı Organizasyon B kayıtlarını listeleyemez.
- Bilinen bir başka tenant ID'siyle doğrudan erişim denemesi 404 veya 403 döndürür.
- Export ve rapor sorgularında da aynı izolasyon geçerlidir.

## Gelir/gider

- Tutar ve KDV doğru hesaplanır.
- Vade tarihi geçmiş açık bakiye `Vadesi Geçti` görünür.
- İptal edilen kayıt aktif toplamları etkilemez.
- Finansal kayıt hard delete edilemez.

## Parçalı ödeme

- 100.000 TL gelir için 40.000 TL tahsilatta kalan 60.000 TL görünür.
- İkinci 60.000 TL tahsilatta durum tahsil edildi olur.
- 100.000 TL üzeri toplam tahsilat engellenir.

## Proje yetkisi

- PROJECT_MANAGER yalnız atanmış projeleri görür.
- Atanmadığı projeye gider ekleyemez.
- Genel kasa/banka ekranına erişemez.

## Transfer

- Bir hesaptan diğerine transfer iki bağlı hesap hareketi oluşturur.
- Transfer iptalinde iki hareket de ters kayıtla düzeltilir.
- Kaynak ve hedef hesap aynı seçilemez.

## Türkçe yerelleştirme

- Tüm ekranlar Türkçedir.
- Para biçimi `₺1.250.000,00` veya eşdeğer tr-TR biçimindedir.
- Tarihler `05.08.2026` biçimindedir.
- Saatler 24 saat biçimindedir.
