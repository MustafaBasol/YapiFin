# Disposable PostgreSQL Test Harness (YF-514)

## Neden gerekli

`docker-compose.yml` içindeki `postgres` servisi tek, kalıcı bir konteynerdir
(sabit ad, sabit `5432` portu, sabit `yapifin` veritabanı). Tek bir
geliştirici için bu yeterlidir, ama **birden fazla worktree veya agent aynı
anda test çalıştırdığında** hepsi aynı veritabanına yazar. Bu şu sonuçlara yol
açar:

- `tests/helpers.ts`'teki `cleanDatabase()` bir worktree'nin verisini
  diğerinin testleri sürerken siler (veri sızıntısı / yanlış-negatif test
  sonuçları).
- Aynı anda çalışan `prisma migrate deploy`/`dev` çağrıları migration
  kilitleri üzerinde çakışır.
- Paralel transaction'lar arasında FK/deadlock yarışları oluşur.
- Bir worktree'nin başarısız testi, temizliği yarım bırakıp diğerini
  etkileyebilir.

Bu harness, **her çalışmaya kendi izole, tek-kullanımlık Postgres
konteynerini** verir; `docker compose up -d db` akışını **değiştirmez**,
yanına ek bir seçenek olarak eklenir.

> **Kural:** Paylaşılan bir test veritabanına karşı paralel worktree/agent
> çalıştırmayın. Gerçek Postgres gerektiren testleri paralel bağlamda
> çalıştıracak her agent bu harness'i (`npm run test:db` veya
> `scripts/test-db-harness.mjs run`) kullanmalıdır.

## Mimari

- **Motor:** `scripts/test-db-harness.mjs` — Node tabanlı, cross-platform
  orkestrasyon (mevcut `scripts/run-redis-integration-tests.mjs` ve
  `scripts/run-export-integration-tests.mjs` ile aynı desen: `docker` CLI'yi
  `child_process` ile çağırır, ek bağımlılık eklemez).
- **Windows sarmalayıcı:** `scripts/test-db-harness.ps1` — ince bir
  PowerShell kabuğu, tüm mantığı `.mjs` motoruna devreder (mantığın iki
  dilde ayrı ayrı bakımı gerekmez).
- **Saf yardımcılar** (`scripts/test-db/`):
  - `identifiers.mjs` — runId/konteyner adı/veritabanı adı/rol adı üretimi
    ve sterilizasyonu.
  - `safety.mjs` — `assertDisposableTestTarget()`: bir DATABASE_URL'nin
    gerçekten disposable/yerel bir hedef olduğunu doğrular, değilse
    **kapalı-durumda-başarısız** olur.
  - `redact.mjs` — log/CI çıktısına yazılmadan önce kimlik bilgilerini
    maskeler.
- **Durum dosyası yok.** Docker'ın kendisi tek doğruluk kaynağıdır: her
  konteyner `com.yapifin.testdb`, `com.yapifin.testdb.runid`,
  `com.yapifin.testdb.port`, `com.yapifin.testdb.dbname` etiketleriyle
  işaretlenir; parola yalnızca konteynerin kendi ortam değişkeninde
  (`POSTGRES_PASSWORD`) tutulur, hiçbir yere dosya olarak yazılmaz.

## Yaşam döngüsü (`run` alt komutu — önerilen ana akış)

1. Benzersiz `runId` üretilir (`<pid>-<rastgele6hex>`, sterilize edilmiş).
2. `127.0.0.1` üzerinde boş bir port ayrılır.
3. `postgres:16-alpine` konteyneri, `--tmpfs /var/lib/postgresql/data` ile
   (diskte kalıcı hiçbir veri bırakmadan) ve yalnızca `127.0.0.1`'e
   bağlanmış portla başlatılır.
4. `pg_isready` ile sınırlı süre (60sn, 500ms aralıklarla) hazır olma
   beklenir.
5. Üretilen DATABASE_URL, `assertDisposableTestTarget()` ile doğrulanır
   (host yerel mi, veritabanı adı `yf514_` ile mi başlıyor, "prod/staging"
   benzeri bir dize içeriyor mu vb. — bkz. Güvenlik bölümü).
6. `prisma migrate deploy` çalıştırılır.
7. Prisma Client yalnızca `node_modules/.prisma/client` yoksa üretilir
   (`postinstall` zaten çoğu durumda üretmiş olur).
8. Verilen komut (`-- npx vitest run ...` gibi), DATABASE_URL yalnızca alt
   sürecin ortamında olacak şekilde çalıştırılır (asla loglanmaz).
9. Komutun çıkış kodu yakalanır.
10. `finally` bloğunda konteyner silinir ve silindiği doğrulanır — temizlik
    doğrulanamazsa (mevcut `run-redis-integration-tests.mjs` ile aynı
    kural), testler geçmiş olsa bile script başarısız sayılır.
11. Orijinal komutun çıkış kodu döndürülür.

