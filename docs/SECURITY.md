# Güvenlik ve Veri Bütünlüğü

## 1. Yetkilendirme matrisi

| İşlem | OWNER | ADMIN | FINANCE | PROJECT_MANAGER |
|---|---:|---:|---:|---:|
| Firma ayarları | Evet | Sınırlı | Hayır | Hayır |
| Kullanıcı yönetimi | Evet | Evet | Hayır | Hayır |
| Tüm projeleri görme | Evet | Evet | Evet | Hayır |
| Atanmış projeyi görme | Evet | Evet | Evet | Evet |
| Gelir oluşturma | Evet | Evet | Evet | Hayır |
| Gider oluşturma | Evet | Evet | Evet | Atanmış projede |
| Tahsilat/ödeme | Evet | Evet | Evet | Hayır |
| Kasa/banka bakiyesi | Evet | Evet | Evet | Hayır |
| Raporlar | Evet | Evet | Evet | Atanmış proje özeti |

## 2. Kritik kontroller

- Her mutation için organization scope.
- PROJECT_MANAGER için project membership kontrolü.
- İstemciden gelen role, organizationId ve owner bilgisine güvenme.
- OWNER rolü son owner ise kaldırılamaz.
- Kullanıcı kendi rolünü yükseltemez.
- ADMIN, OWNER üzerinde işlem yapamaz.
- Davet yalnız organizasyon içinden oluşturulabilir.

## 3. Finansal güvenlik

- Tutarlar pozitif olmalı.
- Tahsilat toplamı gelir toplamını aşamaz.
- Ödeme toplamı gider toplamını aşamaz.
- Kaynak ve hedef hesap aynı olamaz.
- Yetersiz bakiye kontrolü: **Faz 3 kararı** — MVP'de negatif bakiyeye izin verilmez. Kasa/banka bakiyesini negatife düşürecek her ödeme, transfer veya ters kayıt `SELECT ... FOR UPDATE` ile kilitlenen hesap üzerinden reddedilir (bkz. `server/services/ledger.ts`, `settlement-service.ts`, `transfer-service.ts`). Bu, dokümantasyonda "ürün kararına göre" olarak bırakılan noktanın somutlaştırılmasıdır.
- İptal işlemi silme değil ters kayıt üretmelidir.
- İptal nedeni zorunludur.

## 4. Audit log

Aşağıdaki olaylar zorunlu loglanır:

- Kullanıcı daveti/rol değişikliği/pasifleştirme
- Proje oluşturma/durum değişikliği
- Gelir ve gider oluşturma/düzenleme/iptal
- Tahsilat ve ödeme oluşturma/iptal
- Transfer ve manuel düzeltme
- Firma ayarı değişikliği

## 5. Uygulama güvenliği

- CSRF koruması
- XSS'e karşı güvenli render
- SQL injection'a karşı ORM ve doğrulama
- Rate limiting
- Güvenli headers
- Dosya yüklemede mime/uzantı/boyut kontrolü
- Zararlı dosya taramasına hazır mimari
- Hassas env değişkenleri repoya yazılmaz
