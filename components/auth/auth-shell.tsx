import Link from "next/link";
import appConfig from "@/app.config";
import { Logo } from "@/components/ui/logo";

export function AuthShell({
  eyebrow,
  title,
  wide = false,
  children,
}: {
  eyebrow?: string;
  title: string;
  wide?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="grid min-h-dvh lg:grid-cols-[1.05fr_1fr]">
      <section
        className="relative hidden flex-col justify-between overflow-hidden p-12 text-white lg:flex"
        style={{ backgroundImage: "var(--grad-brand)" }}
      >
        <span className="pointer-events-none absolute -right-16 -top-20 h-80 w-80 rounded-full bg-white/15 blur-3xl" />
        <span className="pointer-events-none absolute -bottom-16 -left-10 h-64 w-64 rounded-full bg-black/15 blur-3xl" />

        <Link href="/" className="relative">
          <Logo onDark />
        </Link>

        <div className="relative max-w-md">
          <p className="text-xs uppercase tracking-[0.22em] text-white/70">{appConfig.marketing.badge}</p>
          <h1 className="mt-3 font-display text-4xl font-semibold leading-tight">{appConfig.tagline}</h1>
          <p className="mt-5 text-[15px] leading-relaxed text-white/85">{appConfig.description}</p>
        </div>

        <p className="relative text-xs text-white/65">
          © {appConfig.name} · {appConfig.domain}
        </p>
      </section>

      <section className="relative flex flex-col items-center justify-center px-6 py-12">
        <div className={wide ? "w-full max-w-lg space-y-7" : "w-full max-w-sm space-y-7"}>
          <Link href="/" className="inline-flex lg:hidden">
            <Logo />
          </Link>

          <div>
            {eyebrow && <p className="text-xs uppercase tracking-[0.22em] text-muted-foreground">{eyebrow}</p>}
            <h2 className="mt-1 font-display text-3xl font-semibold tracking-tight">{title}</h2>
          </div>

          {children}
        </div>
      </section>
    </div>
  );
}