**Önemli:** Konteyner `docker run -d` ile, yani ana Node sürecinden
**bağımsız (detached)** başlatılır — Docker daemon'ı tarafından yönetilir,
ana sürecin kendisi tarafından değil. Normal akışta (adım 9-10) temizlik,
`run` komutunun `try/finally` bloğunda garanti edilir: hem başarılı
tamamlanmada hem de çalıştırılan komut hata fırlatmasında/başarısız olmasında
çalışır. Ancak süreç veya host **ani** şekilde sonlanırsa (`kill -9`,
sürecin kendisi, terminal/CI runner'ının aniden kapanması, host çökmesi gibi
`finally` bloğunun hiç çalışamayacağı durumlar), konteyner detached olduğu
için Docker'da çalışır durumda yetim kalabilir — bunu önleyen bir garanti
YOKTUR. Bu durumun kurtarma mekanizması, "Sorun giderme" bölümündeki tam
`runId` kapsamlı `status`/`down --run-id <id>` komutlarıdır; hiçbir zaman
`docker rm`/`docker container prune` gibi geniş kapsamlı bir temizlik
komutu kullanılmamalıdır (başka görevlerin konteynerlerini de silebilir).

## Komutlar

| Amaç | Komut |
|---|---|
| Sadece izole DB'yi başlat | `npm run test:db:up` |
| Durumu göster (sır içermez) | `npm run test:db:status` |
| Tüm gerçek-DB paketini çalıştır | `npm run test:db` |
| Seçili bir testi çalıştır | `node scripts/test-db-harness.mjs run -- npx vitest run tests/account.test.ts` |
| `up` ile başlatılmış DB'ye bağlanıp test çalıştır (DB kalır) | `node scripts/test-db-harness.mjs run --run-id <id> -- npx vitest run` |
| Gerçek DATABASE_URL'i yazdır (kimlik bilgisi içerir) | `node scripts/test-db-harness.mjs print-url --run-id <id>` |
| Belirli bir runId'yi zorla temizle | `node scripts/test-db-harness.mjs down --run-id <id>` |
| Diğer entegrasyon script'leriyle birleştir | `node scripts/test-db-harness.mjs run -- node scripts/run-export-integration-tests.mjs` |

### PowerShell (Windows, birincil geliştirici deneyimi)

```powershell
.\scripts\test-db-harness.ps1 up
.\scripts\test-db-harness.ps1 status
.\scripts\test-db-harness.ps1 run -- npx vitest run tests/account.test.ts
.\scripts\test-db-harness.ps1 down --run-id <id>
```

### Linux / macOS / CI

```bash
node scripts/test-db-harness.mjs run -- npx vitest run
```

CI zaten iş başına izole bir runner kullandığı için (`.github/workflows/ci.yml`
içindeki `services.postgres`), mevcut CI pipeline'ı bu harness'e geçirilmedi
— YF-514'ün kapsamı **yerel paralel worktree/agent** senaryosudur. Aynı
runner'da birden fazla iş paralel Postgres gerektirirse (ör. matris job'ları
tek self-hosted runner'da), bu harness aynı `node scripts/test-db-harness.mjs
run -- <komut>` çağrısıyla CI'da da kullanılabilir.

## runId kuralları

- Biçim: `<pid>-<6 haneli rastgele hex>`, küçük harfe çevrilip
  `[a-z0-9_]` dışındaki her şey `_` ile değiştirilir (bkz.
  `scripts/test-db/identifiers.mjs`).
- Konteyner adı: `yf514-testdb-<runId>`.
- Veritabanı/rol adı: `yf514_<runId>` (63 bayt PostgreSQL sınırına göre
  kırpılır).
- Aynı runId ile ikinci bir `up` çağrısı **kapalı-durumda-başarısız**
  çalışır: konteyner zaten çalışıyorsa yeniden oluşturulmadan yalnızca
  gerçek hazırlığı (`pg_isready`) yeniden doğrulanır; konteyner durmuşsa
  (`docker stop` edilmiş, host yeniden başlatılmış vb.) yalnızca o tam
  runId'ye ait konteyner yeniden başlatılır (`docker start`) ve migration'lar
  yeniden uygulanır (tmpfs veri dizini yeniden başlatmada boş dönebileceğinden
  idempotent olarak tekrar çalıştırılır). Gerekli konteyner meta verisi
  (port/veritabanı adı/parola) okunamıyorsa veya yeniden başlatma
  başarısız olursa, `up` asla "başarılı" bildirmez — kök nedeni açıkça
  belirten bir hatayla başarısız olur.
- `down`/`print-url`/`run --run-id`, yalnızca hem `com.yapifin.testdb=1`
  hem de tam `runId` etiketi eşleşen konteynere dokunur — farklı bir göreve
  ait konteyner asla etkilenmez. `run --run-id`, `up` ile başlatılmış ve
  hâlâ çalışır durumdaki bir konteynere bağlanmayı bekler; konteyner
  durmuşsa onu yeniden başlatmaz (bunun için önce `up --run-id <id>`
  çalıştırılmalıdır) ve gerekli meta veri eksikse (port/veritabanı
  adı/parola) DATABASE_URL hiç oluşturulmadan, hangi alanın eksik olduğunu
  belirten bir hatayla başarısız olur.

## Paralel worktree örneği

İki worktree'de aynı anda:

```bash
# Worktree A
node scripts/test-db-harness.mjs run -- npx vitest run

