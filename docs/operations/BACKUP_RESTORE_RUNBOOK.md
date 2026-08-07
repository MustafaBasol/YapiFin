# Backup & Restore Runbook

**Bağlı belgeler**: [README.md](./README.md) · [DEPLOYMENT_RUNBOOK.md](./DEPLOYMENT_RUNBOOK.md) · [ROLLBACK_RUNBOOK.md](./ROLLBACK_RUNBOOK.md) · [INCIDENT_RESPONSE_RUNBOOK.md](./INCIDENT_RESPONSE_RUNBOOK.md)

## Mevcut durum

❌ **Repository'de otomatik/zamanlanmış bir backup mekanizması yoktur.** `docs/PRODUCTION_READINESS.md` risk kaydında **R-5** ("backup/restore hiç test edilmemiş") **tek koşulsuz launch-blocker** olarak işaretlenmiştir.

Bu belge, ilk kez uçtan uca bir mantıksal yedekleme/restore prosedürü tanımlar. Aşağıdaki komutlar **PostgreSQL standart araçlarına** (`pg_dump`/`pg_restore`/`psql`) dayanır; repository'ye özgü otomatik bir backup **alma** script'i yazılmamıştır (bu ayrı bir altyapı görevidir, aşağıda 💡 işaretlidir). ✅ YF-510 kapsamında eklenen tek script, `scripts/db-restore-guard.mjs` — bir backup/otomasyon script'i değil, restore adımından hemen önce çalıştırılan, production'a yanlışlıkla restore edilmesini engelleyen bağımsız bir **güvenlik ön kontrolüdür** (bkz. [Restore prosedürü — adım 2](#2-restore-hedefini-fail-closed-guard-ile-doğrula)). Bu prosedür, YF-510 kapsamında izole/disposable altyapı ve sentetik veriyle uçtan uca **tatbik edilmiş ve doğrulanmıştır** (bkz. [Tatbikat kanıtı](#tatbikat-kanıtı-drill-evidence)).

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

### 2. Restore hedefini fail-closed guard ile doğrula

✅ `scripts/db-restore-guard.mjs` (YF-510), gerçek `pg_restore` komutu çalıştırılmadan önce hedefin bariz bir tek-kullanımlık restore veritabanı olup olmadığını kontrol eden, bağımsız bir ön adımdır. Script parola/connection string **kabul etmez** — yalnızca host/port/db adını değerlendirir ve varsayılan olarak reddeder (fail-closed):

```bash
node scripts/db-restore-guard.mjs --host <restore-host> --db yapifin_restore_test --port <restore-port>
```

- Hedef veritabanı adında `restore`/`drill`/`disposable`/`scratch`/`sandbox` geçmiyorsa **veya** host/db adında `prod` geçiyorsa script `exit 1` ile reddeder ve hiçbir şey silinmez.
- 🔧 Production'ı kesin biçimde tanımlamak isteyen operatörler, `PROD_DB_HOST`/`PROD_DB_NAME` ortam değişkenlerini ayarlayarak birebir eşleşme durumunda koşulsuz reddi etkinleştirebilir.
- Bu script yalnızca bariz hataları (yanlış isimlendirilmiş/hedefsiz komut) yakalar; operatörün hedefi gözle teyit etmesinin **yerine geçmez**.

Guard `exit 0` ile geçmeden restore komutuna devam etmeyin.

### 3. Şifre çözme (eğer şifrelenmişse)

```bash
gpg --decrypt --output "yapifin_<timestamp>.dump" "yapifin_<timestamp>.dump.gpg"
```

### 4. Restore

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

### 5. Restore sonrası Prisma/schema kontrolü

```bash
DATABASE_URL="postgresql://<restore-user>:<restore-db-password>@<restore-host>:<restore-port>/yapifin_restore_test?schema=public" \
  npx prisma validate

DATABASE_URL="postgresql://<restore-user>:<restore-db-password>@<restore-host>:<restore-port>/yapifin_restore_test?schema=public" \
  npx prisma migrate status
```

`prisma migrate status` çıktısının, yedeğin alındığı andaki migration geçmişiyle eşleştiğini doğrulayın (repoda şu an `20260805125134_init`, `20260805143103_faz3_financial_hardening`).

### 6. Schema migration ile backup uyumu

Eğer restore edilen yedek, mevcut `prisma/schema.prisma`'dan **daha eski** bir migration durumundaysa (ör. yedek, yeni bir migration deploy edilmeden önce alınmış), restore sonrası eksik migration'ları uygulamak için:

```bash
DATABASE_URL="postgresql://<restore-user>:<restore-db-password>@<restore-host>:<restore-port>/yapifin_restore_test?schema=public" \
  npx prisma migrate deploy
```

⚠️ Eğer o migration'lar arasında **destructive** bir migration (kolon/tablo silme) varsa, bu adım restore edilen veriyi geri dönülemez şekilde değiştirir — [ROLLBACK_RUNBOOK.md — destructive veya non-reversible migration](./ROLLBACK_RUNBOOK.md#destructive-veya-non-reversible-migration) bölümündeki dikkat noktaları burada da geçerlidir.

### 7. Tenant ve finansal veri doğrulama örnekleri

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

### 8. Audit kanıtının korunması

Restore testinin kendisi bir operasyonel olaydır ve iz bırakmalıdır: hangi yedek dosyasının, ne zaman, kim tarafından, hangi ortama restore edildiği kayıt altına alınmalıdır (🔧 operatör, kurumun kullandığı sistemde). Restore testi sırasında **`AuditLog` tablosundaki mevcut kayıtlar değiştirilmemeli/silinmemelidir** — test veritabanı production'dan tamamen izole olduğu için bu zaten doğal olarak sağlanır, ancak restore sonrası test veritabanı üzerinde ek "temizlik" işlemi yapılacaksa `AuditLog` tablosuna dokunulmamalıdır.

### 9. Tatbikat sonrası temizlik

⚠️ Restore tatbikatı için oluşturulan geçici veritabanı/konteyner **kalıcı bırakılmamalıdır** — aksi halde şifrelenmemiş/hassas veri içeren ek bir kopya sistemde unutulmuş olur.

```bash
dropdb -h <restore-host> -U <restore-user> yapifin_restore_test
rm -f "yapifin_<timestamp>.dump" "yapifin_<timestamp>.dump.gpg" "yapifin_<timestamp>.dump.sha256"
```

Tatbikat, docker-compose dışında ayrıca başlatılmış tek kullanımlık bir konteynerde yapıldıysa, konteyneri ve varsa adlandırılmış volume'unu da kaldırın:

```bash
docker rm -f <drill-container-adı>
docker volume rm <drill-container-adı-ile-ilişkili-volume>   # yalnızca adlandırılmış bir volume oluşturulduysa
```

## Erişim kontrolü

❌ Repository'de bir secret manager / IAM entegrasyonu yoktur — yedek dosyalarına ve restore kimlik bilgilerine erişim tamamen operatör süreçlerine bağlıdır.

💡 **Önerilen production standardı**:

- Yedek dosyalarına (şifrelenmiş `.dump.gpg`) ve GPG şifre çözme anahtarına erişim, production `DATABASE_URL`'e erişimle **aynı yetki seviyesinde** ele alınmalı — bir yedek, production veritabanının kendisi kadar hassastır (bkz. [Yedeklenecek veri ve hassasiyet](#yedeklenecek-veri-ve-hassasiyet)).
- Restore işlemini kimlerin tetikleyebileceği [INCIDENT_RESPONSE_RUNBOOK.md](./INCIDENT_RESPONSE_RUNBOOK.md) akışındaki karar yetkilisi onayına bağlı olmalı; rutin/periyodik restore **tatbikatları** (bu belgedeki gibi, izole ortamda) bu onaya tabi değildir.
- Yedek depolama hesabına erişim, uygulama production kimlik bilgilerinden **ayrı** kimlik bilgileriyle yapılmalı (bir sızıntının her iki erişimi birden açığa çıkarmaması için).
- 🔧 Gerçek IAM/secret manager seçimi ve rol ataması, barındırma altyapısı kararına bağlıdır — bu belgenin kapsamı dışındadır.

## RPO / RTO

❌ Repository'de tanımlı bir RPO/RTO hedefi yoktur — bu, teknik bir doküman kararı değil, **işletme tarafından onaylanması gereken bir iş kararıdır**.

🔧 **Operatör/işletme tarafından doldurulacak**:

| Metrik | Tanım | Hedef |
|---|---|---|
| RPO (Recovery Point Objective) | Bir felaket anında ne kadarlık veri kaybı kabul edilebilir | 💡 **Önerilen (henüz işletme onayı yok): 24 saat.** Günlük mantıksal yedek modeliyle, PITR olmadan ulaşılabilecek en iyi değer budur — bkz. [Point-in-time recovery](#point-in-time-recovery-pitr). 🔧 İşletme daha sıkı bir RPO isterse (ör. 1 saat), önce PITR/WAL arşivleme devreye alınmalıdır; aksi halde hedef fiilen karşılanamaz. |
| RTO (Recovery Time Objective) | Bir felaket sonrası hizmetin ne kadar sürede geri gelmesi gerekiyor | 💡 **Önerilen (henüz işletme onayı yok): 4 saat** (tespit + karar onayı + restore + doğrulama + trafik açma dahil). Bu, tek bir manuel operatör tarafından, önceden yazılı bu runbook izlenerek yürütüldüğü varsayımına dayanır. 🔧 Restore adımının kendisinin fiili süresi, [aşağıdaki tatbikat kanıtı](#tatbikat-kanıtı-drill-evidence) tablosundaki gerçek ölçümlerle güncellenmelidir — bu belge, gerçek production veri hacmi için bir süre taahhüt etmez (tatbikat, küçük sentetik veriyle yapılmıştır). |

Bu hedefler resmî olarak onaylanana kadar, mevcut (yalnızca günlük manuel dump varsayımlı) model **en iyi ihtimalle ~24 saatlik RPO** sunar — bu, birden fazla tenant'ın finansal verisi için işletme tarafından kabul edilebilir olup olmadığı ayrıca değerlendirilmelidir.

## Tatbikat kanıtı (drill evidence)

Her restore tatbikatı aşağıdaki şablonla kayıt altına alınmalıdır — yalnızca "yedek alınıyor" değil, "yedekten fiilen dönülebiliyor" iddiasının kanıtı budur (R-5).

### Şablon

| Alan | Değer |
|---|---|
| Tarih | 🔧 GG.AA.YYYY |
| Yedek tanımlayıcı (dosya adı + sha256 kısa özeti) | 🔧 |
| Kaynak ortam | 🔧 (production / staging / disposable-drill) |
| Restore hedefi (host + db adı — **asla kaynakla aynı olmamalı**) | 🔧 |
| Guard script sonucu (`db-restore-guard.mjs`) | 🔧 OK / REDDEDİLDİ |
| pg_dump süresi | 🔧 |
| pg_restore süresi | 🔧 |
| Prisma `migrate status` sonucu | 🔧 up to date / eksik migration bulundu |
| Uygulama düzeyi smoke kontrolü | 🔧 satır sayıları + örnek kayıt karşılaştırması eşleşti/eşleşmedi |
| Sonuç | 🔧 Başarılı / Başarısız (+ karşılaşılan sorun) |
| Temizlik yapıldı mı | 🔧 Evet/Hayır |

### Kayıt — 07.08.2026 (YF-510, izole/disposable tatbikat)

⚠️ Bu tatbikat **tamamen izole, tek kullanımlık, yerel Docker altyapısı ve sentetik veri** ile yapılmıştır — production'a hiçbir şekilde erişilmemiş, kopyalanmamış veya production üzerinde işlem yapılmamıştır. Aşağıdaki süreler, küçük sentetik veri seti (1 organizasyon, 2 kullanıcı, 1 hesap) üzerinden ölçülmüştür ve **gerçek production veri hacmi için bir RTO taahhüdü oluşturmaz**.

| Alan | Değer |
|---|---|
| Tarih | 07.08.2026 |
| Yedek tanımlayıcı | `yapifin_20260807_095511.dump` (57.387 bayt), sha256 `c0b4f81f476f06dc9f9ae3bf97c9063ee2dff83267df2d92ab75a6171888be3` |
| Kaynak ortam | Disposable — `yf510-drill-postgres` konteyneri (postgres:16-alpine), `yapifin_drill_source` veritabanı, yerel Docker Desktop, sentetik veri |
| Restore hedefi | Aynı disposable konteynerde ayrı veritabanı: `yapifin_restore_drill` (host=localhost, port=55432) |
| Guard script sonucu | OK — `node scripts/db-restore-guard.mjs --host localhost --db yapifin_restore_drill --port 55432` |
| pg_dump süresi | <1 saniye (sentetik veri seti küçük; gerçek production hacmi için ölçüm değildir) |
| pg_restore süresi | <1 saniye (aynı not geçerli) |
| Checksum doğrulaması | `sha256sum -c` → OK; `pg_restore --list` → 21 tablo, beklenen `Organization`/`User`/`FinancialAccount` dahil hatasız listelendi |
| Prisma `migrate status` | "Database schema is up to date!" — restore hedefinde `20260805125134_init` ve `20260805143103_faz3_financial_hardening` ile birebir eşleşti |
| Uygulama düzeyi smoke kontrolü | Kaynak ve restore hedefinde `Organization`/`User`/`FinancialAccount` satır sayıları birebir eşleşti (1/2/1); organizasyon adı, kullanıcı e-postaları ve hesap açılış bakiyesi restore sonrası değişmeden okundu; negatif bakiye invariant sorgusu boş sonuç döndü |
| Sonuç | ✅ Başarılı — karşılaşılan sorun: `docker exec`/`docker cp` çağrılarında MSYS/Git-Bash POSIX-yol dönüştürmesi `pg_dump --file` hedefini bozdu; `MSYS_NO_PATHCONV=1` ile ve `docker cp` yerine `docker exec ... cat > dosya` akışıyla çözüldü (yalnızca yerel Windows/Git Bash operatör ortamına özgü bir not, prosedürün kendisinde değişiklik gerektirmedi) |
| Temizlik yapıldı mı | Evet — `docker rm -f yf510-drill-postgres`, dump/checksum dosyaları ve disposable parola silindi; adlandırılmış volume oluşturulmadığı için ek volume temizliği gerekmedi |

💡 **Not**: Bu tatbikat, restore prosedürünün adımlarının **doğru ve çalışır** olduğunu kanıtlar (R-5'in "hiç test edilmemiş" kısmını kapatır). Ancak gerçek production yedeğiyle, gerçek veri hacmiyle ve gerçek RTO ölçümüyle yapılan bir tatbikat **hâlâ ayrı bir operasyonel görevdir** — production erişimi ve onayı gerektirir, bu görevin kapsamında değildir.

## Bilinen eksikler (takip görevleri)

| Eksik | Etki | Önerilen takip |
|---|---|---|
| Otomatik/zamanlanmış backup yok | Backup'ın alınması tamamen manuel disipline bağlı | Zamanlanmış bir backup job'u (cron/managed servis) eklenmesi — ayrı görev |
| ~~Restore hiç test edilmemiş (R-5)~~ Restore, izole/disposable altyapıda ve sentetik veriyle uçtan uca doğrulandı (YF-510) | Prosedürün kendisi artık çalıştığı kanıtlanmış durumda; **gerçek production yedeğiyle** tatbikat hâlâ yapılmadı | Aynı prosedürü gerçek (anonymize edilmemiş/gerçek hacimli) bir production yedeğiyle, üretim erişimi olan bir operatör tarafından, en az ayda bir kez çalıştırıp bu tabloya yeni bir [tatbikat kanıtı](#tatbikat-kanıtı-drill-evidence) kaydı eklemek |
| PITR yok | RPO ~24 saat ile sınırlı | WAL arşivleme veya managed PITR değerlendirmesi |
| Off-site storage entegrasyonu yok | Tek bölge/host kaybında yedek de kaybolabilir | Object storage / ayrı bölge hedefi belirlenmesi |
| RPO/RTO işletme tarafından resmî onaylanmamış | Önerilen 24s/4s değerler yalnızca doküman önerisidir | İşletme ile RPO/RTO hedefinin resmileştirilmesi |
