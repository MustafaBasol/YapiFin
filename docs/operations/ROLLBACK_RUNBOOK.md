# Rollback Runbook

**Bağlı belgeler**: [README.md](./README.md) · [DEPLOYMENT_RUNBOOK.md](./DEPLOYMENT_RUNBOOK.md) · [BACKUP_RESTORE_RUNBOOK.md](./BACKUP_RESTORE_RUNBOOK.md) · [INCIDENT_RESPONSE_RUNBOOK.md](./INCIDENT_RESPONSE_RUNBOOK.md)

## Mevcut durum

❌ **Repository'de genelleştirilmiş bir rollback runbook'u şimdiye kadar yoktu.** `docs/PRODUCTION_READINESS.md` bunu doğrudan not eder: *"Repo içinde tanımlı bir rollback runbook'u yok"* (§7). Yalnızca geçmişte yapılmış belirli görevler için ad-hoc, o göreve özel `git revert <sha> && npm ci` prosedürleri belgelenmiş (§12.8 — Next.js yükseltmesi, §13.10 — nodemailer yükseltmesi). Bu belge, o ad-hoc örnekleri genelleştirerek senaryo bazlı bir prosedür seti tanımlar.

⚠️ **Kritik kısıt**: Prisma migration'ları **otomatik olarak geri alınamaz**. Prisma'nın "migrate down" veya benzeri bir tersine çevirme komutu yoktur (bu belge böyle bir komut uydurmaz). `prisma/migrations/` altındaki her migration tek yönlü bir `migration.sql` dosyasıdır — geri almak, ya elle yazılmış bir "ters migration" ya da [BACKUP_RESTORE_RUNBOOK.md](./BACKUP_RESTORE_RUNBOOK.md) üzerinden restore gerektirir.

## Ortak ilkeler

Her rollback senaryosu için aşağıdaki beş soru **önce** yanıtlanmalıdır:

1. **Tetikleyici** — rollback kararını ne başlattı? (health check başarısız, smoke test başarısız, production'da hata artışı, manuel gözlem)
2. **Karar yetkilisi** — rollback'i kim onaylıyor? 🔧 (bu belge bir isim/rol dayatmaz; operatörün kendi eskalasyon politikasına göre belirlenir — küçük ekiplerde deploy'u yapan kişi olabilir)
3. **Veri riski** — rollback, veri kaybına veya tutarsızlığa yol açabilir mi?
4. **Önce alınacak backup** — rollback işlemine başlamadan önce mevcut (rollback edilecek) durumun bir yedeği alınmalı mı? (Genellikle evet — başarısız bir deploy'un state'i bile adli inceleme için değerli olabilir.)
5. **İleri düzeltme gerekip gerekmediği** (roll-forward) — bazı durumlarda geri almak yerine hızlı bir düzeltme commit'i ile ileri gitmek daha güvenlidir (özellikle destructive migration sonrası).

## Senaryo 1 — Yalnızca uygulama kodu rollback

**Kapsam**: Migration/şema değişikliği içermeyen bir deploy (yalnızca `app/`, `components/`, `lib/`, `server/` kod değişiklikleri).

| Alan | Değer |
|---|---|
| Tetikleyici | Health check/smoke test başarısız, veya production'da yeni bir hata paterni |
| Karar yetkilisi | 🔧 operatörün eskalasyon politikası |
| Veri riski | Düşük — şema/veri değişmedi |
| Önce alınacak backup | Opsiyonel (veri değişmediği için genelde gerekmez, ama yüksek riskli/finansal değişikliklerde 🔧 operatör kararıyla alınabilir) |

**Adımlar**:

```bash
git fetch origin --prune
git revert <başarısız-deploy'un-commit-sha'ları>
npm ci
npx prisma validate
npm run build
```

Ardından [DEPLOYMENT_RUNBOOK.md](./DEPLOYMENT_RUNBOOK.md) adım 7-9'u (restart, health doğrulama, smoke test) tekrar uygulayın.

