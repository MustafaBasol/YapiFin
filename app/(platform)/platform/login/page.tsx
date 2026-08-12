import { redirectIfPlatformAdminAuthenticated } from "@/lib/auth/platform-guard";
import { PlatformLoginForm } from "@/components/platform/platform-login-form";

/**
 * YF-818 — Platform Admin giriş sayfası. Kiracı `/login` (`AuthShell`,
 * split-panel marka görseli) ile KASITLI OLARAK aynı bileşenleri PAYLAŞMAZ —
 * tam ekran koyu petrol zemin + "PLATFORM" rozeti, bir operatörün bu ekranı
 * kiracı girişiyle karıştırmasını yapısal olarak engeller.
 */
export default async function PlatformLoginPage() {
  await redirectIfPlatformAdminAuthenticated();

  return (
    <div className="grid min-h-dvh place-items-center bg-primary px-6 py-12">
      <div className="w-full max-w-sm space-y-7">
        <div className="text-center">
          <span className="inline-flex items-center rounded-full bg-accent px-3 py-1 text-[11px] font-bold uppercase tracking-[0.2em] text-accent-foreground">
            Platform
          </span>
          <h1 className="mt-4 font-display text-2xl font-bold text-white">YapiFin Platform Admin</h1>
          <p className="mt-1 text-sm text-white/70">Operatör paneline giriş yapın</p>
        </div>

        <div className="rounded-2xl border border-white/10 bg-card p-6 shadow-pop">
          <PlatformLoginForm />
        </div>

        <p className="text-center text-xs text-white/50">Bu panel yalnızca yetkili YapiFin operatörleri içindir.</p>
      </div>
    </div>
  );
}
