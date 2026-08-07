// YF-510 — Restore prosedürü sırasında yanlışlıkla production (veya production'a
// benzeyen) bir veritabanının üzerine yazılmasını engelleyen, bağımsız/fail-closed
// bir ön kontrol. `docs/operations/BACKUP_RESTORE_RUNBOOK.md`'deki restore
// adımlarından ÖNCE, gerçek `pg_restore` komutu çalıştırılmadan çalıştırılmalıdır.
//
// Bilinçli olarak connection string/parola KABUL ETMEZ — yalnızca host, port ve
// veritabanı adını alır. Böylece bu script hiçbir zaman bir sırrı loglayamaz veya
// yanlışlıkla saklayamaz; gerçek kimlik bilgileri yalnızca operatörün doğrudan
// çalıştırdığı `pg_restore`/`psql` komutuna (`PGPASSWORD=...`) geçer.
//
// Çıkış kodu 0 = hedef, tek-kullanımlık bir restore hedefi gibi görünüyor (devam
// edilebilir). Çıkış kodu 1 = reddedildi (fail-closed varsayılan).
//
// Kullanım:
//   node scripts/db-restore-guard.mjs --host <host> --db <veritabani-adi> [--port <port>]
//
// İsteğe bağlı, production'ı KESİN olarak tanımlamak için (varsa):
//   PROD_DB_HOST=... PROD_DB_NAME=... node scripts/db-restore-guard.mjs --host <host> --db <db>
// Bu iki değişken tanımlıysa ve hedef onlarla birebir eşleşirse, isim deseni
// kontrolünden bağımsız olarak KOŞULSUZ reddedilir.

function getArg(name) {
  const idx = process.argv.indexOf(name);
  return idx !== -1 ? process.argv[idx + 1] : undefined;
}

function fail(reason) {
  console.error(`[db-restore-guard] REDDEDİLDİ: ${reason}`);
  process.exit(1);
}

const host = getArg("--host");
const db = getArg("--db");
const port = getArg("--port") ?? "5432";

if (!host || !db) {
  fail(
    'Kullanım: node scripts/db-restore-guard.mjs --host <host> --db <veritabani-adi> [--port <port>]. ' +
      "Parola veya tam connection string GEÇİRMEYİN — bu script yalnızca host/db adı kontrolü yapar."
  );
}

console.log(`[db-restore-guard] Hedef: host=${host} port=${port} db=${db}`);

const prodHost = process.env.PROD_DB_HOST;
const prodName = process.env.PROD_DB_NAME;
if (prodHost && prodName && host === prodHost && db === prodName) {
  fail(
    `Hedef, PROD_DB_HOST/PROD_DB_NAME ile birebir eşleşiyor (host=${host}, db=${db}). ` +
      "Production üzerine restore kesinlikle engellendi."
  );
}

const DISPOSABLE_NAME_PATTERN = /(restore|drill|disposable|scratch|sandbox)/i;
if (!DISPOSABLE_NAME_PATTERN.test(db)) {
  fail(
    `Veritabanı adı "${db}" bariz bir tek-kullanımlık restore hedefi gibi görünmüyor ` +
      '(ad içinde "restore", "drill", "disposable", "scratch" veya "sandbox" geçmeli). ' +
      "Yanlışlıkla staging/production üzerine restore riskini azaltmak için hedefi yeniden adlandırın."
  );
}

if (/prod/i.test(host) || /prod/i.test(db)) {
  fail(`Hedef host/db adında "prod" ifadesi geçiyor — güvenlik için engellendi (host=${host}, db=${db}).`);
}

console.log(
  "[db-restore-guard] OK — hedef tek-kullanımlık bir restore veritabanına benziyor. " +
    "pg_restore komutunu çalıştırmadan önce yine de hedefin doğru olduğunu gözle teyit edin."
);
process.exit(0);
