// YF-514 — Görev/worktree bazlı, disposable PostgreSQL test veritabanı
// harness'i. Paralel çalışan agent'ların/worktree'lerin aynı yerel Postgres'i
// paylaşmasını (deadlock, FK yarışı, migration çakışması, veri sızıntısı,
// yanlış-negatif test sonuçları) önlemek için `docker-compose.yml`'daki
// KALICI `postgres` servisinin yanında, isteğe bağlı, tamamen izole bir
// alternatif sağlar — mevcut `docker compose up -d db` akışını DEĞİŞTİRMEZ.
//
// Tasarım (bkz. docs/TEST_DATABASE_HARNESS.md):
//   - Her çalışma kendi konteynerini, kendi rastgele portunu, kendi
//     veritabanı/rol adını ve kendi tmpfs veri dizinini alır (isim çakışması
//     yapısal olarak imkânsızdır — bkz. scripts/test-db/identifiers.mjs).
//   - Kimlik bilgisi İÇEREN tam DATABASE_URL hiçbir zaman stdout/loga
//     yazılmaz; yalnızca `print-url` alt komutu (açıkça istenerek) üretir.
//     Kalıcılık için ayrı bir durum dosyası da YOKTUR — Docker'ın kendisi
//     (etiketler + konteyner ortam değişkenleri) tek doğruluk kaynağıdır.
//   - `run` alt komutu, çağrılan komutun çıkış kodunu aynen döndürür (bkz.
//     `scripts/run-redis-integration-tests.mjs` ile aynı desen); temizlik
//     doğrulanamazsa (konteyner hâlâ varsa) bu, mevcut testler geçmiş olsa
//     bile script'i başarısız sayar — repo genelinde tutarlı davranış.
//   - Yalnızca kendi etiketimizi (`com.yapifin.testdb`) VE tam runId
//     eşleşmesini taşıyan konteynerlere dokunulur; başka görevlere ait
//     konteynerler asla listelenmez/durdurulmaz/silinmez.

import "dotenv/config";
import { execFileSync, spawn } from "node:child_process";
import net from "node:net";
import { assertDisposableTestTarget, UnsafeTestTargetError } from "./test-db/safety.mjs";
import { redactConnectionString } from "./test-db/redact.mjs";
import {
  generateRunId,
  generatePassword,
  containerName as buildContainerName,
  databaseName as buildDatabaseName,
  HARNESS_LABEL,
  RUN_ID_LABEL,
  PORT_LABEL,
  DB_LABEL,
} from "./test-db/identifiers.mjs";
import {
  validateContainerMetadata,
  buildDatabaseUrl,
  decideReviveAction,
} from "./test-db/connection-info.mjs";

const POSTGRES_IMAGE = "postgres:16-alpine";
const READY_TIMEOUT_MS = 60_000;
const READY_POLL_INTERVAL_MS = 500;

function log(msg) {
  console.log(`[test-db] ${msg}`);
}
function warn(msg) {
  console.error(`[test-db] UYARI: ${msg}`);
}
function fail(msg) {
  console.error(`[test-db] HATA: ${msg}`);
}

async function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function dockerExec(args) {
  return execFileSync("docker", args, { encoding: "utf8" });
}

function dockerExecQuiet(args) {
  try {
    return dockerExec(args);
  } catch {
    return null;
  }
}

function run(command, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit", shell: true, ...opts });
    child.on("exit", (code) => resolve(code ?? 1));
    child.on("error", reject);
  });
}

function findOwnedContainerByRunId(runId) {
  const out = dockerExecQuiet([
    "ps",
    "-a",
    "--filter",
    `label=${HARNESS_LABEL}=1`,
    "--filter",
    `label=${RUN_ID_LABEL}=${runId}`,
    "--format",
    "{{.Names}}",
  ]);
  const names = (out ?? "").split("\n").map((s) => s.trim()).filter(Boolean);
  if (names.length === 0) return null;
  return names[0];
}