**Doğrulama**: [DEPLOYMENT_RUNBOOK.md — health/readiness doğrulaması](./DEPLOYMENT_RUNBOOK.md#healthreadiness-doğrulaması) ve [PRODUCTION_CHECKLIST.md](./PRODUCTION_CHECKLIST.md).

**İleri düzeltme gerekli mi**: Genelde hayır — `git revert` tek başına yeterli bir düzeltmedir.

## Senaryo 2 — Backward-compatible migration sonrası rollback

**Kapsam**: Migration, eski uygulama koduyla da çalışabilecek şekilde tasarlanmış (ör. yeni bir opsiyonel kolon ekleme, yeni bir tablo ekleme — mevcut kolon/tabloyu değiştirmeyen/silmeyen bir migration).

| Alan | Değer |
|---|---|
| Tetikleyici | Uygulama kodu hatalı ama migration'ın kendisi zararsız |
| Karar yetkilisi | 🔧 operatörün eskalasyon politikası |
| Veri riski | Düşük — yeni kolon/tablo kullanılmıyorsa (eski kod tarafından) veri kaybı olmaz |
| Önce alınacak backup | Önerilir (herhangi bir migration sonrası genel iyi pratik) |

**Adımlar**:

```bash
git fetch origin --prune
git revert <uygulama-kodu-commit-sha'ları>   # migration dosyasını DEĞİL, yalnızca kodu revert eder
npm ci
npm run build
```

⚠️ **Migration dosyasını (`prisma/migrations/<timestamp>_<name>/`) revert etmeyin/silmeyin.** Migration geride bırakılır (şemada yeni kolon/tablo dursun); yalnızca onu kullanan uygulama kodu geri alınır. Bunun nedeni: `prisma migrate deploy` uygulanmış bir migration'ı "geri almak" için otomatik bir mekanizma yoktur; migration dosyasını silmek yalnızca migration geçmişini (`_prisma_migrations` tablosu) gerçek şemadan **tutarsız** hale getirir.

**Doğrulama**: `npx prisma migrate status` migration geçmişinin tutarlı olduğunu göstermeli (eski migration'lar + geri alınmayan yeni migration, hepsi "applied"). Ardından [DEPLOYMENT_RUNBOOK.md](./DEPLOYMENT_RUNBOOK.md) health/smoke adımları.

**İleri düzeltme gerekli mi**: Genelde bir sonraki deploy'da kod düzeltilip yeniden denenir (roll-forward); migration'ı geri almaya gerek yoktur.

## Senaryo 3 — Destructive veya non-reversible migration

**Kapsam**: Migration kolon/tablo siliyor, veri dönüştürüyor (ör. `ALTER COLUMN ... TYPE` veri kaybına yol açabilecek şekilde), veya NOT NULL kısıtı ekliyor (mevcut NULL veriler varsa migration zaten başarısız olur, ama veri temizliği migration içindeyse geri dönüşü yoktur).

| Alan | Değer |
|---|---|
| Tetikleyici | Migration sonrası veri kaybı/bozulması fark edildi, veya migration'ın kendisi hatalı olduğu anlaşıldı |
| Karar yetkilisi | 🔧 **Bu senaryo, en az teknik lider + ürün/iş sahibi onayı gerektirmelidir** — geri dönüşü olmayan bir işlemdir. Operatörün eskalasyon politikasına göre kesinleştirilmeli. |
| Veri riski | **Yüksek** — silinen kolon/tablo/dönüştürülen veri, restore olmadan geri getirilemez |
| Önce alınacak backup | **Zorunlu ve migration'dan önce alınmış olmalı** — bkz. [DEPLOYMENT_RUNBOOK.md — deployment öncesi backup](./DEPLOYMENT_RUNBOOK.md#deployment-öncesi-backup). Migration'dan **sonra** alınan bir backup, kaybolan veriyi içermez. |

**Adımlar**:

1. ⚠️ **Uydurma bir `prisma migrate down` komutu yoktur — böyle bir komut çalıştırmayın, mevcut değildir.**
2. Migration öncesi alınmış backup'ı [BACKUP_RESTORE_RUNBOOK.md — Restore prosedürü](./BACKUP_RESTORE_RUNBOOK.md#restore-prosedürü) ile **önce izole bir ortamda** doğrulayın.
3. Karar yetkilisinin onayıyla, production'a karşı restore kararı verilirse: bu artık migration'dan sonraki **tüm** verinin kaybı anlamına gelir (backup anından deploy anına kadar üretilen işlemler kaybolur) — bu tradeoff karar yetkilisine açıkça sunulmalıdır.
4. Alternatif (💡 önerilir, veri kaybı olmadan): destructive migration'ı geri almak yerine, kaybolan veriyi **kurtarmayan** ama hasarı **durduran** bir ileri düzeltme (roll-forward) migration'ı yazmak — ör. silinen kolonu yeniden ekleyip (varsayılan/boş değerle), uygulama kodunu buna göre düzeltmek. Bu, veriyi geri getirmez ama servisi kararlı hale getirir.
5. Production restore kararı verildiyse: [BACKUP_RESTORE_RUNBOOK.md — Restore prosedürü](./BACKUP_RESTORE_RUNBOOK.md#restore-prosedürü) adımları izlenir, ancak hedef izole ortam yerine gerçek production DB'sidir — bu, standart restore prosedüründen **kasıtlı bir sapmadır** ve yalnızca karar yetkilisinin açık onayıyla yapılır.

**Doğrulama**: [BACKUP_RESTORE_RUNBOOK.md — restore sonrası Prisma/schema kontrolü](./BACKUP_RESTORE_RUNBOOK.md#4-restore-sonrası-prismaşema-kontrolü) ve [tenant/finansal veri doğrulama örnekleri](./BACKUP_RESTORE_RUNBOOK.md#6-tenant-ve-finansal-veri-doğrulama-örnekleri).

**İleri düzeltme gerekli mi**: **Evet, neredeyse her zaman** — restore sonrası kayıp veri aralığındaki kullanıcı işlemleri (ör. o pencerede oluşturulmuş tahsilat/ödeme kayıtları) elle rekonsile edilmesi gerekebilir; bu iş, restore prosedürünün bir parçası değil, ayrı bir veri-kurtarma görevi olarak ele alınmalıdır.

## Senaryo 4 — Environment/config rollback

**Kapsam**: Bir env değişkeni değişikliği (ör. `SMTP_HOST` güncellemesi, `NEXT_PUBLIC_APP_URL` değişikliği) uygulamayı bozdu.

| Alan | Değer |
|---|---|
| Tetikleyici | `getEnv()` başlangıçta hata fırlatıyor (süreç açılmıyor) veya yanlış yapılandırılmış bir değer (ör. yanlış SMTP host) runtime'da hata üretiyor |
| Karar yetkilisi | 🔧 operatörün eskalasyon politikası |
| Veri riski | Yok (env değişikliği veri değiştirmez) |
| Önce alınacak backup | Gerekmez |

**Adımlar**:

1. Önceki bilinen-çalışan env değer setine geri dönün (🔧 operatör, secret manager/deploy geçmişinden önceki değerleri alır — bu belge geçmiş secret değerlerini saklamaz).
2. Süreci yeniden başlatın (`getEnv()` cache'i process ömrü boyunca tutulduğundan, env değişikliği yalnızca restart sonrası etkili olur).
3. [DEPLOYMENT_RUNBOOK.md — health/readiness doğrulaması](./DEPLOYMENT_RUNBOOK.md#healthreadiness-doğrulaması) ile doğrulayın.

**Not**: `lib/env.ts` içindeki fail-closed doğrulama (production'da placeholder `AUTH_SECRET` reddi, zorunlu SMTP alanları vb.) bu senaryonun **çoğunu deploy anında** yakalar — yani süreç zaten açılmamış olabilir, bu da "yarım bozuk" bir production yerine net bir "deploy başarısız" sinyali verir (bkz. [DEPLOYMENT_RUNBOOK.md — deploy başarısızlığı çıkış kriterleri](./DEPLOYMENT_RUNBOOK.md#deploy-başarısızlığı-çıkış-kriterleri)).

## Senaryo 5 — Dependency veya image rollback

**Kapsam**: `package.json`/`package-lock.json` değişikliği (bağımlılık yükseltmesi/eklemesi) sorun çıkardı. (❌ Container image rollback'i bu repoda uygulanamaz — production Docker imajı yok, bkz. [DEPLOYMENT_RUNBOOK.md](./DEPLOYMENT_RUNBOOK.md#doğrulanmış-mevcut-deployment-modeli).)

| Alan | Değer |
|---|---|
| Tetikleyici | Build hatası, runtime'da yeni bağımlılık kaynaklı hata, veya `npm audit` ile fark edilen kritik bir yeni zafiyet |
| Karar yetkilisi | 🔧 operatörün eskalasyon politikası |
| Veri riski | Genelde yok, ancak bağımlılık DB client'ı (`@prisma/client`) ise dikkatli olunmalı |
| Önce alınacak backup | Yalnızca Prisma/DB client'ı etkileyen bir bağımlılık değişikliğiyse önerilir |

**Adımlar** (repodaki §12.8/§13.10 örneklerinin genelleştirilmiş hali):

```bash
git fetch origin --prune
git revert <bağımlılık-değişikliği-commit-sha'ları>
npm ci
npx prisma validate
npm run build
```

**Doğrulama**: `npm audit`/`npm audit --omit=dev` ile geri dönülen bağımlılık setinin bilinen kritik zafiyet içermediğini teyit edin; ardından standart health/smoke doğrulaması.

## Senaryo 6 — Deploy sırasında kısmi başarı

**Kapsam**: Deploy adımlarından biri (ör. migration) başarılı oldu ama sonraki bir adım (ör. build veya restart) başarısız oldu — sistem "yarı deploy edilmiş" durumda.

| Alan | Değer |
|---|---|
| Tetikleyici | [DEPLOYMENT_RUNBOOK.md](./DEPLOYMENT_RUNBOOK.md) adımlarından biri (build/restart/health) başarısız, ama migration zaten uygulandı |
| Karar yetkilisi | 🔧 operatörün eskalasyon politikası |
| Veri riski | Migration'ın niteliğine bağlı — backward-compatible ise düşük, destructive ise yüksek (Senaryo 3'e bakın) |
| Önce alınacak backup | Migration öncesi zaten alınmış olmalı (bkz. [DEPLOYMENT_RUNBOOK.md](./DEPLOYMENT_RUNBOOK.md#deployment-öncesi-backup)) |

**Adımlar**:

1. Hangi adımın başarısız olduğunu netleştirin: migration mı, build mi, restart mı, health check mi.
2. **Migration başarılıysa ama build/restart başarısızsa**: eski uygulama kodu (önceki release) yeni şemayla çalışabiliyor mu? Migration backward-compatible ise (Senaryo 2), önceki kod sürümünü tekrar başlatarak servisi ayağa kaldırın, ardından build/restart hatasını ayrıca düzeltip yeniden deploy edin. Migration destructive ise (Senaryo 3), önceki kod muhtemelen artık yeni şemayla uyumsuzdur — bu durumda roll-forward (hızlı düzeltme + yeniden deploy) genellikle restore'dan daha hızlı ve güvenlidir.
3. **Migration'ın kendisi yarım kaldıysa** (ör. `prisma migrate deploy` bir migration ortasında hata verdi): Prisma, başarısız migration'ı `_prisma_migrations` tablosunda "failed" olarak işaretler ve bir sonraki `migrate deploy` çalıştırmasını engeller. Bu durumda migration SQL'ini elle inceleyip (hangi kısmı uygulandı, hangi kısmı uygulanmadı) ya elle tamamlamak ya da `prisma migrate resolve` ile durumu işaretlemek gerekir — 🔧 bu, migration'ın içeriğine özgü bir karardır, bu belge genel bir komut dayatmaz; yüksek risk taşıdığından karar yetkilisi onayı gerektirir.
4. Her durumda, servis tekrar sağlıklı hale geldikten sonra [DEPLOYMENT_RUNBOOK.md — health/readiness doğrulaması](./DEPLOYMENT_RUNBOOK.md#healthreadiness-doğrulaması) ile doğrulanmalı ve olay [INCIDENT_RESPONSE_RUNBOOK.md — migration failure](./INCIDENT_RESPONSE_RUNBOOK.md#migration-failure) prosedürüne göre kayıt altına alınmalıdır.

## Senaryo 7 — Export veya SMTP gibi bağımlı özelliklerin rollback'i

**Kapsam**: Export (`server/exports/*`) veya e-posta (`lib/email/*`) ile ilgili bir değişiklik sorun çıkardı, ancak uygulamanın geri kalanı sağlıklı.

| Alan | Değer |
|---|---|
| Tetikleyici | Export route'larında hata artışı ([MONITORING_RUNBOOK.md — export hata ve süreleri](./MONITORING_RUNBOOK.md#9-export-hata-ve-süreleri)) veya SMTP gönderim hatalarında artış ([MONITORING_RUNBOOK.md — SMTP delivery hataları](./MONITORING_RUNBOOK.md#7-smtp-delivery-hataları)) |
| Karar yetkilisi | 🔧 operatörün eskalasyon politikası |
| Veri riski | Düşük — export'lar diske yazılmaz (bellekte üretilir), e-posta gönderimi durumsuzdur (queue/retry yok) |
| Önce alınacak backup | Gerekmez |

**Adımlar**:

- **Yalnızca kod değişikliğiyse** (export/mailer mantığı): Senaryo 1'deki gibi `git revert` + rebuild + redeploy. Bu özellikler diğer uygulama akışlarından (auth, finansal işlemler) bağımsız modüllerdir — kısmi rollback (yalnızca bu dosyaları etkileyen commit'lerin revert edilmesi) mümkündür, tüm deploy'u geri almak gerekmez.
- **SMTP yapılandırma sorunuysa** (host/port/kimlik bilgisi yanlış): Senaryo 4'e (env/config rollback) bakın. `getEnv()` production'da `SMTP_HOST`/`SMTP_PORT`/`SMTP_FROM` eksikse zaten süreç açılışını engeller — yani yanlış (ama dolu) değerler runtime hatası, eksik değerler ise deploy-time hatası üretir.
- Export/SMTP rollback'i sırasında uygulamanın geri kalanı (login, finansal işlemler, dashboard) etkilenmemelidir — bu izolasyonu [PRODUCTION_CHECKLIST.md](./PRODUCTION_CHECKLIST.md) ile doğrulayın.

**Doğrulama**: [PRODUCTION_CHECKLIST.md](./PRODUCTION_CHECKLIST.md) içindeki export ve SMTP smoke testleri.
