# Backup & Restore Runbook

**Bağlı belgeler**: [README.md](./README.md) · [DEPLOYMENT_RUNBOOK.md](./DEPLOYMENT_RUNBOOK.md) · [ROLLBACK_RUNBOOK.md](./ROLLBACK_RUNBOOK.md) · [INCIDENT_RESPONSE_RUNBOOK.md](./INCIDENT_RESPONSE_RUNBOOK.md)

## Mevcut durum

❌ **Repository'de otomatik/zamanlanmış bir backup mekanizması yoktur.** `scripts/` dizininde yalnızca iki dosya vardır: `publish-initial-repository.ps1` (tek seferlik repo bootstrap script'i) ve `run-export-integration-tests.mjs` (test altyapısı) — ikisi de backup/restore ile ilgisizdir. `docs/PRODUCTION_READINESS.md` risk kaydında **R-5** ("backup/restore hiç test edilmemiş") risk kaydındaki **tek koşulsuz launch-blocker** olarak işaretlenmiştir.

Bu belge, ilk kez uçtan uca bir mantıksal yedekleme/restore prosedürü tanımlar. Aşağıdaki komutlar **PostgreSQL standart araçlarına** (`pg_dump`/`pg_restore`/`psql`) dayanır; repository'ye özgü bir backup script'i yazılmamıştır (bu görev "runtime kodunu değiştirme" kısıtı altındadır — bir backup **script**i eklemek ayrı bir uygulama görevi olarak takip edilmelidir, aşağıda 💡 işaretlidir).

⚠️ **Bu belgedeki hiçbir destructive komut production üzerinde doğrudan çalıştırılmamalıdır.** Restore prosedürleri her zaman ayrı/izole bir ortamda test edilmeli; production'a geri yükleme yalnızca [INCIDENT_RESPONSE_RUNBOOK.md](./INCIDENT_RESPONSE_RUNBOOK.md) akışıyla tetiklenen, karar yetkilisi onaylı bir olay sırasında yapılır.

## Yedeklenecek veri ve hassasiyet

`prisma/schema.prisma`'da tanımlı tüm tablolar tek bir PostgreSQL veritabanında (`DATABASE_URL` ile işaret edilen) tutulur — ayrı bir dosya depolama/blob store yoktur (export'lar bellekte üretilir, diske yazılmaz; bkz. [README.md](./README.md)). Bu nedenle **tam veritabanı yedeği = tam uygulama verisi yedeği**.

🔒 Veri hassasiyeti: veritabanı, birden fazla organizasyonun (tenant) finansal kayıtlarını (`FinancialTransaction`, `Settlement`, `AccountMovement`, `AccountTransfer`), kullanıcı kimlik bilgilerini (`User.passwordHash` — bcrypt hash, ham parola değil), oturum token hash'lerini (`Session.tokenHash`) ve denetim kayıtlarını (`AuditLog`) içerir. Bu nedenle **her yedek, en az production veritabanının kendisi kadar hassas kabul edilmeli** ve şifrelenmeden saklanmamalıdır.

## PostgreSQL mantıksal yedek (logical backup)

### Manuel mantıksal yedek alma

```bash
PGPASSWORD='<db-password>' pg_dump \
  --host=<db-host> \
  --port=<db-port> \
  --username=<db-user> \
  --dbname=<db-name> \
  --format=custom \
  --file="yapifin_$(date +%Y%m%d_%H%M%S).dump"
```

