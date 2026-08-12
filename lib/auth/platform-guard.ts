import { redirect } from "next/navigation";
import { getPlatformAdminSessionUser, type PlatformAdminSessionUser } from "@/lib/auth/platform-session";

/**
 * YF-818 — `lib/auth/guard.ts` `requireUser`in platform-admin karşılığı.
 * Fail-closed: oturum yoksa veya süresi/durumu geçersizse platform girişine
 * yönlendirir — hiçbir platform sayfası/route handler'ı bu kontrolü
 * ATLAYAMAZ (görev talimatı: "fail closed", "no platform admin APIs
 * available to normal authenticated tenant users").
 */
export async function requirePlatformAdmin(): Promise<PlatformAdminSessionUser> {
  const admin = await getPlatformAdminSessionUser();
  if (!admin) redirect("/platform/login");
  return admin;
}

/** Login sayfası için: zaten girişliyse panele yönlendirir. */
export async function redirectIfPlatformAdminAuthenticated() {
  const admin = await getPlatformAdminSessionUser();
  if (admin) redirect("/platform");
}
