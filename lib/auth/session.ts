import { cookies, headers } from "next/headers";
import { cache } from "react";
import { db } from "@/lib/db";
import { generateToken, hashToken } from "@/lib/auth/tokens";
import { resolveClientIp, getTrustedProxyCount } from "@/lib/rate-limit/client-ip";
import type { User, UserRole, UserStatus } from "@prisma/client";

export const SESSION_COOKIE = "yapifin_session";
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 gün

export interface SessionUser {
  id: string;
  organizationId: string;
  firstName: string;
  lastName: string;
  email: string;
  role: UserRole;
  status: UserStatus;
  emailVerifiedAt: Date | null;
  organizationName: string;
}

async function requestMeta() {
  const h = await headers();
  return {
    ipAddress: resolveClientIp(h.get("x-forwarded-for"), getTrustedProxyCount()),
    userAgent: h.get("user-agent") ?? null,
  };
}

/** Yeni oturum oluşturur, DB'de tutar ve httpOnly cookie olarak yazar. */
export async function createSession(userId: string) {
  const { raw, hash } = generateToken();
  const meta = await requestMeta();
  await db.session.create({
    data: {
      userId,
      tokenHash: hash,
      expiresAt: new Date(Date.now() + SESSION_TTL_MS),
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
    },
  });

  const jar = await cookies();
  jar.set(SESSION_COOKIE, raw, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_TTL_MS / 1000,
  });
}

/** Aktif oturumu DB'den ve cookie'den siler. */
export async function destroySession() {
  const jar = await cookies();
  const raw = jar.get(SESSION_COOKIE)?.value;
  if (raw) {
    await db.session.deleteMany({ where: { tokenHash: hashToken(raw) } });
  }
  jar.delete(SESSION_COOKIE);
}

/**
 * Geçerli isteğin oturum kullanıcısını getirir. Her istekte DB'den taze
 * okunur; böylece kullanıcı pasifleştirildiğinde erişim JWT süresini
 * beklemeden anında kesilir. Bir istek içinde tekrar sorgu yapılmaması için
 * React cache() ile memoize edilir.
 */
export const getSessionUser = cache(async (): Promise<SessionUser | null> => {
  const jar = await cookies();
  const raw = jar.get(SESSION_COOKIE)?.value;
  if (!raw) return null;

  const session = await db.session.findUnique({
    where: { tokenHash: hashToken(raw) },
    include: { user: { include: { organization: true } } },
  });

  if (!session || session.expiresAt < new Date()) {
    if (session) await db.session.delete({ where: { id: session.id } }).catch(() => {});
    return null;
  }

  const user = session.user;
  if (user.status === "SUSPENDED") return null;

  return {
    id: user.id,
    organizationId: user.organizationId,
    firstName: user.firstName,
    lastName: user.lastName,
    email: user.email,
    role: user.role,
    status: user.status,
    emailVerifiedAt: user.emailVerifiedAt,
    organizationName: user.organization.tradeName ?? user.organization.name,
  };
});

export type { User };