- `--format=custom`: `pg_restore` ile seçici/paralel restore imkânı verir (düz SQL dump'a göre tercih edilir).
- 🔧 `<db-host>`, `<db-port>`, `<db-user>`, `<db-name>`, parola — operatör tarafından production `DATABASE_URL`'den doldurulur; bu belge gerçek bağlantı bilgisi içermez.
- Komut, uygulamanın kendisini durdurmaz; PostgreSQL `pg_dump` MVCC snapshot'ı üzerinden tutarlı bir görüntü alır (çalışan uygulamayla eşzamanlı çalıştırılabilir).

### Checksum

```bash
sha256sum "yapifin_<timestamp>.dump" > "yapifin_<timestamp>.dump.sha256"
```

Yedek dosyasının bütünlüğünü sonradan doğrulamak için checksum, yedekle birlikte saklanmalıdır.

### Backup encryption

❌ `pg_dump` çıktısı varsayılan olarak şifrelenmemiştir. 💡 **Önerilen production standardı**:

```bash
gpg --symmetric --cipher-algo AES256 --output "yapifin_<timestamp>.dump.gpg" "yapifin_<timestamp>.dump"
rm "yapifin_<timestamp>.dump"   # şifrelenmemiş kopyayı diskte bırakma
```

🔧 GPG parolası/anahtarı bir secret manager'da saklanmalı, backup dosyasıyla birlikte commit/paylaşılmamalıdır.

### Off-site storage

❌ Repository'de bir off-site depolama entegrasyonu yoktur. 💡 **Önerilen**: şifrelenmiş yedek, üretim DB'siyle aynı fiziksel/bulut bölgesinde tutulmamalı; ayrı bir depolama hesabına/bölgeye (ör. object storage, ayrı bir bulut sağlayıcı bölgesi) 🔧 operatör tarafından yüklenmelidir.

### Retention önerisi

💡 **Başlangıç önerisi** (repository'den türetilmiş bir zorunluluk değildir, iş gereksinimlerine göre kalibre edilmeli):

| Yedek türü | Saklama süresi |
|---|---|
| Günlük | 14 gün |
| Haftalık | 8 hafta |
| Aylık | 12 ay |

🔧 Gerçek retention politikası, veri saklama/mevzuat gereksinimlerine göre işletme tarafından onaylanmalıdır (finansal kayıtlar için Türkiye mevzuatındaki saklama süreleri bu belgenin kapsamı dışındadır — muhasebe/hukuk danışmanlığı gerektirir).

### Fiziksel/snapshot katmanı (mümkünse)

💡 Eğer PostgreSQL yönetilen bir bulut servisinde çalışıyorsa (ör. sağlayıcının kendi managed Postgres'i), sağlayıcının native snapshot/point-in-time-recovery özelliği mantıksal `pg_dump` yedeğine **ek olarak** (yerine değil) kullanılmalı — snapshot'lar genelde daha hızlı restore sağlar ama sağlayıcıya kilitlidir; mantıksal yedek taşınabilirlik/doğrulanabilirlik sağlar. 🔧 Hangi sağlayıcı/servis kullanılacağı bu görevin kapsamında değildir.

### Point-in-time recovery (PITR)

❌ Repository'de veya bu görev kapsamında PITR yapılandırması **yoktur**. 💡 **Önerilen production standardı**: PostgreSQL WAL arşivleme (`archive_mode=on` + sürekli WAL gönderimi) veya yönetilen servisin PITR özelliği etkinleştirilerek, günlük dump'lar arasındaki veri kaybı penceresi daraltılabilir. Bu, mevcut günlük mantıksal yedek modelinde **RPO'nun bir günden fazla olabileceği** anlamına gelir (bkz. [RPO/RTO](#rpo--rto)) — PITR eklenmesi ayrı bir altyapı görevi olarak işaretlenmiştir.

## Backup doğrulaması

Bir yedeğin "geçerli" sayılabilmesi için:

1. **Checksum doğrulaması**: `sha256sum -c yapifin_<timestamp>.dump.sha256` — dosya bütünlüğü.
2. **Yapısal doğrulama**: `pg_restore --list yapifin_<timestamp>.dump` komutu hatasız çalışmalı ve beklenen tabloları (ör. `"Organization"`, `"User"`, `"FinancialTransaction"`) listelemeli.
3. **Periyodik restore testi** (aşağıya bakın) — yalnızca dosyanın bozuk olmadığını değil, **fiilen geri yüklenebilir** olduğunu doğrular. Checksum + yapısal doğrulama tek başına yeterli değildir; `docs/PRODUCTION_READINESS.md` R-5'in vurguladığı asıl eksik budur.

### Restore testinin periyodik yapılması

💡 **Önerilen**: Ayda en az bir kez, aşağıdaki [Restore prosedürü](#restore-prosedürü) izole bir ortamda uçtan uca çalıştırılmalı ve sonuç (başarılı/başarısız, süre, karşılaşılan sorun) kayıt altına alınmalıdır. Bu, R-5 riskini kapatmanın tek yoludur — "yedek alınıyor" ile "yedekten geri dönülebiliyor" farklı iddialardır.

## Restore prosedürü

⚠️ **DESTRUCTIVE — yalnızca izole/boş bir ortamda çalıştırılmalıdır. Production veritabanına karşı doğrudan çalıştırmayın.**

### 1. İzole/boş environment hazırla

```bash
createdb -h <restore-host> -U <restore-user> yapifin_restore_test
```

🔧 Bu, production `DATABASE_URL`'inden **tamamen ayrı** bir host/instance veya en azından ayrı bir veritabanı adı olmalıdır. Asla production veritabanı adının üzerine restore etmeyin.

### 2. Şifre çözme (eğer şifrelenmişse)

```bash
gpg --decrypt --output "yapifin_<timestamp>.dump" "yapifin_<timestamp>.dump.gpg"
```

### 3. Restore

```bash
PGPASSWORD='<restore-db-password>' pg_restore \
  --host=<restore-host> \
  --port=<restore-port> \
  --username=<restore-user> \
  --dbname=yapifin_restore_test \
  --clean --if-exists \
  --no-owner \
  "yapifin_<timestamp>.dump"
```

⚠️ `--clean --if-exists`, hedef veritabanındaki mevcut nesneleri **düşürüp yeniden oluşturur** — bu nedenle hedefin gerçekten izole/boş bir test veritabanı olduğundan emin olun.

### 4. Restore sonrası Prisma/schema kontrolü

```bash
DATABASE_URL="postgresql://<restore-user>:<restore-db-password>@<restore-host>:<restore-port>/yapifin_restore_test?schema=public" \
  npx prisma validate

DATABASE_URL="postgresql://<restore-user>:<restore-db-password>@<restore-host>:<restore-port>/yapifin_restore_test?schema=public" \
  npx prisma migrate status
```

`prisma migrate status` çıktısının, yedeğin alındığı andaki migration geçmişiyle eşleştiğini doğrulayın (repoda şu an `20260805125134_init`, `20260805143103_faz3_financial_hardening`).

### 5. Schema migration ile backup uyumu

Eğer restore edilen yedek, mevcut `prisma/schema.prisma`'dan **daha eski** bir migration durumundaysa (ör. yedek, yeni bir migration deploy edilmeden önce alınmış), restore sonrası eksik migration'ları uygulamak için:

```bash
DATABASE_URL="postgresql://<restore-user>:<restore-db-password>@<restore-host>:<restore-port>/yapifin_restore_test?schema=public" \
  npx prisma migrate deploy
```

⚠️ Eğer o migration'lar arasında **destructive** bir migration (kolon/tablo silme) varsa, bu adım restore edilen veriyi geri dönülemez şekilde değiştirir — [ROLLBACK_RUNBOOK.md — destructive veya non-reversible migration](./ROLLBACK_RUNBOOK.md#destructive-veya-non-reversible-migration) bölümündeki dikkat noktaları burada da geçerlidir.

### 6. Tenant ve finansal veri doğrulama örnekleri

Restore edilen veritabanında, yedek alınmadan önce bilinen birkaç referans değerle karşılaştırma yapın (🔧 operatör, restore öncesi bu referans değerleri production'dan not almalı):

```sql
-- Organizasyon sayısı beklenenle eşleşiyor mu
SELECT count(*) FROM "Organization";

-- Belirli bir organizasyonun finansal işlem toplamı beklenenle eşleşiyor mu
SELECT "organizationId", count(*), sum("totalAmount")
FROM "FinancialTransaction"
WHERE "cancelledAt" IS NULL
GROUP BY "organizationId"
ORDER BY count(*) DESC
LIMIT 5;

-- Hesap bakiyeleri (AccountMovement) tutarlı mı — negatif olmayan bakiye kuralı ihlal edilmiş mi
SELECT "financialAccountId", sum(amount) AS balance
FROM "AccountMovement"
GROUP BY "financialAccountId"
HAVING sum(amount) < 0;
```

Son sorgu boş sonuç dönmelidir (`ledger.ts`/`settlement-service.ts`/`transfer-service.ts` içindeki `SELECT ... FOR UPDATE` satır kilitleme mantığı negatif bakiyeyi engelleyecek şekilde tasarlanmıştır — restore sonrası bu invariant'ın bozulmadığını doğrulamak, veri bütünlüğü kontrolünün parçasıdır).

### 7. Audit kanıtının korunması

Restore testinin kendisi bir operasyonel olaydır ve iz bırakmalıdır: hangi yedek dosyasının, ne zaman, kim tarafından, hangi ortama restore edildiği kayıt altına alınmalıdır (🔧 operatör, kurumun kullandığı sistemde). Restore testi sırasında **`AuditLog` tablosundaki mevcut kayıtlar değiştirilmemeli/silinmemelidir** — test veritabanı production'dan tamamen izole olduğu için bu zaten doğal olarak sağlanır, ancak restore sonrası test veritabanı üzerinde ek "temizlik" işlemi yapılacaksa `AuditLog` tablosuna dokunulmamalıdır.

## RPO / RTO

❌ Repository'de tanımlı bir RPO/RTO hedefi yoktur — bu, teknik bir doküman kararı değil, **işletme tarafından onaylanması gereken bir iş kararıdır**.

🔧 **Operatör/işletme tarafından doldurulacak**:

| Metrik | Tanım | Hedef |
|---|---|---|
| RPO (Recovery Point Objective) | Bir felaket anında ne kadarlık veri kaybı kabul edilebilir | 🔧 (günlük mantıksal yedek modeliyle, PITR olmadan, en iyi ihtimalle ~24 saat — bkz. [Point-in-time recovery](#point-in-time-recovery-pitr)) |
| RTO (Recovery Time Objective) | Bir felaket sonrası hizmetin ne kadar sürede geri gelmesi gerekiyor | 🔧 (restore prosedürünün fiili süresi periyodik testlerle ölçülmeli, bu belge bir süre taahhüt etmez) |

Bu hedefler onaylanana kadar, mevcut (yalnızca günlük manuel dump varsayımlı) model **en iyi ihtimalle ~24 saatlik RPO** sunar — bu, birden fazla tenant'ın finansal verisi için işletme tarafından kabul edilebilir olup olmadığı ayrıca değerlendirilmelidir.

## Bilinen eksikler (takip görevleri)

| Eksik | Etki | Önerilen takip |
|---|---|---|
| Otomatik/zamanlanmış backup yok | Backup'ın alınması tamamen manuel disipline bağlı | Zamanlanmış bir backup job'u (cron/managed servis) eklenmesi — ayrı görev |
| Restore hiç test edilmemiş (R-5) | Yedeğin fiilen işe yarayıp yaramadığı bilinmiyor | Bu belgedeki restore prosedürünün ilk kez uçtan uca çalıştırılıp sonuçlarının kayıt altına alınması |
| PITR yok | RPO ~24 saat ile sınırlı | WAL arşivleme veya managed PITR değerlendirmesi |
| Off-site storage entegrasyonu yok | Tek bölge/host kaybında yedek de kaybolabilir | Object storage / ayrı bölge hedefi belirlenmesi |
| RPO/RTO işletme tarafından onaylanmamış | Beklenti netleşmemiş | İşletme ile RPO/RTO hedefinin resmileştirilmesi |
