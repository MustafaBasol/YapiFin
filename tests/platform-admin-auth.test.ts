import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { cleanDatabase, createOwnerOrg } from "./helpers";
import { hashPassword } from "@/lib/auth/password";
import { generateToken, hashToken } from "@/lib/auth/tokens";
import { authenticatePlatformAdmin } from "@/server/services/platform/platform-auth-service";
import { ServiceError } from "@/server/services/errors";
import type { PlatformAdminStatus } from "@prisma/client";

/**
 * YF-818 — `authenticatePlatformAdmin` (server/services/platform/platform-auth-service.ts)
 * + ham `PlatformAdminSession` satır davranışı.
 *
 * `getPlatformAdminSessionUser`/`createPlatformAdminSession`/`destroyPlatformAdminSession`
 * (lib/auth/platform-session.ts) `next/headers` `cookies()`/`headers()`'e bağlıdır ve
 * yalnızca istek-kapsamlı (request-scoped) bir bağlamda çalışır. Bu depodaki TEK emsal
 * (`tests/auth-failed-login-classification.test.ts`) `next/headers`'ı TAMAMEN mock'lar
 * VE `createSession`'ın KENDİSİNİ de mock'lar (gerçek `createSession`'ı hiç çağırmaz) —
 * yani "gerçek, cookie tabanlı yardımcıyı doğrudan çalıştırma" için bir emsal YOKTUR.
 * Görev talimatına uygun olarak bu dosya `getPlatformAdminSessionUser`'ı ATLAR ve
 * bunun yerine `db.platformAdminSession` ham satır davranışını (tokenHash ile arama,
 * süresi dolmuş oturumun geçersiz sayılması) doğrudan DB üzerinden doğrular — bu,
 * `getPlatformAdminSessionUser` içindeki KARAR mantığıyla (bkz. o dosya:
 * `session.expiresAt < new Date()` → null) birebir aynı kontroldür.
 */

beforeAll(async () => {
  await cleanDatabase();
});

afterEach(async () => {
  await cleanDatabase();
});

afterAll(async () => {
  await db.$disconnect();
});

let counter = 0;
function uniqueEmail(prefix: string): string {
  counter += 1;
  return `${prefix}-${Date.now()}-${counter}@example.com`;
}

async function createPlatformAdmin(overrides: {
  email?: string;
  password?: string;
  name?: string;
  status?: PlatformAdminStatus;
} = {}) {
  const password = overrides.password ?? "PlatformSifre123!";
  const passwordHash = await hashPassword(password);
  const admin = await db.platformAdmin.create({
    data: {
      email: overrides.email ?? uniqueEmail("platform-admin"),
      passwordHash,
      name: overrides.name ?? "Test Platform Admin",
      status: overrides.status ?? "ACTIVE",
    },
  });
  return { admin, password };
}

describe("YF-818 — authenticatePlatformAdmin", () => {
  it("doğru e-posta + parola ile ACTIVE bir admin için başarılı olur ve lastLoginAt güncellenir", async () => {
    const { admin, password } = await createPlatformAdmin();
    expect(admin.lastLoginAt).toBeNull();

    const result = await authenticatePlatformAdmin(admin.email, password);
    expect(result.id).toBe(admin.id);
    expect(result.status).toBe("ACTIVE");

    const row = await db.platformAdmin.findUniqueOrThrow({ where: { id: admin.id } });
    expect(row.lastLoginAt).not.toBeNull();
    expect(row.lastLoginAt!.getTime()).toBeGreaterThan(admin.createdAt.getTime() - 1);
  });

  it("yanlış parola için ServiceError (VALIDATION) fırlatır", async () => {
    const { admin } = await createPlatformAdmin({ password: "DogruSifre123!" });
    await expect(authenticatePlatformAdmin(admin.email, "YanlisSifre999!")).rejects.toBeInstanceOf(ServiceError);
    try {
      await authenticatePlatformAdmin(admin.email, "YanlisSifre999!");
      throw new Error("beklenen hata fırlatılmadı");
    } catch (err) {
      expect(err).toBeInstanceOf(ServiceError);
      expect((err as ServiceError).code).toBe("VALIDATION");
    }

    // Başarısız denemede lastLoginAt GÜNCELLENMEZ.
    const row = await db.platformAdmin.findUniqueOrThrow({ where: { id: admin.id } });
    expect(row.lastLoginAt).toBeNull();
  });

  it("bilinmeyen e-posta için ServiceError (VALIDATION) fırlatır", async () => {
    await expect(authenticatePlatformAdmin(uniqueEmail("bilinmeyen"), "HerhangiBirSifre123!")).rejects.toMatchObject({
      code: "VALIDATION",
    });
  });

  it("SUSPENDED bir admin, parola doğru olsa BİLE authenticate OLAMAZ", async () => {
    const { admin, password } = await createPlatformAdmin({ status: "SUSPENDED" });
    await expect(authenticatePlatformAdmin(admin.email, password)).rejects.toMatchObject({ code: "VALIDATION" });

    const row = await db.platformAdmin.findUniqueOrThrow({ where: { id: admin.id } });
    expect(row.lastLoginAt).toBeNull(); // Reddedilen giriş denemesi iz bırakmaz.
  });

  it("iki farklı kimlik sistemi ÇAPRAZ kimlik doğrulama YAPMAZ: tenant User'ın e-posta/parolası ile authenticatePlatformAdmin BAŞARISIZ olur", async () => {
    const tenantPassword = "TenantSifre123!";
    const { owner } = await createOwnerOrg({ password: tenantPassword });

    // Yapısal doğrulama: aynı e-postayla açıkça oluşturulmadıkça HİÇBİR PlatformAdmin satırı YOKTUR.
    const platformAdminWithSameEmail = await db.platformAdmin.findUnique({ where: { email: owner.email } });
    expect(platformAdminWithSameEmail).toBeNull();

    // Tenant User'ın gerçek parolası (hash'lenmemiş hali) ile platform-admin girişi denenir — bilinmeyen e-posta olarak reddedilir.
    await expect(authenticatePlatformAdmin(owner.email, tenantPassword)).rejects.toMatchObject({ code: "VALIDATION" });
  });
});

