// YF-405 — Dışa aktarma rotalarının gerçek bir `next start` sunucusuna karşı
// çalıştırıldığı, gerçek HTTP istekleriyle test edildiği ayrı bir entegrasyon
// akışı. Bilinçli olarak `npm run test` (vitest run) DIŞINDA tutulur — bu
// dosya kendisi `npx vitest run` çağırdığı için içeriden çağrılırsa (vitest
// süreci zaten çalışırken) sonsuz döngü/çift derleme riski oluşur; bu yüzden
// yalnızca `npm run test:report-export-integration` üzerinden, kendi başına
// çalıştırılmak üzere tasarlanmıştır (bkz. package.json).
//
// Adımlar: (1) DATABASE_URL zaten ortamda (aynı `.env`, npm run test ile aynı
// önkoşul) — bu script veritabanı sağlamaz, mevcut disposable Postgres'i
// kullanır; (2) `next build`; (3) `127.0.0.1` üzerinde dinamik/boş bir portta
// `next start`; (4) sınırlı zaman aşımıyla hazır olana kadar bekleme;
// (5) `tests/report-export-integration.test.ts`'i o canlı sunucuya karşı
// çalıştırma; (6) `finally` içinde sunucunun TÜM süreç ağacını sonlandırma
// (Windows'ta `taskkill /T /F`, POSIX'te ayrılmış süreç grubu + SIGKILL);
// (7) temizliğin gerçekten başarılı olduğunu doğrulama (aksi halde script
// başarısız sayılır, sessizce yeşile düşmez). Test dosyasının kendisi
// `tests/helpers.ts`'in `cleanDatabase()`'ini kullanarak veri temizliğini
// standart test paketiyle birebir aynı şekilde yapar.

import "dotenv/config";
import { spawn } from "node:child_process";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const IS_WIN = process.platform === "win32";
const READY_TIMEOUT_MS = 120_000;
const READY_POLL_INTERVAL_MS = 1000;

function log(msg) {
  console.log(`[export-integration] ${msg}`);
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

function killTree(child) {
  if (!child || child.killed || child.exitCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    if (IS_WIN) {
      const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", shell: true });
      killer.on("exit", () => resolve());
      killer.on("error", () => resolve());
    } else {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        // süreç zaten sonlanmış olabilir — yut ve devam et.
      }
      resolve();
    }
  });
}

async function waitForReady(baseUrl) {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${baseUrl}/login`, { redirect: "manual" });
      if (res.status < 500) return;
    } catch {
      // sunucu henüz dinlemiyor — tekrar dene.
    }
    await new Promise((r) => setTimeout(r, READY_POLL_INTERVAL_MS));
  }
  throw new Error(`Sunucu ${READY_TIMEOUT_MS}ms içinde hazır olmadı: ${baseUrl}`);
}

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error("[export-integration] DATABASE_URL tanımlı değil. `npm run test` ile aynı disposable Postgres önkoşulu geçerlidir.");
    process.exit(1);
  }

  log("next build çalıştırılıyor…");
  await run("npx", ["next", "build"]);

  const port = await getFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  log(`next start başlatılıyor: ${baseUrl}`);

  // `next start` NODE_ENV=production ile çalışır; `lib/env.ts`'in üretim
  // sözleşmesi SMTP_HOST/SMTP_FROM'un dolu olmasını zorunlu kılar (bkz.
  // docs/PRODUCTION_READINESS.md §11.2) — export testleri hiçbir e-posta
  // gönderim yolunu tetiklemediğinden gerçek bir SMTP sunucusuna gerek
  // yoktur, yalnızca `getEnv()`'in başlangıç doğrulamasını geçecek
  // biçimde dolu/geçerli değerler yeterlidir.
  const server = spawn("npx", ["next", "start", "-p", String(port), "-H", "127.0.0.1"], {
    cwd: ROOT,
    stdio: "inherit",
    shell: true,
    detached: !IS_WIN,
    env: {
      ...process.env,
      SMTP_HOST: process.env.SMTP_HOST || "localhost",
      SMTP_PORT: process.env.SMTP_PORT || "587",
      SMTP_FROM: process.env.SMTP_FROM || "YapiFin <noreply@yapifin.com>",
    },
  });
  if (!IS_WIN) server.unref();

  let exitCode = 1;
  try {
    await waitForReady(baseUrl);
    log("Sunucu hazır — entegrasyon testleri çalıştırılıyor…");
    await run("npx", ["vitest", "run", "--config", "vitest.integration.config.ts"], {
      env: { ...process.env, EXPORT_INTEGRATION_BASE_URL: baseUrl },
    });
    exitCode = 0;
    log("Entegrasyon testleri başarılı.");
  } catch (err) {
    console.error(`[export-integration] Başarısız: ${err.message}`);
    exitCode = 1;
  } finally {
    log("Sunucu süreç ağacı sonlandırılıyor…");
    await killTree(server);
    await new Promise((r) => setTimeout(r, 500));
    if (server.exitCode === null && !server.killed) {
      console.error("[export-integration] UYARI: sunucu süreci temizlik sonrası hâlâ çalışıyor gibi görünüyor.");
      exitCode = 1;
    }
  }
  process.exit(exitCode);
}

main().catch((err) => {
  console.error("[export-integration] Beklenmeyen hata:", err);
  process.exit(1);
});
