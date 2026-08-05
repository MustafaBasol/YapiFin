"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowRight, Loader2 } from "lucide-react";
import appConfig from "@/app.config";
import { useLang } from "@/components/i18n/language-provider";
import { Logo } from "@/components/ui/logo";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import { LanguageToggle } from "@/components/ui/language-toggle";

/**
 * Login / signup with a DEMO BYPASS. Supabase isn't connected in this kit, so
 * submitting (or "Continue with demo") just drops you into the live demo
 * dashboard. Wire Supabase via /setup to make these forms do real auth.
 */
export function AuthScreen({ mode }: { mode: "login" | "signup" }) {
  const { ui, t, lang } = useLang();
  const router = useRouter();
  const [loading, setLoading] = useState(false);

  function enter(e?: React.FormEvent) {
    e?.preventDefault();
    setLoading(true);
    setTimeout(() => router.push("/dashboard"), 450);
  }

  const isLogin = mode === "login";
  const stats = appConfig.marketing.stats.slice(0, 3);

  return (
    <div className="grid min-h-dvh lg:grid-cols-[1.05fr_1fr]">
      {/* Left — brand panel */}
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
          <p className="text-xs uppercase tracking-[0.22em] text-white/70">
            {t(appConfig.marketing.badge)}
          </p>
          <h1 className="mt-3 font-display text-4xl font-semibold leading-tight">
            {t(appConfig.tagline)}
          </h1>
          <p className="mt-5 text-[15px] leading-relaxed text-white/85">{ui.authBlurb}</p>

          <div className="mt-8 grid grid-cols-3 gap-3">
            {stats.map((s) => (
              <div key={s.value} className="rounded-2xl bg-white/10 p-3 backdrop-blur-sm">
                <p className="font-display text-2xl font-semibold tabular-nums">{s.value}</p>
                <p className="mt-0.5 text-[11px] text-white/75">{t(s.label)}</p>
              </div>
            ))}
          </div>
        </div>

        <p className="relative text-xs text-white/65">
          © {appConfig.name} · {appConfig.domain}
        </p>
      </section>

      {/* Right — form */}
      <section className="relative flex flex-col items-center justify-center px-6 py-12">
        <div className="absolute right-5 top-5">
          <LanguageToggle />
        </div>

        <div className="w-full max-w-sm space-y-7">
          <Link href="/" className="inline-flex lg:hidden">
            <Logo />
          </Link>

          <div>
            <p className="text-xs uppercase tracking-[0.22em] text-muted-foreground">
              {appConfig.name}
            </p>
            <h2 className="mt-1 font-display text-3xl font-semibold tracking-tight">
              {isLogin ? ui.welcomeBack : ui.createAccount}
            </h2>
          </div>

          {/* Social (decorative in demo) */}
          <div className="grid grid-cols-2 gap-3">
            <Button variant="outline" onClick={enter} className="gap-2">
              <GoogleGlyph /> Google
            </Button>
            <Button variant="outline" onClick={enter} className="gap-2">
              <GithubGlyph /> GitHub
            </Button>
          </div>

          <div className="flex items-center gap-3 text-xs text-muted-foreground">
            <span className="h-px flex-1 bg-border" />
            {ui.orContinueWith} {ui.email.toLowerCase()}
            <span className="h-px flex-1 bg-border" />
          </div>

          <form onSubmit={enter} className="space-y-4">
            {!isLogin && (
              <div className="space-y-1.5">
                <Label htmlFor="name">{ui.fullName}</Label>
                <Input id="name" name="name" placeholder={lang === "tr" ? "Adın Soyadın" : "Jane Doe"} />
              </div>
            )}
            <div className="space-y-1.5">
              <Label htmlFor="email">{ui.email}</Label>
              <Input id="email" name="email" type="email" placeholder="you@company.com" defaultValue="demo@demo.app" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="password">{ui.password}</Label>
              <Input id="password" name="password" type="password" placeholder="••••••••" defaultValue="demodemo" />
            </div>
            <Button type="submit" disabled={loading} className="w-full gap-2">
              {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              {isLogin ? ui.signIn : ui.getStarted}
              {!loading && <ArrowRight className="h-4 w-4" />}
            </Button>
          </form>

          <button
            onClick={enter}
            className="w-full rounded-lg border border-dashed border-border py-2.5 text-sm font-medium text-muted-foreground transition-colors hover:border-primary hover:text-primary cursor-pointer"
          >
            {ui.continueDemo} →
          </button>

          <p className="rounded-lg bg-muted px-3 py-2 text-center text-xs text-muted-foreground">
            {ui.demoNote}
          </p>

          <p className="text-center text-sm text-muted-foreground">
            {isLogin ? ui.noAccount : ui.haveAccount}{" "}
            <Link
              href={isLogin ? "/signup" : "/login"}
              className="font-medium text-primary hover:underline underline-offset-4"
            >
              {isLogin ? ui.getStarted : ui.signIn}
            </Link>
          </p>
        </div>
      </section>
    </div>
  );
}

function GithubGlyph() {
  return (
    <svg className="h-4 w-4" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M12 2C6.48 2 2 6.48 2 12c0 4.42 2.87 8.17 6.84 9.5.5.09.66-.22.66-.48v-1.7c-2.78.6-3.37-1.34-3.37-1.34-.45-1.16-1.11-1.47-1.11-1.47-.91-.62.07-.6.07-.6 1 .07 1.53 1.03 1.53 1.03.89 1.53 2.34 1.09 2.91.83.09-.65.35-1.09.63-1.34-2.22-.25-4.55-1.11-4.55-4.94 0-1.09.39-1.98 1.03-2.68-.1-.25-.45-1.27.1-2.65 0 0 .84-.27 2.75 1.02a9.6 9.6 0 0 1 5 0c1.91-1.29 2.75-1.02 2.75-1.02.55 1.38.2 2.4.1 2.65.64.7 1.03 1.59 1.03 2.68 0 3.84-2.34 4.69-4.57 4.94.36.31.68.92.68 1.85v2.74c0 .27.16.58.67.48A10 10 0 0 0 22 12c0-5.52-4.48-10-10-10Z" />
    </svg>
  );
}

function GoogleGlyph() {
  return (
    <svg className="h-4 w-4" viewBox="0 0 24 24" aria-hidden>
      <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.27-4.74 3.27-8.1Z" />
      <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.65l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84A11 11 0 0 0 12 23Z" />
      <path fill="#FBBC05" d="M5.84 14.11a6.6 6.6 0 0 1 0-4.22V7.05H2.18a11 11 0 0 0 0 9.9l3.66-2.84Z" />
      <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1A11 11 0 0 0 2.18 7.05l3.66 2.84C6.71 7.31 9.14 5.38 12 5.38Z" />
    </svg>
  );
}
