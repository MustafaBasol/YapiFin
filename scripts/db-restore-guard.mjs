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
// Argüman ayrıştırma bilinçli olarak katıdır (fail-closed): her değer alan
// bayrak (`--host`, `--db`, `--port`) tam olarak bir kez ve `--` ile
// BAŞLAMAYAN bir değerle verilmelidir; `--port` verildiyse 1-65535 aralığında
// sayısal olmalıdır. Bu kontroller olmadan örn. `--host --db X` gibi bir
// çağrıda `host` yanlışlıkla `"--db"` string'i olur ve guard yanlış hedefi
// onaylayabilir — bkz. `parseArgs()` ve `tests/db-restore-guard.test.ts`.
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

import { pathToFileURL } from "node:url";

const VALUE_FLAGS = new Set(["--host", "--db", "--port"]);
const MIN_PORT = 1;
const MAX_PORT = 65535;
const USAGE =
  'Kullanım: node scripts/db-restore-guard.mjs --host <host> --db <veritabani-adi> [--port <port>]. ' +
  "Parola veya tam connection string GEÇİRMEYİN — bu script yalnızca host/db adı kontrolü yapar.";

export class ArgParseError extends Error {}

// Bilinçli olarak katı: tanınmayan/tekrarlanan bayrakları ve `--` ile
// başlayan (yani başka bir bayrağın yanlışlıkla değer olarak yutulduğu)
// değerleri reddeder. Başarıyla döndüğünde host/db her zaman dolu, port her
// zaman geçerli bir TCP port string'idir (belirtilmemişse "5432").
export function parseArgs(argv) {
  const values = {};

  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];

    if (!VALUE_FLAGS.has(flag)) {
      throw new ArgParseError(
        `Tanınmayan argüman: "${flag}". Beklenen bayraklar: --host, --db, --port (her biri bir değer alır). ${USAGE}`
      );
    }

    if (Object.prototype.hasOwnProperty.call(values, flag)) {
      throw new ArgParseError(
        `"${flag}" bayrağı birden fazla kez verildi — belirsizliği önlemek için her bayrak en fazla bir kez kullanılabilir.`
      );
    }

    const value = argv[i + 1];
    if (value === undefined) {
      throw new ArgParseError(`"${flag}" bayrağı bir değer bekliyor ancak hiçbir değer verilmedi. ${USAGE}`);
    }
    if (value.startsWith("--")) {
      throw new ArgParseError(
        `"${flag}" bayrağının değeri "--" ile başlayamaz (değer eksik ya da başka bir bayrakla karışmış olabilir: "${value}").`
      );
    }

    values[flag] = value;
    i++; // değeri tükettik, bir sonraki bayrağa geç
  }

  const host = values["--host"];
  const db = values["--db"];
  const rawPort = values["--port"];

  if (!host || !db) {
    throw new ArgParseError(USAGE);
  }

  let port = "5432";
  if (rawPort !== undefined) {
    if (!/^\d+$/.test(rawPort) || Number(rawPort) < MIN_PORT || Number(rawPort) > MAX_PORT) {
      throw new ArgParseError(
        `"--port" değeri geçerli bir TCP port numarası değil: "${rawPort}". 1-${MAX_PORT} aralığında sayısal bir değer olmalı.`
      );
    }
    port = rawPort;
  }

  return { host, db, port };
}

// Hedefin production'a benzeyip benzemediğini değerlendirir. `env` test
// edilebilirlik için enjekte edilir (varsayılan: process.env).
/**
 * @param {{ host: string, db: string }} target
 * @param {Record<string, string | undefined>} [env]
 */
export function evaluateTarget({ host, db }, env = process.env) {
  const prodHost = env.PROD_DB_HOST;
  const prodName = env.PROD_DB_NAME;
  if (prodHost && prodName && host === prodHost && db === prodName) {
    return {
      ok: false,
      reason: `Hedef, PROD_DB_HOST/PROD_DB_NAME ile birebir eşleşiyor (host=${host}, db=${db}). Production üzerine restore kesinlikle engellendi.`,
    };
  }

  const DISPOSABLE_NAME_PATTERN = /(restore|drill|disposable|scratch|sandbox)/i;
  if (!DISPOSABLE_NAME_PATTERN.test(db)) {
    return {
      ok: false,
      reason:
        `Veritabanı adı "${db}" bariz bir tek-kullanımlık restore hedefi gibi görünmüyor ` +
        '(ad içinde "restore", "drill", "disposable", "scratch" veya "sandbox" geçmeli). ' +
        "Yanlışlıkla staging/production üzerine restore riskini azaltmak için hedefi yeniden adlandırın.",
    };
  }

  if (/prod/i.test(host) || /prod/i.test(db)) {
    return {
      ok: false,
      reason: `Hedef host/db adında "prod" ifadesi geçiyor — güvenlik için engellendi (host=${host}, db=${db}).`,
    };
  }

  return { ok: true };
}

function fail(reason) {
  console.error(`[db-restore-guard] REDDEDİLDİ: ${reason}`);
  process.exit(1);
}

function main() {
  let target;
  try {
    target = parseArgs(process.argv.slice(2));
  } catch (err) {
    fail(err instanceof ArgParseError ? err.message : String(err.message ?? err));
    return;
  }

  console.log(`[db-restore-guard] Hedef: host=${target.host} port=${target.port} db=${target.db}`);

  const result = evaluateTarget(target);
  if (!result.ok) {
    fail(result.reason);
    return;
  }

  console.log(
    "[db-restore-guard] OK — hedef tek-kullanımlık bir restore veritabanına benziyor. " +
      "pg_restore komutunu çalıştırmadan önce yine de hedefin doğru olduğunu gözle teyit edin."
  );
  process.exit(0);
}

const isMainModule = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
  main();
}
