import { cookies, headers } from "next/headers";
import { cache } from "react";
import { db } from "@/lib/db";
import { generateToken, hashToken } from "@/lib/auth/tokens";
import { resolveClientIp, getTrustedProxyCount } from "@/lib/rate-limit/client-ip";
import type { PlatformAdminStatus } from "@prisma/client";

/**
 * YF-818 — `lib/auth/session.ts` ile AYNI opak token + SHA-256 hash + httpOnly
 * cookie deseni, ama TAMAMEN AYRI cookie/tablo (`PlatformAdminSession`) ve
 * kimlik tipi (`PlatformAdmin`) üzerinden. Bilinçli olarak `SessionUser`/
 * `getSessionUser` ile HİÇBİR KOD PAYLAŞMAZ — bir tenant `User` oturumunun
 * yanlışlıkla platform-admin olarak yorumlanma riski yapısal olarak SIFIRDIR
 * (görev talimatı, güvenlik sınırı bölümü).
 */
export const PLATFORM_SESSION_COOKIE = "yapifin_platform_session";
const PLATFORM_SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12 saat — tenant oturumundan (30 gün) KASITLI olarak çok daha kısa (yüksek ayrıcalıklı, düşük hacimli operatör erişimi).

export interface PlatformAdminSessionUser {
  id: string;
  email: string;
  name: string;
  status: PlatformAdminStatus;
}

async function requestMeta() {
  const h = await headers();
  return {
    ipAddress: resolveClientIp(h.get("x-forwarded-for"), getTrustedProxyCount()),
    userAgent: h.get("user-agent") ?? null,
  };
}

/** Yeni platform-admin oturumu oluşturur, DB'de tutar ve httpOnly cookie olarak yazar. */
export async function createPlatformAdminSession(platformAdminId: string) {
  const { raw, hash } = generateToken();
  const meta = await requestMeta();
  await db.platformAdminSession.create({
    data: {
      platformAdminId,
      tokenHash: hash,
      expiresAt: new Date(Date.now() + PLATFORM_SESSION_TTL_MS),
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
    },
  });

  const jar = await cookies();
  jar.set(PLATFORM_SESSION_COOKIE, raw, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: PLATFORM_SESSION_TTL_MS / 1000,
  });
}

/** Aktif platform-admin oturumunu DB'den ve cookie'den siler. */
export async function destroyPlatformAdminSession() {
  const jar = await cookies();
  const raw = jar.get(PLATFORM_SESSION_COOKIE)?.value;
  if (raw) {
    await db.platformAdminSession.deleteMany({ where: { tokenHash: hashToken(raw) } });
  }
  jar.delete(PLATFORM_SESSION_COOKIE);
}

/**
 * Geçerli isteğin platform-admin oturum kullanıcısını getirir. `getSessionUser`
 * ile AYNI gerekçeyle her istekte DB'den taze okunur (SUSPENDED anında
 * yansır) ve React `cache()` ile istek-içi memoize edilir.
 */
export const getPlatformAdminSessionUser = cache(async (): Promise<PlatformAdminSessionUser | null> => {
  const jar = await cookies();
  const raw = jar.get(PLATFORM_SESSION_COOKIE)?.value;
  if (!raw) return null;

  const session = await db.platformAdminSession.findUnique({
    where: { tokenHash: hashToken(raw) },
    include: { platformAdmin: true },
  });

  if (!session || session.expiresAt < new Date()) {
    if (session) await db.platformAdminSession.delete({ where: { id: session.id } }).catch(() => {});
    return null;
  }

  const admin = session.platformAdmin;
  if (admin.status === "SUSPENDED") return null;

  return { id: admin.id, email: admin.email, name: admin.name, status: admin.status };
});
