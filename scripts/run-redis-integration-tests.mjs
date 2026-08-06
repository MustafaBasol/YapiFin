// YF-509 — Redis tabanlı dağıtık rate limiting'in GERÇEK bir Redis'e karşı
// test edildiği ayrı bir entegrasyon akışı (yalnızca mock testler yeterli
// değildir). `scripts/run-export-integration-tests.mjs` ile aynı desen:
// kendi başına, `npm run test` (vitest run) DIŞINDA çalıştırılmak üzere
// tasarlanmıştır.
//
// Adımlar: (1) DATABASE_URL zaten ortamda olmalı — bazı senaryolar gerçek
// server action'ları (login/signup/forgot-password vb.) gerçek DB'ye karşı
// çalıştırır, `npm run test` ile aynı disposable Postgres önkoşulu geçerlidir;
// (2) REDIS_URL zaten ortamda tanımlıysa (örn. CI'daki `services.redis`)
// DOKUNULMAZ — doğrudan o Redis'e karşı çalışılır; tanımlı değilse (yerel
// geliştirme) görev bazlı, benzersiz isimli, disposable bir `redis:7-alpine`
// konteyneri başlatılır (böylece paralel çalışan başka görevlerin
// konteynerleriyle çakışmaz); (3) hazır olana kadar `redis-cli ping` ile
// bekleme; (4) `tests/rate-limit-redis-integration.test.ts`'i
// `vitest.redis-integration.config.ts` ile çalıştırma; (5) yalnızca BU
// script'in başlattığı konteyneri `finally` içinde durdurup silme ve
// temizliğin gerçekten başarılı olduğunu doğrulama.

import "dotenv/config";
import { spawn, execFileSync } from "node:child_process";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const READY_TIMEOUT_MS = 60_000;
const READY_POLL_INTERVAL_MS = 500;
const CONTAINER_NAME = `yf509-redis-test-${process.pid}`;

function log(msg) {
  console.log(`[redis-integration] ${msg}`);
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

function run(command, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: ROOT, stdio: "inherit", shell: true, ...opts });
    child.on("exit", (code) => (code === 0 ? resolve(code) : reject(new Error(`${command} ${args.join(" ")} exited with code ${code}`))));
    child.on("error", reject);
  });
}

function dockerPingOk(containerName) {
  try {
    const out = execFileSync("docker", ["exec", containerName, "redis-cli", "ping"], { encoding: "utf8" });
    return out.trim() === "PONG";
  } catch {
    return false;
  }
}

async function waitForRedisReady(containerName) {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (dockerPingOk(containerName)) return;
    await new Promise((r) => setTimeout(r, READY_POLL_INTERVAL_MS));
  }
  throw new Error(`Redis konteyneri ${READY_TIMEOUT_MS}ms içinde hazır olmadı: ${containerName}`);
}

function removeContainer(containerName) {
  try {
    execFileSync("docker", ["rm", "-f", containerName], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function containerExists(containerName) {
  try {
    const out = execFileSync("docker", ["ps", "-a", "--filter", `name=^${containerName}$`, "--format", "{{.Names}}"], {
      encoding: "utf8",
    });
    return out.trim() === containerName;
  } catch {
    return false;
  }
}

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error("[redis-integration] DATABASE_URL tanımlı değil. `npm run test` ile aynı disposable Postgres önkoşulu geçerlidir.");
    process.exit(1);
  }

  const externallyProvided = Boolean(process.env.REDIS_URL);
  let startedOwnContainer = false;
  let exitCode = 1;

  try {
    if (externallyProvided) {
      log(`REDIS_URL zaten tanımlı (${process.env.REDIS_URL.replace(/\/\/.*@/, "//***@")}) — dışarıdan sağlanan Redis kullanılacak (kendi konteynerimiz başlatılmayacak).`);
    } else {
      const port = await getFreePort();
      log(`Görev bazlı disposable Redis konteyneri başlatılıyor: ${CONTAINER_NAME} (port ${port})`);
      await run("docker", ["run", "-d", "--name", CONTAINER_NAME, "-p", `${port}:6379`, "redis:7-alpine"]);
      startedOwnContainer = true;
      await waitForRedisReady(CONTAINER_NAME);
      process.env.REDIS_URL = `redis://127.0.0.1:${port}`;
      log(`Redis hazır: ${process.env.REDIS_URL}`);
    }

    log("Entegrasyon testleri çalıştırılıyor…");
    await run("npx", ["vitest", "run", "--config", "vitest.redis-integration.config.ts"]);
    exitCode = 0;
    log("Redis entegrasyon testleri başarılı.");
  } catch (err) {
    console.error(`[redis-integration] Başarısız: ${err.message}`);
    exitCode = 1;
  } finally {
    if (startedOwnContainer) {
      log(`Konteyner temizleniyor: ${CONTAINER_NAME}`);
      removeContainer(CONTAINER_NAME);
      if (containerExists(CONTAINER_NAME)) {
        console.error(`[redis-integration] UYARI: konteyner temizlik sonrası hâlâ var görünüyor: ${CONTAINER_NAME}`);
        exitCode = 1;
      }
    }
  }
  process.exit(exitCode);
}

main().catch((err) => {
  console.error("[redis-integration] Beklenmeyen hata:", err);
  process.exit(1);
});
