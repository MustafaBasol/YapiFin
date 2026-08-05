import { redirect } from "next/navigation";
import { getSessionUser, type SessionUser } from "@/lib/auth/session";
import type { UserRole } from "@prisma/client";

/** Sayfa/layout için: oturum yoksa girişe yönlendirir. */
export async function requireUser(): Promise<SessionUser> {
  const user = await getSessionUser();
  if (!user) redirect("/login");
  return user;
}

/** Belirli rollerle sınırlı sayfalar için. Yetkisiz kullanıcı panele geri döner. */
export async function requireRole(allowed: UserRole[]): Promise<SessionUser> {
  const user = await requireUser();
  if (!allowed.includes(user.role)) redirect("/dashboard");
  return user;
}

/** Login/signup gibi sayfalar için: zaten girişliyse panele yönlendirir. */
export async function redirectIfAuthenticated() {
  const user = await getSessionUser();
  if (user) redirect("/dashboard");
}
