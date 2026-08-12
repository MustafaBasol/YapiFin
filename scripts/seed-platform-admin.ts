/**
 * YF-818 — Platform Admin hesabı oluşturma/parola sıfırlama aracı.
 *
 * Kasıtlı olarak bir self-servis kayıt AKIŞI YOKTUR (görev talimatı: "no
 * self-serve signup" — internal ops paneli için gereksiz saldırı yüzeyi).
 * Yeni hesaplar YALNIZCA ops tarafından, doğrudan veritabanı erişimine sahip
 * bir ortamda bu script ile oluşturulur.
 *
 * Kullanım:
 *   npx tsx scripts/seed-platform-admin.ts --email ops@yapifin.com --name "Ops Adı"
 *   npx tsx scripts/seed-platform-admin.ts --email ops@yapifin.com --name "Ops Adı" --password "<kendi-parolanız>"
 *
 * `--password` verilmezse güvenli, rastgele bir parola üretilir ve YALNIZCA
 * BİR KEZ, bu komutu çalıştıran operatörün kendi terminaline yazdırılır —
 * hiçbir yerde (DB, log dosyası) düz metin olarak SAKLANMAZ. Hesap zaten
 * varsa ve `--password` verilmemişse, parolayı SESSİZCE değiştirmemek için
 * script başarısız olur (yalnızca `name` güncellenir).
 */
import { randomBytes } from "node:crypto";
import { db } from "../lib/db";
import { hashPassword } from "../lib/auth/password";

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) {
      const key = argv[i].slice(2);
      const value = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : "true";
      out[key] = value;
    }
  }
  return out;
}

function generatePassword(): string {
  // 24 byte rastgelelik, URL-safe alfabe — tenant parola politikasından
  // (min 8 karakter + harf/rakam) kasıtlı olarak DAHA GÜÇLÜ, çünkü bu hesap
  // platform-genel yetki taşır.
  return randomBytes(24).toString("base64url");
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const email = args.email?.trim().toLowerCase();
  const name = args.name?.trim();

  if (!email || !name) {
    console.error("Kullanım: npx tsx scripts/seed-platform-admin.ts --email <e-posta> --name <ad soyad> [--password <parola>]");
    process.exit(1);
  }

  const existing = await db.platformAdmin.findUnique({ where: { email } });

  if (existing && !args.password) {
    console.log(`[seed-platform-admin] '${email}' zaten mevcut. Parolayı değiştirmeden yalnızca ad güncelleniyor.`);
    await db.platformAdmin.update({ where: { email }, data: { name } });
    console.log("[seed-platform-admin] Tamamlandı.");
    process.exit(0);
  }

  const plainPassword = args.password ?? generatePassword();
  const passwordHash = await hashPassword(plainPassword);

  await db.platformAdmin.upsert({
    where: { email },
    create: { email, name, passwordHash, status: "ACTIVE" },
    update: { name, passwordHash, status: "ACTIVE" },
  });

  console.log(`[seed-platform-admin] '${email}' için hesap ${existing ? "güncellendi" : "oluşturuldu"}.`);
  if (!args.password) {
    console.log("[seed-platform-admin] Üretilen parola (yalnızca ŞİMDİ gösterilir, güvenli şekilde saklayın):");
    console.log(plainPassword);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error("[seed-platform-admin] Beklenmeyen hata:", err instanceof Error ? err.message : err);
  process.exit(1);
});
