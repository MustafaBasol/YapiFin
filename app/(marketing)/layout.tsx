import Link from "next/link";
import appConfig from "@/app.config";
import { Logo } from "@/components/ui/logo";
import { Button } from "@/components/ui/button";

export default function MarketingLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <div className="flex min-h-dvh flex-col">
      <header className="sticky top-0 z-30 border-b border-border bg-background/80 backdrop-blur">
        <div className="mx-auto flex h-16 max-w-6xl items-center px-5">
          <Link href="/">
            <Logo />
          </Link>
          <nav className="ml-auto hidden items-center gap-7 text-sm font-medium text-muted-foreground md:flex">
            <a href="#features" className="hover:text-foreground transition-colors">Özellikler</a>
          </nav>
          <div className="ml-auto flex items-center gap-2 md:ml-7">
            <Link href="/login">
              <Button variant="ghost" size="sm">Giriş yap</Button>
            </Link>
            <Link href="/signup">
              <Button size="sm">Başla</Button>
            </Link>
          </div>
        </div>
      </header>

      <div className="flex-1">{children}</div>

      <footer className="border-t border-border">
        <div className="mx-auto flex max-w-6xl flex-col gap-4 px-5 py-10 sm:flex-row sm:items-center">
          <Logo />
          <p className="text-sm text-muted-foreground sm:ml-auto">
            © {appConfig.name} · {appConfig.domain}
          </p>
        </div>
      </footer>
    </div>
  );
}
