import Link from "next/link";
import { ArrowRight, Check } from "lucide-react";
import appConfig from "@/app.config";
import { Icon } from "@/components/ui/icon";

const HERO_BENEFITS = [
  "Proje bazlı gelir, gider, tahsilat ve ödeme tek panelde",
  "Kasa ve banka hesapları, aralarındaki transferlerle birlikte tek yerde",
  "Roller ve organizasyon bazlı erişim kontrolü baştan kurulu",
];

export default function LandingPage() {
  const m = appConfig.marketing;

  return (
    <>
      <section className="relative overflow-hidden">
        <div className="pointer-events-none absolute inset-0 -z-10" style={{ background: "var(--grad-hero)" }} aria-hidden />
        <div className="mx-auto max-w-3xl px-5 py-20 text-center sm:py-28">
          <span className="inline-flex items-center gap-1.5 rounded-full border border-border bg-card px-3 py-1 text-xs font-medium text-muted-foreground shadow-pill">
            <span className="h-1.5 w-1.5 rounded-full bg-primary" />
            {m.badge}
          </span>
          <h1 className="mt-5 font-display text-[40px] font-extrabold leading-[1.05] tracking-[-0.03em] sm:text-[52px]">
            {m.heroTitle} <span className="text-primary">{m.heroAccent}</span>
          </h1>
          <p className="mx-auto mt-5 max-w-xl text-[17px] leading-relaxed text-muted-foreground">{m.heroSubtitle}</p>

          <ul className="mx-auto mt-6 max-w-md space-y-2.5 text-left">
            {HERO_BENEFITS.map((b) => (
              <li key={b} className="flex items-start gap-2.5 text-[15px]">
                <span className="mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full bg-success/12 text-success">
                  <Check className="h-3 w-3" strokeWidth={3} />
                </span>
                {b}
              </li>
            ))}
          </ul>

          <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
            <Link
              href="/signup"
              className="inline-flex h-12 items-center justify-center gap-2 rounded-xl bg-primary px-6 text-[15px] font-semibold text-primary-foreground shadow-sm transition-opacity hover:opacity-90"
            >
              {m.heroCtaPrimary} <ArrowRight className="h-4 w-4" />
            </Link>
            <Link
              href="/login"
              className="inline-flex h-12 items-center justify-center gap-2 rounded-xl border border-border bg-card px-6 text-[15px] font-semibold text-foreground shadow-pill transition-colors hover:bg-muted"
            >
              {m.heroCtaSecondary}
            </Link>
          </div>
        </div>
      </section>

      <section id="features" className="border-t border-border bg-muted/30">
        <div className="mx-auto max-w-6xl px-5 py-20">
          <div className="mx-auto max-w-2xl text-center">
            <h2 className="font-display text-3xl font-bold tracking-tight sm:text-4xl">
              Bir inşaat firmasının finansını yönetmek için gereken temel araçlar
            </h2>
          </div>
          <div className="mt-12 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
            {m.features.map((f) => (
              <div key={f.title} className="rounded-2xl border border-border bg-card p-6 shadow-soft">
                <span className="grid h-11 w-11 place-items-center rounded-xl bg-primary/10 text-primary">
                  <Icon name={f.icon} className="h-5 w-5" />
                </span>
                <h3 className="mt-4 font-semibold tracking-tight">{f.title}</h3>
                <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">{f.body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="mx-auto max-w-3xl px-5 py-24 text-center">
        <h2 className="font-display text-3xl font-extrabold tracking-tight sm:text-4xl">
          Firmanı YapıFin&apos;e kaydet
        </h2>
        <p className="mx-auto mt-3 max-w-xl text-muted-foreground">
          Firma sahibi olarak kayıt ol, organizasyonunu oluştur, ekibini davet et.
        </p>
        <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
          <Link
            href="/signup"
            className="inline-flex h-12 items-center justify-center gap-2 rounded-xl bg-primary px-7 text-[15px] font-semibold text-primary-foreground shadow-sm transition-opacity hover:opacity-90"
          >
            {m.heroCtaPrimary} <ArrowRight className="h-4 w-4" />
          </Link>
        </div>
      </section>
    </>
  );
}
