import { requirePlatformAdmin } from "@/lib/auth/platform-guard";
import { platformLogoutAction } from "@/app/actions/platform-auth";
import { PlatformNav } from "@/components/platform/platform-nav";

/**
 * YF-818 — Platform Admin kabuğu. Kiracı `app/(app)/layout.tsx`daki
 * `Sidebar`/`Topbar` bileşenlerini AYNEN yeniden KULLANMAZ (görev talimatı
 * güvenlik sınırı: bir platform-admin operatörü bu paneli kiracı uygulaması
 * sanmamalı, ve tersi). Ayırt edici işaretler: üstte turkuaz (accent) şerit,
 * koyu petrol (primary) üst çubuk, "PLATFORM" rozeti, yatay iki bağlantılık
 * gezinme (Pano / Organizasyonlar) — kiracının sol dikey beyaz menüsünün
 * TAM TERSİ bir yerleşim.
 */
export default async function PlatformLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const admin = await requirePlatformAdmin();

  return (
    <div className="min-h-dvh bg-background">
      <div className="h-1 w-full bg-accent" aria-hidden />
      <header className="border-b border-black/10 bg-primary text-primary-foreground">
        <div className="mx-auto flex h-16 max-w-[1400px] items-center gap-6 px-5 lg:px-8">
          <div className="flex shrink-0 items-center gap-3">
            <span className="font-display text-[16px] font-bold tracking-tight">YapiFin Platform Admin</span>
            <span className="inline-flex items-center rounded-full bg-accent px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-[0.18em] text-accent-foreground">
              Platform
            </span>
          </div>

          <PlatformNav />

          <div className="ml-auto flex items-center gap-3">
            <span className="hidden text-[13px] text-primary-foreground/80 sm:inline">{admin.name}</span>
            <form action={platformLogoutAction}>
              <button
                type="submit"
                className="cursor-pointer rounded-lg border border-white/20 px-3 py-1.5 text-[13px] font-medium text-primary-foreground transition-colors hover:bg-white/10"
              >
                Çıkış yap
              </button>
            </form>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-[1400px] px-5 py-6 lg:px-8">{children}</main>
    </div>
  );
}