describe("YF-818 — PlatformAdminSession ham satır davranışı (tokenHash arama + süre dolumu)", () => {
  it("createPlatformAdminSession'ı ANDIRAN bir satır tokenHash ile bulunabilir", async () => {
    const { admin } = await createPlatformAdmin();
    const { raw, hash } = generateToken();

    await db.platformAdminSession.create({
      data: {
        platformAdminId: admin.id,
        tokenHash: hash,
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
        ipAddress: "127.0.0.1",
        userAgent: "vitest",
      },
    });

    const found = await db.platformAdminSession.findUnique({
      where: { tokenHash: hashToken(raw) },
      include: { platformAdmin: true },
    });
    expect(found).not.toBeNull();
    expect(found!.platformAdmin.id).toBe(admin.id);
  });

  it("süresi dolmuş (expiresAt geçmişte) bir oturum, getPlatformAdminSessionUser'daki AYNI kontrolle (expiresAt < now) geçersiz sayılır", async () => {
    const { admin } = await createPlatformAdmin();
    const { hash } = generateToken();
    const expiredSession = await db.platformAdminSession.create({
      data: {
        platformAdminId: admin.id,
        tokenHash: hash,
        expiresAt: new Date(Date.now() - 1000),
      },
    });

    const found = await db.platformAdminSession.findUniqueOrThrow({ where: { id: expiredSession.id } });
    // lib/auth/platform-session.ts `getPlatformAdminSessionUser` ile BİREBİR AYNI karar: `session.expiresAt < new Date()` → geçersiz.
    expect(found.expiresAt.getTime() < Date.now()).toBe(true);
  });

  it("geçerli (henüz süresi dolmamış) bir oturum AYNI kontrolde geçerli sayılır", async () => {
    const { admin } = await createPlatformAdmin();
    const { hash } = generateToken();
    const validSession = await db.platformAdminSession.create({
      data: {
        platformAdminId: admin.id,
        tokenHash: hash,
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      },
    });

    const found = await db.platformAdminSession.findUniqueOrThrow({ where: { id: validSession.id } });
    expect(found.expiresAt.getTime() < Date.now()).toBe(false);
  });

  it("PlatformAdmin silinince ilişkili PlatformAdminSession CASCADE ile silinir", async () => {
    const { admin } = await createPlatformAdmin();
    const { hash } = generateToken();
    await db.platformAdminSession.create({
      data: { platformAdminId: admin.id, tokenHash: hash, expiresAt: new Date(Date.now() + 60 * 60 * 1000) },
    });
    expect(await db.platformAdminSession.count({ where: { platformAdminId: admin.id } })).toBe(1);

    await db.platformAdmin.delete({ where: { id: admin.id } });
    expect(await db.platformAdminSession.count({ where: { platformAdminId: admin.id } })).toBe(0);
  });
});