# Worktree B (aynı anda, farklı bir terminalde)
node scripts/test-db-harness.mjs run -- npx vitest run
```

Her ikisi de kendi `runId`'sini (farklı PID + rastgele son ek), kendi
portunu, kendi konteynerini ve kendi `yf514_<runId>` veritabanını alır.
Aralarında hiçbir paylaşılan durum yoktur; biri başarısız olup temizlenirken
diğeri etkilenmez.

## Güvenlik

- **Kapalı-durumda-başarısız hedef doğrulama** — `assertDisposableTestTarget()`
  şunları reddeder: yerel olmayan host, `yf514_` ile başlamayan veritabanı
  adı, adında `prod`/`production`/`staging`/`stage`/`live` geçen veritabanı
  adı, beklenen port/veritabanı adıyla eşleşmeyen URL. Bu kontrol hem
  konteyner oluşturulduktan hemen sonra hem de `run --run-id` ile mevcut bir
  konteynere bağlanırken çalışır.
- **Kimlik bilgisi hiçbir zaman loglanmaz.** `up`/`status`/`run`/`down`
  çıktılarının hiçbiri parola içermez (bkz. `redact.mjs`). Gerçek
  DATABASE_URL yalnızca açıkça çağrılan `print-url` alt komutuyla, yalnızca
  stdout'a yazılır — bu bile bir UYARI ile birlikte gelir.
- **Parola diskte hiçbir yere yazılmaz** — yalnızca konteynerin kendi
  ortam değişkeninde tutulur, `docker inspect` ile geri okunur.
- **Kapsamlı temizlik** — her komut yalnızca `com.yapifin.testdb=1` VE tam
  `runId` etiketi eşleşen konteynerlere dokunur; asla `docker rm` gibi geniş
  kapsamlı bir komut çalıştırmaz, asla başka görevlerin konteynerlerini
  listelemez/durdurmaz.
- **`lib/env.ts` doğrulaması devre dışı bırakılmaz** — bu harness ayrı,
  ek bir katmandır; uygulamanın kendi ortam doğrulamasını (`getEnv()`)
  hiçbir şekilde atlamaz veya zayıflatmaz.
- **tmpfs veri dizini** — konteyner silindiğinde disk üzerinde hiçbir veri
  kalıntısı bırakmaz (kalıcı `postgres_data` volume'ünün aksine).

## Sorun giderme

- **"Port zaten kullanımda" benzeri bir docker hatası:** Harness portu
  `run` anında dinamik olarak ayırır; bu hata neredeyse her zaman eşzamanlı
  bir başka süreçle yarış durumuna işaret eder — komutu tekrar çalıştırmak
  yeterlidir.
- **Konteyner temizlik sonrası hâlâ görünüyor uyarısı:** `docker ps -a
  --filter label=com.yapifin.testdb.runid=<id>` ile durumu kontrol edin,
  ardından `node scripts/test-db-harness.mjs down --run-id <id>` ile zorla
  silin.
- **Yarım kalmış (kesintiye uğramış) çalışmalardan kalan konteynerler:**
  `npm run test:db:status` ile bu harness'e ait TÜM konteynerleri (yalnızca
  kendi etiketimiz altındakileri) listeleyin, ardından ilgili `runId` için
  `down --run-id <id>` çalıştırın. Başka bir görevin/agent'ın hâlâ aktif
  olabileceği bir runId'yi asla varsaymadan silmeyin.
- **`assertDisposableTestTarget` reddetti:** Bu, harness'in DATABASE_URL'i
  kendisi üretmediği (ör. `.env`'den kalıntı bir değer sızmış) anlamına
  gelir — harness'i asıl `DATABASE_URL` ortam değişkeni ayarlıyken
  çalıştırmayın; harness kendi URL'ini kendisi üretir ve yalnızca alt
  sürece geçirir.

## Gelecek görevler için not

Bu harness'i kullanacak her yeni agent/worktree:

1. Paylaşılan `docker-compose.yml` Postgres'ine karşı paralel test
   çalıştırmamalı.
2. Gerçek Postgres gerektiren testler için `npm run test:db` (veya seçili
   test için `scripts/test-db-harness.mjs run -- npx vitest run <dosya>`)
   kullanmalı.
3. Kendi başlattığı harness konteynerlerini `run` komutunun otomatik
   temizliğine bırakmalı; yalnızca hata ayıklama için `--keep` kullanılıyorsa
   işi bitince `down --run-id <id>` ile elle temizlemeli.
4. Başka bir görevin `yf514-testdb-*` konteynerine asla dokunmamalı.