function listOwnedContainers() {
  const out = dockerExecQuiet([
    "ps",
    "-a",
    "--filter",
    `label=${HARNESS_LABEL}=1`,
    "--format",
    "{{.Names}}\t{{.Status}}",
  ]);
  return (out ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [name, ...statusParts] = line.split("\t");
      return { name, status: statusParts.join("\t") };
    });
}

function inspectLabels(name) {
  const out = dockerExecQuiet(["inspect", "--format", "{{json .Config.Labels}}", name]);
  if (!out) return null;
  try {
    return JSON.parse(out.trim());
  } catch {
    return null;
  }
}

function inspectEnv(name) {
  const out = dockerExecQuiet(["inspect", "--format", "{{json .Config.Env}}", name]);
  if (!out) return null;
  try {
    const lines = JSON.parse(out.trim());
    const map = {};
    for (const line of lines) {
      const idx = line.indexOf("=");
      if (idx === -1) continue;
      map[line.slice(0, idx)] = line.slice(idx + 1);
    }
    return map;
  } catch {
    return null;
  }
}

async function waitForReady(containerName, dbName) {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const out = execFileSync("docker", ["exec", containerName, "pg_isready", "-U", dbName, "-d", dbName], {
        encoding: "utf8",
      });
      if (/accepting connections/.test(out)) return;
    } catch {
      // henüz hazır değil — tekrar dene.
    }
    await new Promise((r) => setTimeout(r, READY_POLL_INTERVAL_MS));
  }
  throw new Error(`Postgres konteyneri ${READY_TIMEOUT_MS}ms içinde hazır olmadı: ${containerName}`);
}

