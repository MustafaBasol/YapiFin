import { db } from "@/lib/db";
import { verifyPassword } from "@/lib/auth/password";
import { ServiceError } from "@/server/services/errors";
import type { PlatformAdmin } from "@prisma/client";

/**
 * YF-818 — `server/services/auth-service.ts` `authenticateUser` ile AYNI
 * desen (bkz. o dosya) — ama `User` yerine `PlatformAdmin` üzerinde, e-posta
 * ORGANIZATION-scope OLMADIĞI için (platform admin tenant'a ait değildir)
 * `findUnique` yeterlidir, `findMany` aday listesi GEREKMEZ.
 */
export async function authenticatePlatformAdmin(email: string, password: string): Promise<PlatformAdmin> {
  const admin = await db.platformAdmin.findUnique({ where: { email } });
  if (!admin || admin.status !== "ACTIVE") {
    throw new ServiceError("Geçersiz e-posta veya parola", "VALIDATION");
  }
  if (!(await verifyPassword(password, admin.passwordHash))) {
    throw new ServiceError("Geçersiz e-posta veya parola", "VALIDATION");
  }
  await db.platformAdmin.update({ where: { id: admin.id }, data: { lastLoginAt: new Date() } });
  return admin;
}
