"use client";

import { usePathname } from "next/navigation";
import { Bell } from "lucide-react";
import appConfig from "@/app.config";

export function Topbar() {
  const pathname = usePathname();
  const current = appConfig.nav.find((n) => pathname === n.href || pathname.startsWith(n.href + "/"));

  return (
    <header className="sticky top-0 z-20 flex h-14 items-center gap-4 border-b border-border bg-background/80 px-5 backdrop-blur lg:px-8">
      <span className="font-display text-[15px] font-semibold tracking-tight md:hidden">
        {current ? current.label : appConfig.name}
      </span>

      <div className="ml-auto flex items-center gap-1.5">
        <button
          aria-label="Bildirimler"
          className="relative grid h-9 w-9 cursor-pointer place-items-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <Bell className="h-[18px] w-[18px]" />
        </button>
      </div>
    </header>
  );
}