function removeContainer(name) {
  try {
    execFileSync("docker", ["rm", "-f", name], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function containerExists(name) {
  const out = dockerExecQuiet(["ps", "-a", "--filter", `name=^${name}$`, "--format", "{{.Names}}"]);
  return (out ?? "").trim() === name;
}

function isContainerRunning(name) {
  const out = dockerExecQuiet(["inspect", "--format", "{{.State.Running}}", name]);
  return (out ?? "").trim() === "true";
}

async function startDisposablePostgres(runId) {
  const name = buildContainerName(runId);
  const dbName = buildDatabaseName(runId);
  const password = generatePassword();
  const port = await getFreePort();

  log(`Disposable Postgres başlatılıyor: ${name} (host port ${port}, db ${dbName})`);
  dockerExec([
    "run",
    "-d",
    "--name",
    name,
    "--label",
    `${HARNESS_LABEL}=1`,
    "--label",
    `${RUN_ID_LABEL}=${runId}`,
    "--label",
    `${PORT_LABEL}=${port}`,
    "--label",
    `${DB_LABEL}=${dbName}`,
    "-e",
    `POSTGRES_DB=${dbName}`,
    "-e",
    `POSTGRES_USER=${dbName}`,
    "-e",
    `POSTGRES_PASSWORD=${password}`,
    "--tmpfs",
    "/var/lib/postgresql/data",
    "-p",
    `127.0.0.1:${port}:5432`,
    POSTGRES_IMAGE,
  ]);

  try {
    await waitForReady(name, dbName);
  } catch (err) {
    removeContainer(name);
    throw err;
  }

  const databaseUrl = buildDatabaseUrl({ dbName, password, port });
  assertDisposableTestTarget(databaseUrl, { port, database: dbName });
  log(`Postgres hazır: ${redactConnectionString(databaseUrl)}`);
  return { name, dbName, port, databaseUrl };
}

// runId için önceden oluşturulmuş bir konteyner bulunduğunda çağrılır.
// Kapalı-durumda-başarısız: konteyner çalışıyor olsa bile gerçek hazırlık
// (pg_isready) doğrulanmadan asla başarı bildirilmez; durmuşsa yalnızca bu
// tam runId'ye ait konteyner yeniden başlatılır (başka hiçbir konteynere
// dokunulmaz) ve şema/migration durumu yeniden garanti altına alınır.
async function reviveExistingContainer(runId, name) {
  const labels = inspectLabels(name) ?? {};
  const port = labels[PORT_LABEL];
  const dbName = labels[DB_LABEL];
  if (!port || !dbName) {
    throw new Error(
      `Mevcut konteyner '${name}' için gerekli etiketler eksik (port veya veritabanı adı) — ` +
        `güvenli şekilde yeniden kullanılamıyor. Kurtarma: node scripts/test-db-harness.mjs down --run-id ${runId}`,
    );
  }

  const action = decideReviveAction({ running: isContainerRunning(name) });
  if (action === "restart") {
    warn(`runId '${runId}' için konteyner '${name}' durmuş durumda — yeniden başlatılıyor.`);
    try {
      execFileSync("docker", ["start", name], { stdio: "ignore" });
    } catch (err) {
      throw new Error(`Konteyner '${name}' yeniden başlatılamadı: ${err.message ?? String(err)}`);
    }
  } else {
    warn(`runId '${runId}' için zaten çalışan bir konteyner var: ${name} — hazırlık doğrulanıyor.`);
  }

  // Yeniden başlatılmış olsun ya da hâlihazırda çalışıyor olsun, gerçek
  // hazırlık her zaman yeniden doğrulanır (sınırlı süre — bkz. READY_TIMEOUT_MS).
  await waitForReady(name, dbName);

  const env = inspectEnv(name) ?? {};
  const { password } = validateContainerMetadata(name, { port, dbName, password: env.POSTGRES_PASSWORD });
  const databaseUrl = buildDatabaseUrl({ dbName, password, port });
  assertDisposableTestTarget(databaseUrl, { port, database: dbName });

  // tmpfs veri dizini yeniden başlatmada boş dönebileceğinden (bkz. dokümantasyon),
  // migration'lar her zaman yeniden uygulanır — bu idempotenttir ve şema
  // hazırlığını garanti eder.
  await applyMigrationsAndGenerate(databaseUrl);

  log(`Hazır (mevcut konteyner ${action === "restart" ? "yeniden başlatıldı" : "yeniden kullanıldı"}). runId=${runId} container=${name} port=${port} db=${dbName}`);
  log(`Gerçek DATABASE_URL için (kimlik bilgisi içerir, dikkatli kullanın): node scripts/test-db-harness.mjs print-url --run-id ${runId}`);
  log(`Kullanmayı bitirince: node scripts/test-db-harness.mjs down --run-id ${runId}`);
  return 0;
}

async function applyMigrationsAndGenerate(databaseUrl) {
  const env = { ...process.env, DATABASE_URL: databaseUrl };
  log("Prisma migration'ları uygulanıyor (migrate deploy)…");
  const migrateCode = await run("npx", ["prisma", "migrate", "deploy"], { env });
  if (migrateCode !== 0) throw new Error(`prisma migrate deploy başarısız oldu (kod ${migrateCode})`);

  const { existsSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const path = await import("node:path");
  const root = fileURLToPath(new URL("..", import.meta.url));
  const clientEntry = path.join(root, "node_modules", ".prisma", "client", "index.js");
  if (existsSync(clientEntry)) {
    log("Prisma Client zaten üretilmiş — yeniden üretim atlanıyor.");
  } else {
    log("Prisma Client bulunamadı, üretiliyor…");
    const genCode = await run("npx", ["prisma", "generate"], { env });
    if (genCode !== 0) throw new Error(`prisma generate başarısız oldu (kod ${genCode})`);
  }
}

function parseArgs(argv) {
  const dashIdx = argv.indexOf("--");
  const flagArgs = dashIdx === -1 ? argv.slice(1) : argv.slice(1, dashIdx);
  const command = dashIdx === -1 ? [] : argv.slice(dashIdx + 1);
  const flags = {};
  for (let i = 0; i < flagArgs.length; i++) {
    const a = flagArgs[i];
    if (a === "--run-id") flags.runId = flagArgs[++i];
    else if (a === "--keep") flags.keep = true;
    else if (a === "--quiet") flags.quiet = true;
  }
  return { sub: argv[0], flags, command };
}

async function cmdUp(flags) {
  const runId = flags.runId ?? generateRunId();
  const existing = findOwnedContainerByRunId(runId);
  if (existing) {
    return await reviveExistingContainer(runId, existing);
  }
  const { name, port, dbName, databaseUrl } = await startDisposablePostgres(runId);
  await applyMigrationsAndGenerate(databaseUrl);
  log(`Hazır. runId=${runId} container=${name} port=${port} db=${dbName}`);
  log(`Gerçek DATABASE_URL için (kimlik bilgisi içerir, dikkatli kullanın): node scripts/test-db-harness.mjs print-url --run-id ${runId}`);
  log(`Kullanmayı bitirince: node scripts/test-db-harness.mjs down --run-id ${runId}`);
  return 0;
}

async function cmdDown(flags) {
  if (!flags.runId) {
    fail("`down` için --run-id zorunludur (yalnızca bu harness'in bu runId ile işaretlediği konteyner silinir).");
    return 1;
  }
  const name = findOwnedContainerByRunId(flags.runId);
  if (!name) {
    warn(`runId '${flags.runId}' için bu harness'e ait bir konteyner bulunamadı — yapılacak bir şey yok (idempotent).`);
    return 0;
  }
  log(`Siliniyor: ${name}`);
  removeContainer(name);
  if (containerExists(name)) {
    fail(`Konteyner temizlik sonrası hâlâ var görünüyor: ${name}`);
    return 1;
  }
  log("Temizlik doğrulandı.");
  return 0;
}

async function cmdStatus(flags) {
  const containers = flags.runId
    ? (() => {
        const n = findOwnedContainerByRunId(flags.runId);
        return n ? [{ name: n, status: "" }] : [];
      })()
    : listOwnedContainers();

  if (containers.length === 0) {
    log("Bu harness'e ait çalışan/duran konteyner yok.");
    return 0;
  }
  for (const c of containers) {
    const labels = inspectLabels(c.name) ?? {};
    const runId = labels[RUN_ID_LABEL] ?? "?";
    const port = labels[PORT_LABEL] ?? "?";
    const dbName = labels[DB_LABEL] ?? "?";
    log(`runId=${runId} container=${c.name} port=${port} db=${dbName} status="${c.status}"`);
  }
  return 0;
}

async function cmdPrintUrl(flags) {
  if (!flags.runId) {
    fail("`print-url` için --run-id zorunludur.");
    return 1;
  }
  const name = findOwnedContainerByRunId(flags.runId);
  if (!name) {
    fail(`runId '${flags.runId}' için konteyner bulunamadı.`);
    return 1;
  }
  const labels = inspectLabels(name) ?? {};
  const env = inspectEnv(name) ?? {};
  const { port, dbName, password } = validateContainerMetadata(name, {
    port: labels[PORT_LABEL],
    dbName: labels[DB_LABEL],
    password: env.POSTGRES_PASSWORD,
  });
  if (!flags.quiet) {
    console.error("[test-db] UYARI: Aşağıdaki çıktı kimlik bilgisi içerir — loglara/CI çıktısına yazmayın.");
  }
  process.stdout.write(`${buildDatabaseUrl({ dbName, password, port })}\n`);
  return 0;
}

async function cmdRun(flags, command) {
  if (command.length === 0) {
    fail("`run` için `--` sonrasında çalıştırılacak bir komut belirtilmelidir. Örnek: run -- npx vitest run");
    return 1;
  }

  const attaching = Boolean(flags.runId);
  const runId = flags.runId ?? generateRunId();
  let container;
  let databaseUrl;

  if (attaching) {
    const name = findOwnedContainerByRunId(runId);
    if (!name) {
      fail(`--run-id '${runId}' ile eşleşen, önceden 'up' ile başlatılmış bir konteyner bulunamadı.`);
      return 1;
    }
    const labels = inspectLabels(name) ?? {};
    const env = inspectEnv(name) ?? {};
    // Eksik meta veri (port/dbName/parola) URL oluşturulmadan ÖNCE
    // doğrulanır — aksi halde malformed bir DATABASE_URL, kök nedeni
    // gizleyen yanıltıcı bir ayrıştırma hatasına dönüşür.
    const { port, dbName, password } = validateContainerMetadata(name, {
      port: labels[PORT_LABEL],
      dbName: labels[DB_LABEL],
      password: env.POSTGRES_PASSWORD,
    });
    if (!isContainerRunning(name)) {
      fail(
        `Konteyner '${name}' (runId=${runId}) durmuş durumda — 'run --run-id' onu yeniden başlatmaz. ` +
          `Önce çalıştırın: node scripts/test-db-harness.mjs up --run-id ${runId}`,
      );
      return 1;
    }
    databaseUrl = buildDatabaseUrl({ dbName, password, port });
    assertDisposableTestTarget(databaseUrl, { port, database: dbName });
    container = { name };
    log(`Mevcut disposable Postgres'e bağlanılıyor: runId=${runId}`);
  } else {
    container = await startDisposablePostgres(runId);
    databaseUrl = container.databaseUrl;
  }

  let exitCode = 1;
  try {
    await applyMigrationsAndGenerate(databaseUrl);
    log(`Komut çalıştırılıyor: ${command.join(" ")}`);
    exitCode = await run(command[0], command.slice(1), {
      env: { ...process.env, DATABASE_URL: databaseUrl },
    });
    log(`Komut çıkış kodu: ${exitCode}`);
  } finally {
    if (!attaching && !flags.keep) {
      log(`Temizleniyor: ${container.name}`);
      removeContainer(container.name);
      if (containerExists(container.name)) {
        fail(`Konteyner temizlik sonrası hâlâ var görünüyor: ${container.name}`);
        exitCode = exitCode === 0 ? 1 : exitCode;
      }
    } else if (flags.keep) {
      log(`--keep verildi, konteyner korunuyor: ${container.name} (runId=${runId})`);
    }
  }
  return exitCode;
}

async function main() {
  const argv = process.argv.slice(2);
  const { sub, flags, command } = parseArgs(argv);

  try {
    switch (sub) {
      case "up":
        return await cmdUp(flags);
      case "down":
        return await cmdDown(flags);
      case "status":
        return await cmdStatus(flags);
      case "print-url":
        return await cmdPrintUrl(flags);
      case "run":
        return await cmdRun(flags, command);
      default:
        console.error(
          [
            "Kullanım: node scripts/test-db-harness.mjs <up|down|status|print-url|run> [--run-id <id>] [--keep] [-- <komut...>]",
            "  up                          disposable Postgres başlatır, migration uygular",
            "  down --run-id <id>          yalnızca belirtilen runId'nin konteynerini siler",
            "  status [--run-id <id>]      bu harness'e ait konteynerleri listeler (sır içermez)",
            "  print-url --run-id <id>     gerçek DATABASE_URL'i yazdırır (kimlik bilgisi içerir)",
            "  run [--run-id <id>] [--keep] -- <komut...>",
            "                              disposable DB başlatır (veya --run-id ile mevcuduna bağlanır),",
            "                              migration uygular, komutu çalıştırır, çıkış kodunu döndürür",
          ].join("\n"),
        );
        return 1;
    }
  } catch (err) {
    if (err instanceof UnsafeTestTargetError) {
      fail(`Güvenlik kontrolü reddetti: ${err.message}`);
    } else {
      fail(err.message ?? String(err));
    }
    return 1;
  }
}

main().then((code) => process.exit(code));
