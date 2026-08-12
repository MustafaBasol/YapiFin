"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

const NAV_ITEMS = [
  { href: "/platform", label: "Pano" },
  { href: "/platform/organizations", label: "Organizasyonlar" },
] as const;

/**
 * YF-818 — Platform Admin üst navigasyonu. Kiracı `Sidebar`ından (sol,
 * dikey, beyaz zemin) KASITLI OLARAK farklı: yatay, koyu petrol üst çubuk
 * içinde, yalnızca iki bağlantı — platform-admin operatörünün yanlışlıkla
 * kiracı panelinde olduğunu düşünmesi yapısal olarak engellenir.
 */
export function PlatformNav() {
  const pathname = usePathname();

  return (
    <nav className="flex items-center gap-1">
      {NAV_ITEMS.map((item) => {
        const active = item.href === "/platform" ? pathname === item.href : pathname.startsWith(item.href);
        return (
          <Link
            key={item.href}
            href={item.href}
            className={cn(
              "rounded-lg px-3 py-1.5 text-[13.5px] font-medium transition-colors",
              active ? "bg-white/15 text-white" : "text-primary-foreground/75 hover:bg-white/10 hover:text-white",
            )}
          >
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}
