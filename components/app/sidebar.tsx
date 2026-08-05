"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { LogOut } from "lucide-react";
import appConfig from "@/app.config";
import { Logo } from "@/components/ui/logo";
import { Icon } from "@/components/ui/icon";
import { cn, initials } from "@/lib/utils";
import { logoutAction } from "@/app/actions/auth";
import type { SessionUser } from "@/lib/auth/session";

export function Sidebar({ user }: { user: SessionUser }) {
  const pathname = usePathname();

  const isActive = (href: string) => pathname === href || pathname.startsWith(href + "/");

  const items = appConfig.nav.filter((item) => !item.roles || item.roles.includes(user.role));

  return (
    <aside className="hidden w-[260px] shrink-0 flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground md:flex">
      <div className="flex h-16 items-center px-5">
        <Link href="/dashboard" className="inline-flex">
          <Logo withChevron />
        </Link>
      </div>

      <nav className="flex-1 overflow-y-auto px-3 py-2">
        <div className="space-y-0.5">
          {items.map((item) => {
            const active = isActive(item.href);
            const inner = (
              <>
                <Icon
                  name={item.icon}
                  className={cn("h-[17px] w-[17px] shrink-0", active ? "text-primary" : "text-muted-foreground")}
                />
                <span className="truncate">{item.label}</span>
                {item.comingSoon && (
                  <span className="ml-auto rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-semibold text-muted-foreground">
                    Yakında
                  </span>
                )}
              </>
            );
            if (item.comingSoon) {
              return (
                <span
                  key={item.href}
                  className="group flex cursor-default items-center gap-2.5 rounded-lg px-3 py-2 text-[13.5px] font-medium text-sidebar-muted"
                >
                  {inner}
                </span>
              );
            }
            return (
              <Link
                key={item.href}
                href={item.href}
                className={cn(
                  "group flex items-center gap-2.5 rounded-lg px-3 py-2 text-[13.5px] font-medium transition-colors",
                  active ? "nav-pill-active text-foreground" : "text-foreground/70 hover:bg-muted hover:text-foreground",
                )}
              >
                {inner}
              </Link>
            );
          })}
        </div>
      </nav>

      <div className="border-t border-sidebar-border p-3">
        <div className="flex items-center gap-2.5 rounded-xl border border-border bg-card px-2.5 py-2 shadow-pill">
          <span
            className="grid h-9 w-9 shrink-0 place-items-center rounded-full text-xs font-bold text-white"
            style={{ backgroundImage: "var(--grad-brand)" }}
          >
            {initials(`${user.firstName} ${user.lastName}`)}
          </span>
          <div className="min-w-0 flex-1">
            <p className="truncate text-[13px] font-semibold">
              {user.firstName} {user.lastName}
            </p>
            <p className="truncate text-[11.5px] text-muted-foreground">{user.organizationName}</p>
          </div>
          <form action={logoutAction}>
            <button
              type="submit"
              aria-label="Çıkış"
              className="grid h-7 w-7 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground cursor-pointer"
            >
              <LogOut className="h-4 w-4" />
            </button>
          </form>
        </div>
      </div>
    </aside>
  );
}
