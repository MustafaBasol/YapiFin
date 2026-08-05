"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import {
  ArrowRight,
  Check,
  Minus,
  Plus,
  Quote,
  Star,
  HardHat,
  ReceiptText,
  Calculator,
  ShieldCheck,
  Clock,
  Hammer,
} from "lucide-react";
import appConfig from "@/app.config";
import { Icon } from "@/components/ui/icon";
import { useLang } from "@/components/i18n/language-provider";
import { cn, formatMoney } from "@/lib/utils";
import { demoProject, TRADE_META, type Trade } from "@/lib/demo/data";
import type { L } from "@/lib/i18n/config";

/* ─────────────────────────────────────────────────────────────────────────────
   BUILDR — the marketing landing. A clean, LIGHT, multi-act page in the
   construction amber palette. Everything is bilingual ({ tr, en }) and resolved
   through the active language with tt(). All visuals are inline SVG — no photos,
   no external icon images. Restrained motion (fade/rise on load, soft pulse).

   Sections, in order:
     · Hero — headline + 3 green-check benefits + 2 CTAs + floating product preview
     · Trusted-by — inline-SVG company marks
     · Stats band
     · Interactive demo — mark a milestone complete → % complete + billing updates
     · Features grid (six)
     · How it works — estimate → schedule → build → bill
     · Progress-billing deep-dive (hakediş)
     · Comparison table — spreadsheets+WhatsApp / generic PM / Buildr
     · Testimonials (six, SVG-initial avatars + metrics)
     · Pricing (three tiers)
     · FAQ (eight)
     · Final CTA
   ───────────────────────────────────────────────────────────────────────────── */

/* Three hero benefits, each a green-check line. */
const HERO_BENEFITS: L[] = [
  {
    tr: "Keşif, program, bütçe ve hakediş tek panelde",
    en: "Estimates, schedule, budget and billing in one panel",
  },
  {
    tr: "Bütçe vs gerçek harcama her kalemde canlı — aşımı kırmızıda yakala",
    en: "Budget vs actual live on every line — catch overruns in the red",
  },
  {
    tr: "Tamamlanma yüzdesine göre hakediş kes, teminatı otomatik hesapla",
    en: "Bill by percent complete, auto-calculate retainage",
  },
];

/* Companies for the trusted-by strip. Each gets a bespoke inline-SVG mark. */
const TRUSTED: { name: string; glyph: CompanyGlyph }[] = [
  { name: "Northwind", glyph: "crane" },
  { name: "Formwork", glyph: "frame" },
  { name: "Cedarworks", glyph: "tree" },
  { name: "Meridian", glyph: "level" },
  { name: "Granite", glyph: "block" },
  { name: "Ironhold", glyph: "beam" },
  { name: "Summit", glyph: "peak" },
  { name: "Beacon", glyph: "bolt" },
];

/* How-it-works: estimate → schedule → build → bill. */
const HOW_STEPS: { n: string; icon: string; title: L; body: L }[] = [
  {
    n: "01",
    icon: "calculator",
    title: { tr: "Keşfi hazırla", en: "Estimate" },
    body: {
      tr: "Kalemli bir keşif çıkar, taşeron tekliflerini topla ve kazananı tek tıkla sözleşmeye çevir.",
      en: "Build a line-item estimate, collect subcontractor bids, and turn the winner into a contract in one click.",
    },
  },
  {
    n: "02",
    icon: "calendar-range",
    title: { tr: "Programla", en: "Schedule" },
    body: {
      tr: "Fazları zaman çizelgesine diz, bağımlılıkları gör ve ekipleri işe ata — gecikmeyi herkesten önce yakala.",
      en: "Lay phases on a timeline, see dependencies, and assign crews — catch slippage before anyone else.",
    },
  },
  {
    n: "03",
    icon: "hard-hat",
    title: { tr: "İnşa et", en: "Build" },
    body: {
      tr: "Sahadan günlük kayıt tut, görevleri kapat, RFI ve değişiklikleri takip et — her şey tek akışta.",
      en: "Keep daily logs from the field, close tasks, track RFIs and change orders — all in one feed.",
    },
  },
  {
    n: "04",
    icon: "receipt-text",
    title: { tr: "Hakediş kes", en: "Bill" },
    body: {
      tr: "Tamamlanma yüzdesine göre hakediş hazırla, teminatı düş ve müşteriye gönder — defterler denk kalsın.",
      en: "Draft a progress invoice by percent complete, deduct retainage, and send it — books stay balanced.",
    },
  },
];

/* Comparison rows: spreadsheets + WhatsApp / generic PM / Buildr. */
type CompareValue = boolean | L | string;
const COMPARE: { feature: L; manual: CompareValue; generic: CompareValue; buildr: CompareValue }[] = [
  { feature: { tr: "Kalemli keşif & teklif", en: "Line-item estimates & bids" }, manual: { tr: "Manuel", en: "Manual" }, generic: true, buildr: true },
  { feature: { tr: "Faz programı (Gantt)", en: "Phase schedule (Gantt)" }, manual: false, generic: true, buildr: true },
  { feature: { tr: "Bütçe vs gerçek (kalem bazlı)", en: "Budget vs actual (per line)" }, manual: { tr: "Kopyala-yapıştır", en: "Copy-paste" }, generic: { tr: "Kısmi", en: "Partial" }, buildr: true },
  { feature: { tr: "Hakediş & teminat (retainage)", en: "Progress billing & retainage" }, manual: false, generic: false, buildr: true },
  { feature: { tr: "Taşeron & sözleşme takibi", en: "Subcontractor & contract tracking" }, manual: { tr: "WhatsApp", en: "WhatsApp" }, generic: { tr: "Kısmi", en: "Partial" }, buildr: true },
  { feature: { tr: "Şantiye günlüğü (sahadan)", en: "Daily logs (from the field)" }, manual: false, generic: { tr: "Eklenti", en: "Add-on" }, buildr: true },
  { feature: { tr: "İnşaata özel kurulum", en: "Built for construction" }, manual: false, generic: false, buildr: true },
  { feature: { tr: "Kurulum süresi", en: "Time to set up" }, manual: { tr: "—", en: "—" }, generic: { tr: "Haftalar", en: "Weeks" }, buildr: { tr: "5 dakika", en: "5 minutes" } },
];

/* Six testimonials with SVG-initial avatars + a hard metric chip. */
const TESTIMONIALS: { quote: L; name: string; role: L; initials: string; metric: L }[] = [
  {
    quote: { tr: "Tabloları ve WhatsApp gruplarını bıraktık. Beş projeyi tek panelden yönetiyorum, hiçbir hakediş gözden kaçmıyor.", en: "We dropped the spreadsheets and WhatsApp groups. I run five jobs from one panel and no progress payment slips through." },
    name: "Marcus Vella",
    role: { tr: "Müteahhit · Northwind", en: "GC · Northwind" },
    initials: "MV",
    metric: { tr: "5 proje · 1 panel", en: "5 jobs · 1 panel" },
  },
  {
    quote: { tr: "Bütçe sapmamız yıl sonunda %0.9'a indi. Aşımları kalem kırmızıya döner dönmez yakalıyoruz.", en: "Our budget variance dropped to 0.9% by year-end. We catch overruns the moment a line turns red." },
    name: "Priya Nair",
    role: { tr: "Maliyet Müdürü · Formwork", en: "Cost Manager · Formwork" },
    initials: "PN",
    metric: { tr: "%0.9 sapma", en: "0.9% variance" },
  },
  {
    quote: { tr: "Hakediş hazırlamak günler sürerdi. Şimdi tamamlanma yüzdesini işaretliyorum, teminat düşülmüş fatura hazır.", en: "Drafting a progress invoice used to take days. Now I mark percent complete and the retainage-deducted invoice is ready." },
    name: "David Okafor",
    role: { tr: "Proje Yöneticisi · Meridian", en: "PM · Meridian" },
    initials: "DO",
    metric: { tr: "Günler → dakikalar", en: "Days → minutes" },
  },
  {
    quote: { tr: "Taşeronların sözleşme ve sigorta tarihleri tek yerde. Süresi dolanı işe almıyoruz, sürpriz yok.", en: "Subcontractor contracts and insurance dates live in one place. We never schedule a lapsed crew now." },
    name: "Elena Rossi",
    role: { tr: "Operasyon · Cedarworks", en: "Ops · Cedarworks" },
    initials: "ER",
    metric: { tr: "0 sigorta sürprizi", en: "0 lapse surprises" },
  },
  {
    quote: { tr: "Ekip sahadan telefonla günlük kaydı giriyor. Akşam ofiste her şantiyenin resmi elimde.", en: "Crews file the daily log from their phones. By evening I have the picture of every site at the office." },
    name: "Tomás Herrera",
    role: { tr: "Şantiye Şefi · Granite", en: "Site Lead · Granite" },
    initials: "TH",
    metric: { tr: "Sahadan canlı", en: "Live from site" },
  },
  {
    quote: { tr: "Demo modda açtık, beğendik, anahtarları bağladık. Kurulum bir öğleden sonra sürmedi.", en: "We opened the keyless demo, liked it, and wired our keys. Setup took less than an afternoon." },
    name: "Hannah Brooks",
    role: { tr: "Kurucu · Ironhold", en: "Founder · Ironhold" },
    initials: "HB",
    metric: { tr: "1 öğleden sonra", en: "1 afternoon" },
  },
];

/* The three security/trust assurances under the deep-dive. */
const ASSURANCES: { icon: typeof ShieldCheck; title: L; body: L }[] = [
  { icon: ShieldCheck, title: { tr: "Denetim kaydı", en: "Audit trail" }, body: { tr: "Her hakediş, değişiklik ve onay zaman damgalı kayıt altında — anlaşmazlıkta kim ne zaman ne yaptı belli.", en: "Every invoice, change order and approval is timestamped — in a dispute, who did what and when is clear." } },
  { icon: ReceiptText, title: { tr: "Muhasebeye akar", en: "Flows to your books" }, body: { tr: "Hakedişleri ve maliyet kodlarını QuickBooks'a gönder ya da CSV indir — çift kayıt yok.", en: "Push invoices and cost codes to QuickBooks or export CSV — no double entry." } },
  { icon: Clock, title: { tr: "Gerçek-zamanlı", en: "Real-time" }, body: { tr: "Saha bir görevi kapadığında program, bütçe ve hakediş aynı anda güncellenir.", en: "When the field closes a task, the schedule, budget and billing update at once." } },
];

export default function LandingPage() {
  const { t, lang } = useLang();
  const m = appConfig.marketing;
  const tt = (v: L) => v[lang];

  /* Section copy that doesn't belong in app.config.ts. */
  const c = {
    trustedBy: { tr: "Sahadaki yüklenicilerin güvendiği panel", en: "Trusted by builders on site" } as L,
    demoEyebrow: { tr: "Canlı demo", en: "Live demo" } as L,
    demoTitle: { tr: "Bir kilometre taşını tamamla, hakediş kendini yazsın", en: "Complete a milestone, watch the invoice write itself" } as L,
    demoSub: { tr: "Sahada bir faz biter; tamamlanma yüzdesi, faturalanabilir tutar ve teminat anında güncellenir. Bir kilometre taşını işaretle, dene.", en: "A phase finishes on site; percent complete, billable amount and retainage update instantly. Toggle a milestone and see." } as L,
    featuresTitle: { tr: "Bir inşaatı yönetmek için gereken her şey", en: "Everything it takes to run a build" } as L,
    featuresSub: { tr: "Keşiften programa, sahadan hakedişe — tek panel, sıfır tablo.", en: "From estimate to schedule, from site to billing — one panel, zero spreadsheets." } as L,
    howTitle: { tr: "Dört adımda bir proje", en: "A project in four steps" } as L,
    howSub: { tr: "Keşfi hazırla, programla, inşa et, hakediş kes. Buildr aradaki her şeyi bağlar.", en: "Estimate, schedule, build, bill. Buildr connects everything in between." } as L,
    billingEyebrow: { tr: "Hakediş", en: "Progress billing" } as L,
    billingTitle: { tr: "Hakediş, tahminle değil yüzdeyle", en: "Bill by percent, not by guesswork" } as L,
    billingSub: { tr: "Her kilometre taşını tamamlanma yüzdesine göre faturalandır. Buildr teminatı düşer, kalan bakiyeyi hesaplar ve müşteriye gidecek özeti hazırlar.", en: "Bill each milestone by percent complete. Buildr deducts retainage, computes the remaining balance, and prepares the client-ready summary." } as L,
    compareTitle: { tr: "Neden Buildr?", en: "Why Buildr?" } as L,
    compareSub: { tr: "Tablolar + WhatsApp ve genel proje araçlarıyla karşılaştır.", en: "Compared to spreadsheets + WhatsApp and generic PM tools." } as L,
    testimonialsTitle: { tr: "Yükleniciler Buildr'ı seviyor", en: "Builders love Buildr" } as L,
    testimonialsSub: { tr: "Konuttan endüstriyele, sahadaki ekiplerden.", en: "From residential to industrial, from teams on site." } as L,
    pricingTitle: { tr: "Basit, projeye göre fiyatlandırma", en: "Simple, per-project pricing" } as L,
    pricingSub: { tr: "Ücretsiz başla. Büyüdükçe yükselt.", en: "Start free. Upgrade as you grow." } as L,
    popular: { tr: "En popüler", en: "Most popular" } as L,
    faqTitle: { tr: "Sıkça sorulanlar", en: "Frequently asked" } as L,
    faqSub: { tr: "Cevabını bulamadın mı? Ekibimize yaz.", en: "Can't find an answer? Reach our team." } as L,
    ctaTitle: { tr: "Bir sonraki projeyi kontrol altında başlat", en: "Start your next build in control" } as L,
    ctaSub: { tr: "Anahtarsız demo modda aç, hazır olunca Supabase, depolama ve muhasebeyi bağla.", en: "Open the keyless demo, then wire Supabase, storage and accounting when you're ready." } as L,
  };

  return (
    <>
      {/* ── HERO ──────────────────────────────────────────────────── */}
      <section className="relative overflow-hidden">
        <div className="pointer-events-none absolute inset-0 -z-10" style={{ background: "var(--grad-hero)" }} aria-hidden />
        <div className="mx-auto grid max-w-6xl items-center gap-12 px-5 py-16 sm:py-24 lg:grid-cols-[1.05fr_0.95fr]">
          {/* Left copy */}
          <div className="stagger">
            <span className="inline-flex items-center gap-1.5 rounded-full border border-border bg-card px-3 py-1 text-xs font-medium text-muted-foreground shadow-pill">
              <span className="h-1.5 w-1.5 rounded-full bg-primary pulse-dot" />
              {t(m.badge)}
            </span>
            <h1 className="mt-5 max-w-xl font-display text-[40px] font-extrabold leading-[1.03] tracking-[-0.03em] sm:text-[56px]">
              {t(m.heroTitle)}{" "}
              <span className="bg-gradient-to-br from-[oklch(72%_0.16_68)] to-[oklch(60%_0.19_42)] bg-clip-text text-transparent">
                {t(m.heroAccent)}
              </span>
            </h1>
            <p className="mt-5 max-w-lg text-[17px] leading-relaxed text-muted-foreground">{t(m.heroSubtitle)}</p>

            <ul className="mt-6 space-y-2.5">
              {HERO_BENEFITS.map((b) => (
                <li key={tt(b)} className="flex items-start gap-2.5 text-[15px]">
                  <span className="mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full bg-success/12 text-success">
                    <Check className="h-3 w-3" strokeWidth={3} />
                  </span>
                  {tt(b)}
                </li>
              ))}
            </ul>

            <div className="mt-8 flex flex-col gap-3 sm:flex-row">
              <Link
                href="/signup"
                className="inline-flex h-12 items-center justify-center gap-2 rounded-xl bg-primary px-6 text-[15px] font-semibold text-primary-foreground shadow-sm transition-opacity hover:opacity-90"
              >
                {t(m.heroCtaPrimary)} <ArrowRight className="h-4 w-4" />
              </Link>
              <Link
                href="/login"
                className="inline-flex h-12 items-center justify-center gap-2 rounded-xl border border-border bg-card px-6 text-[15px] font-semibold text-foreground shadow-pill transition-colors hover:bg-muted"
              >
                {t(m.heroCtaSecondary)}
              </Link>
            </div>

            <p className="mt-4 text-xs text-muted-foreground">
              {lang === "tr" ? "Kredi kartı gerekmez · Anahtarsız demo · 5 dakikada kurulum" : "No credit card · Keyless demo · 5-minute setup"}
            </p>
          </div>

          {/* Right floating product preview — the projects dashboard. */}
          <div className="relative animate-float-up lg:pl-4">
            <div className="absolute -left-6 -top-6 -z-10 h-40 w-40 rounded-full bg-primary/10 blur-3xl drift" aria-hidden />
            <div className="absolute -bottom-8 -right-4 -z-10 h-44 w-44 rounded-full bg-[oklch(70%_0.16_95)]/10 blur-3xl" aria-hidden />
            <ProjectsPreview lang={lang} />
          </div>
        </div>

        {/* Trusted-by row */}
        <div className="border-y border-border bg-card/50">
          <div className="mx-auto max-w-6xl px-5 py-6">
            <p className="text-center text-[11px] font-medium uppercase tracking-[0.18em] text-muted-foreground">
              {tt(c.trustedBy)}
            </p>
            <div className="mt-5 flex flex-wrap items-center justify-center gap-x-8 gap-y-4 sm:gap-x-12">
              {TRUSTED.map((co) => (
                <CompanyMark key={co.name} name={co.name} glyph={co.glyph} />
              ))}
            </div>
          </div>
        </div>
      </section>

      {/* ── STATS BAND ────────────────────────────────────────────── */}
      <section className="mx-auto max-w-6xl px-5 py-16">
        <div className="grid grid-cols-2 gap-px overflow-hidden rounded-2xl border border-border bg-border shadow-soft sm:grid-cols-4">
          {m.stats.map((s) => (
            <div key={s.value} className="bg-card px-5 py-8 text-center">
              <p className="font-display text-3xl font-extrabold tracking-tight">{s.value}</p>
              <p className="mt-1.5 text-xs text-muted-foreground">{t(s.label)}</p>
            </div>
          ))}
        </div>
      </section>

      {/* ── INTERACTIVE DEMO ──────────────────────────────────────── */}
      <section className="mx-auto max-w-6xl px-5 py-20">
        <div className="grid items-start gap-12 lg:grid-cols-[1fr_1.05fr]">
          <div>
            <p className="label-mono text-primary">{tt(c.demoEyebrow)}</p>
            <h2 className="mt-2 max-w-md font-display text-3xl font-bold tracking-tight sm:text-4xl">{tt(c.demoTitle)}</h2>
            <p className="mt-3 max-w-md text-muted-foreground">{tt(c.demoSub)}</p>

            <ul className="mt-6 space-y-2.5">
              {[
                { tr: "Tamamlanma yüzdesini saha günceller", en: "Percent complete updates from the field" },
                { tr: "Faturalanabilir tutar anında hesaplanır", en: "Billable amount recalculates instantly" },
                { tr: "Teminat (retainage) otomatik düşülür", en: "Retainage is deducted automatically" },
              ].map((p) => (
                <li key={p.en} className="flex items-start gap-2.5 text-[15px]">
                  <span className="mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full bg-primary/10 text-primary">
                    <Check className="h-3 w-3" strokeWidth={3} />
                  </span>
                  {lang === "tr" ? p.tr : p.en}
                </li>
              ))}
            </ul>
          </div>

          <BillingDemo lang={lang} />
        </div>
      </section>

      {/* ── FEATURES ──────────────────────────────────────────────── */}
      <section id="features" className="border-t border-border bg-muted/30">
        <div className="mx-auto max-w-6xl px-5 py-20">
          <div className="mx-auto max-w-2xl text-center">
            <h2 className="font-display text-3xl font-bold tracking-tight sm:text-4xl">{tt(c.featuresTitle)}</h2>
            <p className="mt-3 text-muted-foreground">{tt(c.featuresSub)}</p>
          </div>
          <div className="mt-12 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
            {m.features.map((f) => (
              <div key={tt(f.title)} className="group rounded-2xl border border-border bg-card p-6 shadow-soft transition-shadow hover:shadow-pop">
                <span className="grid h-11 w-11 place-items-center rounded-xl bg-primary/10 text-primary transition-colors group-hover:bg-primary group-hover:text-primary-foreground">
                  <Icon name={f.icon} className="h-5 w-5" />
                </span>
                <h3 className="mt-4 font-semibold tracking-tight">{t(f.title)}</h3>
                <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">{t(f.body)}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── HOW IT WORKS ──────────────────────────────────────────── */}
      <section id="how" className="mx-auto max-w-6xl px-5 py-20">
        <div className="mx-auto max-w-2xl text-center">
          <h2 className="font-display text-3xl font-bold tracking-tight sm:text-4xl">{tt(c.howTitle)}</h2>
          <p className="mt-3 text-muted-foreground">{tt(c.howSub)}</p>
        </div>
        <div className="relative mt-12 grid gap-5 md:grid-cols-2 lg:grid-cols-4">
          {HOW_STEPS.map((s, i) => (
            <div key={s.n} className="relative rounded-2xl border border-border bg-card p-6 shadow-soft">
              <div className="flex items-center justify-between">
                <span className="grid h-11 w-11 place-items-center rounded-xl bg-primary/10 text-primary">
                  <Icon name={s.icon} className="h-5 w-5" />
                </span>
                <span className="font-display text-3xl font-extrabold text-primary/15">{s.n}</span>
              </div>
              <h3 className="mt-4 font-semibold tracking-tight">{tt(s.title)}</h3>
              <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">{tt(s.body)}</p>
              {i < HOW_STEPS.length - 1 && (
                <span className="absolute -right-3 top-1/2 z-10 hidden h-6 w-6 -translate-y-1/2 place-items-center rounded-full border border-border bg-card text-muted-foreground lg:grid">
                  <ArrowRight className="h-3 w-3" />
                </span>
              )}
            </div>
          ))}
        </div>
      </section>

      {/* ── PROGRESS-BILLING DEEP-DIVE ────────────────────────────── */}
      <section className="border-y border-border bg-muted/30">
        <div className="mx-auto max-w-6xl px-5 py-20">
          <div className="grid items-center gap-12 lg:grid-cols-[1fr_1.1fr]">
            <div>
              <p className="label-mono text-primary">{tt(c.billingEyebrow)}</p>
              <h2 className="mt-2 max-w-md font-display text-3xl font-bold tracking-tight sm:text-4xl">{tt(c.billingTitle)}</h2>
              <p className="mt-3 max-w-md text-muted-foreground">{tt(c.billingSub)}</p>
              <ul className="mt-6 space-y-2.5">
                {[
                  { tr: "Kilometre taşı başına tamamlanma yüzdesi", en: "Percent complete per milestone" },
                  { tr: "Otomatik teminat (retainage) düşümü", en: "Automatic retainage deduction" },
                  { tr: "AIA tarzı hakediş özeti & PDF", en: "AIA-style billing summary & PDF" },
                  { tr: "QuickBooks / CSV dışa aktarım", en: "QuickBooks / CSV export" },
                ].map((p) => (
                  <li key={p.en} className="flex items-start gap-2.5 text-[15px]">
                    <span className="mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full bg-primary/10 text-primary">
                      <Check className="h-3 w-3" strokeWidth={3} />
                    </span>
                    {lang === "tr" ? p.tr : p.en}
                  </li>
                ))}
              </ul>
            </div>

            {/* A static "schedule of values" panel illustrating the hakediş math. */}
            <BillingDeepDivePanel lang={lang} />
          </div>

          {/* Three assurances under the deep-dive. */}
          <div className="mt-14 grid gap-5 sm:grid-cols-3">
            {ASSURANCES.map((a) => {
              const I = a.icon;
              return (
                <div key={tt(a.title)} className="rounded-2xl border border-border bg-card p-6 shadow-soft">
                  <span className="grid h-11 w-11 place-items-center rounded-xl bg-primary/10 text-primary">
                    <I className="h-5 w-5" />
                  </span>
                  <h3 className="mt-4 font-semibold tracking-tight">{tt(a.title)}</h3>
                  <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">{tt(a.body)}</p>
                </div>
              );
            })}
          </div>
        </div>
      </section>

      {/* ── COMPARISON TABLE ──────────────────────────────────────── */}
      <section className="mx-auto max-w-5xl px-5 py-20">
        <div className="mx-auto max-w-2xl text-center">
          <h2 className="font-display text-3xl font-bold tracking-tight sm:text-4xl">{tt(c.compareTitle)}</h2>
          <p className="mt-3 text-muted-foreground">{tt(c.compareSub)}</p>
        </div>
        <div className="mt-12 overflow-hidden rounded-2xl border border-border bg-card shadow-soft">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border">
                  <th className="px-5 py-4 text-left font-medium text-muted-foreground"></th>
                  <th className="px-5 py-4 text-center font-medium text-muted-foreground">
                    {lang === "tr" ? "Tablo + WhatsApp" : "Spreadsheets + WhatsApp"}
                  </th>
                  <th className="px-5 py-4 text-center font-medium text-muted-foreground">
                    {lang === "tr" ? "Genel PM aracı" : "Generic PM tool"}
                  </th>
                  <th className="bg-primary/[0.04] px-5 py-4 text-center">
                    <span className="inline-flex items-center gap-1.5 font-semibold text-primary">
                      <HardHat className="h-4 w-4" />
                      {appConfig.name}
                    </span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {COMPARE.map((row, i) => (
                  <tr key={tt(row.feature)} className={cn("border-b border-border/60 last:border-0", i % 2 === 1 && "bg-muted/20")}>
                    <td className="px-5 py-3.5 font-medium">{tt(row.feature)}</td>
                    <CompareCell value={row.manual} lang={lang} />
                    <CompareCell value={row.generic} lang={lang} />
                    <CompareCell value={row.buildr} lang={lang} highlight />
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </section>

      {/* ── TESTIMONIALS ──────────────────────────────────────────── */}
      <section className="border-y border-border bg-muted/30">
        <div className="mx-auto max-w-6xl px-5 py-20">
          <div className="mx-auto max-w-2xl text-center">
            <h2 className="font-display text-3xl font-bold tracking-tight sm:text-4xl">{tt(c.testimonialsTitle)}</h2>
            <p className="mt-3 text-muted-foreground">{tt(c.testimonialsSub)}</p>
          </div>
          <div className="mt-12 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
            {TESTIMONIALS.map((tm) => (
              <figure key={tm.name} className="flex flex-col rounded-2xl border border-border bg-card p-6 shadow-soft">
                <Quote className="h-5 w-5 text-primary/30" />
                <blockquote className="mt-3 flex-1 text-[14.5px] leading-relaxed text-foreground/90">
                  {tt(tm.quote)}
                </blockquote>
                <div className="mt-5 flex items-center gap-3 border-t border-border pt-4">
                  <span className="grid h-10 w-10 shrink-0 place-items-center rounded-full text-xs font-bold text-white" style={{ backgroundImage: "var(--grad-brand)" }}>
                    {tm.initials}
                  </span>
                  <div className="min-w-0 flex-1">
                    <figcaption className="text-sm font-semibold leading-tight">{tm.name}</figcaption>
                    <p className="truncate text-xs text-muted-foreground">{tt(tm.role)}</p>
                  </div>
                  <span className="shrink-0 rounded-full bg-success/10 px-2 py-1 text-[11px] font-semibold text-success">{tt(tm.metric)}</span>
                </div>
              </figure>
            ))}
          </div>
          <div className="mt-8 flex items-center justify-center gap-1.5 text-sm text-muted-foreground">
            {Array.from({ length: 5 }).map((_, i) => (
              <Star key={i} className="h-4 w-4 fill-warning text-warning" />
            ))}
            <span className="ml-2">{lang === "tr" ? "4.9/5 · sahadaki ekiplerden" : "4.9/5 · from teams on site"}</span>
          </div>
        </div>
      </section>

      {/* ── PRICING ───────────────────────────────────────────────── */}
      <section id="pricing" className="mx-auto max-w-6xl px-5 py-20">
        <div className="mx-auto max-w-2xl text-center">
          <h2 className="font-display text-3xl font-bold tracking-tight sm:text-4xl">{tt(c.pricingTitle)}</h2>
          <p className="mt-3 text-muted-foreground">{tt(c.pricingSub)}</p>
        </div>
        <div className="mt-12 grid gap-5 lg:grid-cols-3">
          {m.pricing.map((tier) => (
            <div
              key={tier.name}
              className={cn(
                "flex flex-col rounded-2xl border bg-card p-7 shadow-soft",
                tier.featured ? "border-primary/40 shadow-pop ring-1 ring-primary/20" : "border-border",
              )}
            >
              {tier.featured && (
                <span className="mb-3 inline-flex w-fit items-center gap-1 rounded-full bg-primary px-2.5 py-0.5 text-[11px] font-semibold text-primary-foreground">
                  <Star className="h-3 w-3 fill-current" />
                  {tt(c.popular)}
                </span>
              )}
              <h3 className="font-semibold tracking-tight">{tier.name}</h3>
              <div className="mt-2 flex items-baseline gap-1">
                <span className="font-display text-4xl font-extrabold tracking-tight">{tier.price}</span>
                {tier.period && <span className="text-sm text-muted-foreground">{t(tier.period)}</span>}
              </div>
              <p className="mt-1.5 text-sm text-muted-foreground">{t(tier.tagline)}</p>
              <ul className="mt-6 flex-1 space-y-3 text-sm">
                {tier.features.map((f) => (
                  <li key={t(f)} className="flex items-start gap-2.5">
                    <span className="mt-0.5 grid h-4 w-4 shrink-0 place-items-center rounded-full bg-success/12 text-success">
                      <Check className="h-2.5 w-2.5" strokeWidth={3} />
                    </span>
                    {t(f)}
                  </li>
                ))}
              </ul>
              <Link
                href="/signup"
                className={cn(
                  "mt-7 inline-flex h-11 items-center justify-center rounded-xl text-sm font-semibold transition-all",
                  tier.featured
                    ? "bg-primary text-primary-foreground shadow-sm hover:opacity-90"
                    : "border border-border bg-card text-foreground hover:bg-muted",
                )}
              >
                {t(tier.cta)}
              </Link>
            </div>
          ))}
        </div>
      </section>

      {/* ── FAQ ───────────────────────────────────────────────────── */}
      <section id="faq" className="border-t border-border bg-muted/30">
        <div className="mx-auto max-w-3xl px-5 py-20">
          <div className="text-center">
            <h2 className="font-display text-3xl font-bold tracking-tight sm:text-4xl">{tt(c.faqTitle)}</h2>
            <p className="mt-3 text-muted-foreground">{tt(c.faqSub)}</p>
          </div>
          <div className="mt-10 space-y-3">
            {m.faq.map((f) => (
              <details key={t(f.q)} className="group rounded-xl border border-border bg-card px-5 py-4 shadow-soft">
                <summary className="flex cursor-pointer list-none items-center justify-between gap-4 font-medium">
                  {t(f.q)}
                  <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full border border-border text-muted-foreground transition-colors group-open:border-primary group-open:bg-primary group-open:text-primary-foreground">
                    <Plus className="h-3.5 w-3.5 group-open:hidden" />
                    <Minus className="hidden h-3.5 w-3.5 group-open:block" />
                  </span>
                </summary>
                <p className="mt-3 text-sm leading-relaxed text-muted-foreground">{t(f.a)}</p>
              </details>
            ))}
          </div>
        </div>
      </section>

      {/* ── FINAL CTA ─────────────────────────────────────────────── */}
      <section className="mx-auto max-w-6xl px-5 py-24">
        <div className="relative overflow-hidden rounded-3xl border border-border bg-card px-8 py-16 text-center shadow-pop">
          <div className="pointer-events-none absolute inset-0 -z-10" style={{ background: "var(--grad-hero)" }} aria-hidden />
          <span className="pointer-events-none absolute -left-10 top-0 -z-10 h-48 w-48 rounded-full bg-primary/10 blur-3xl drift" aria-hidden />
          <div className="mx-auto mb-5 flex w-fit items-center gap-2 rounded-full border border-border bg-card px-3 py-1 text-xs font-medium text-muted-foreground shadow-pill">
            <Hammer className="h-3.5 w-3.5 text-primary" />
            <span>{lang === "tr" ? "Demo modda hazır" : "Demo mode ready"}</span>
          </div>
          <h2 className="mx-auto max-w-2xl font-display text-3xl font-extrabold tracking-tight sm:text-4xl">{tt(c.ctaTitle)}</h2>
          <p className="mx-auto mt-3 max-w-xl text-muted-foreground">{tt(c.ctaSub)}</p>
          <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
            <Link
              href="/signup"
              className="inline-flex h-12 items-center justify-center gap-2 rounded-xl bg-primary px-7 text-[15px] font-semibold text-primary-foreground shadow-sm transition-opacity hover:opacity-90"
            >
              {t(m.heroCtaPrimary)} <ArrowRight className="h-4 w-4" />
            </Link>
            <Link
              href="/login"
              className="inline-flex h-12 items-center justify-center rounded-xl border border-border bg-card px-7 text-[15px] font-semibold text-foreground shadow-pill transition-colors hover:bg-muted"
            >
              {t(m.heroCtaSecondary)}
            </Link>
          </div>
        </div>
      </section>
    </>
  );
}

/* ─────────────────────────────────────────────────────────────────────────────
   ── Floating product preview: a miniature of the projects dashboard ──────────
   A white card showing a status header, a budget-vs-actual mini bar, three
   project rows with progress, and a small phase timeline. All inline SVG/markup.
   ───────────────────────────────────────────────────────────────────────────── */
function ProjectsPreview({ lang }: { lang: "tr" | "en" }) {
  const rows = [
    { name: "Maple Ridge", pct: 62, tone: "on", spent: 1_690_000, budget: 2_840_000 },
    { name: "Birchwood Home", pct: 78, tone: "on", spent: 1_205_000, budget: 1_640_000 },
    { name: "Harbor View", pct: 31, tone: "late", spent: 1_340_000, budget: 3_960_000 },
  ];
  const phases: { trade: Trade; start: number; span: number; pct: number }[] = [
    { trade: "concrete", start: 0, span: 2, pct: 100 },
    { trade: "frame", start: 2, span: 2, pct: 100 },
    { trade: "elec", start: 3, span: 3, pct: 70 },
    { trade: "hvac", start: 4, span: 3, pct: 45 },
    { trade: "finish", start: 6, span: 4, pct: 12 },
  ];
  const windowSpan = 10;

  return (
    <div className="overflow-hidden rounded-2xl border border-border bg-card shadow-pop">
      {/* window chrome */}
      <div className="flex items-center gap-2 border-b border-border px-4 py-3">
        <span className="grid h-6 w-6 place-items-center rounded-md text-white" style={{ backgroundImage: "var(--grad-brand)" }}>
          <HardHat className="h-3.5 w-3.5" />
        </span>
        <span className="font-display text-[13px] font-bold tracking-tight">
          {lang === "tr" ? "Şantiye paneli" : "Build cockpit"}
        </span>
        <span className="ml-auto inline-flex items-center gap-1 rounded-full bg-success/10 px-2 py-0.5 text-[10px] font-semibold text-success">
          <span className="h-1.5 w-1.5 rounded-full bg-success pulse-dot" />
          {lang === "tr" ? "Canlı" : "Live"}
        </span>
      </div>

      <div className="space-y-3.5 p-4">
        {/* two mini stat tiles */}
        <div className="grid grid-cols-2 gap-2.5">
          <div className="rounded-xl border border-border p-3">
            <p className="text-[10px] text-muted-foreground">{lang === "tr" ? "Aktif proje" : "Active jobs"}</p>
            <p className="tnum mt-1 text-lg font-bold leading-none">5</p>
          </div>
          <div className="rounded-xl border border-border p-3">
            <p className="text-[10px] text-muted-foreground">{lang === "tr" ? "Hakediş hazır" : "Billing due"}</p>
            <p className="tnum mt-1 text-lg font-bold leading-none text-success">$1.4M</p>
          </div>
        </div>

        {/* project rows */}
        <div className="overflow-hidden rounded-xl border border-border">
          {rows.map((r, i) => (
            <div key={r.name} className={cn("flex items-center gap-2.5 px-3 py-2.5", i > 0 && "border-t border-border/60")}>
              <span className="grid h-7 w-7 shrink-0 place-items-center rounded-md text-[9px] font-bold text-white" style={{ backgroundImage: "var(--grad-brand)" }}>
                {r.name.split(" ").slice(0, 2).map((w) => w[0]).join("")}
              </span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-[12px] font-semibold leading-tight">{r.name}</p>
                <div className="mt-1 flex items-center gap-1.5">
                  <div className="h-1 w-16 overflow-hidden rounded-full bg-muted">
                    <div className="h-full rounded-full bg-primary" style={{ width: `${r.pct}%` }} />
                  </div>
                  <span className="tnum text-[10px] font-semibold text-muted-foreground">{r.pct}%</span>
                </div>
              </div>
              <span
                className={cn(
                  "shrink-0 rounded-full px-1.5 py-0.5 text-[9px] font-semibold",
                  r.tone === "late" ? "bg-destructive/10 text-destructive" : "bg-success/10 text-success",
                )}
              >
                {r.tone === "late" ? (lang === "tr" ? "Gecikmiş" : "Delayed") : lang === "tr" ? "Yolunda" : "On track"}
              </span>
            </div>
          ))}
        </div>

        {/* mini phase timeline */}
        <div className="rounded-xl border border-border p-3">
          <p className="label-mono mb-2 text-muted-foreground">{lang === "tr" ? "Program" : "Schedule"}</p>
          <div className="space-y-1.5">
            {phases.map((ph, i) => (
              <div key={i} className="relative h-2.5 overflow-hidden rounded-full bg-muted">
                <div
                  className="absolute top-0 h-full rounded-full"
                  style={{
                    left: `${(ph.start / windowSpan) * 100}%`,
                    width: `${(ph.span / windowSpan) * 100}%`,
                    background: `color-mix(in oklch, ${TRADE_META[ph.trade].color} 30%, white)`,
                  }}
                />
                <div
                  className="absolute top-0 h-full rounded-full"
                  style={{
                    left: `${(ph.start / windowSpan) * 100}%`,
                    width: `${((ph.span * ph.pct) / 100 / windowSpan) * 100}%`,
                    background: TRADE_META[ph.trade].color,
                  }}
                />
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────────────────
   ── Interactive billing demo (useState) ──────────────────────────────────────
   Toggle a milestone "complete"; the percent complete, billable value and
   retainage recompute live. Seeds from lib/demo/data.ts demoProject.
   ───────────────────────────────────────────────────────────────────────────── */
function BillingDemo({ lang }: { lang: "tr" | "en" }) {
  const [done, setDone] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(demoProject.milestones.map((m) => [m.id, m.done])),
  );

  const totals = useMemo(() => {
    const billable = demoProject.milestones
      .filter((m) => done[m.id])
      .reduce((s, m) => s + m.value, 0);
    const pct = Math.round((billable / demoProject.total) * 100);
    const retainage = (billable * demoProject.retainage) / 100;
    const net = billable - retainage;
    return { billable, pct, retainage, net };
  }, [done]);

  return (
    <div className="overflow-hidden rounded-2xl border border-border bg-card shadow-pop">
      <div className="flex items-center gap-2 border-b border-border px-4 py-3">
        <ReceiptText className="h-4 w-4 text-primary" />
        <span className="font-display text-[13px] font-bold tracking-tight">{demoProject.name}</span>
        <span className="ml-auto tnum rounded-full bg-muted px-2 py-0.5 text-[10px] font-semibold text-muted-foreground">
          {formatMoney(demoProject.total)}
        </span>
      </div>

      <div className="p-4">
        {/* Overall progress bar */}
        <div className="mb-4 rounded-xl border border-border bg-muted/40 p-3">
          <div className="flex items-center justify-between text-[12px]">
            <span className="font-medium text-muted-foreground">{lang === "tr" ? "Tamamlanma" : "Percent complete"}</span>
            <span className="tnum text-base font-bold text-primary">{totals.pct}%</span>
          </div>
          <div className="mt-2 h-2.5 w-full overflow-hidden rounded-full bg-muted">
            <div className="h-full rounded-full bg-primary transition-all duration-500" style={{ width: `${totals.pct}%` }} />
          </div>
        </div>

        {/* Milestone toggles */}
        <p className="label-mono mb-2.5 text-muted-foreground">{lang === "tr" ? "Hakediş kalemleri" : "Schedule of values"}</p>
        <div className="space-y-2">
          {demoProject.milestones.map((mst) => {
            const isDone = done[mst.id];
            return (
              <button
                key={mst.id}
                type="button"
                onClick={() => setDone((d) => ({ ...d, [mst.id]: !d[mst.id] }))}
                className={cn(
                  "flex w-full items-center gap-3 rounded-xl border px-3 py-2.5 text-left transition-colors",
                  isDone ? "border-success/40 bg-success/[0.06]" : "border-border bg-card hover:bg-muted/50",
                )}
              >
                <span
                  className={cn(
                    "grid h-5 w-5 shrink-0 place-items-center rounded-md border transition-colors",
                    isDone ? "border-success bg-success text-success-foreground" : "border-border bg-card",
                  )}
                >
                  {isDone && <Check className="h-3.5 w-3.5" strokeWidth={3} />}
                </span>
                <span className={cn("flex-1 text-[13px] font-medium", isDone ? "text-foreground" : "text-muted-foreground")}>
                  {mst.label[lang]}
                </span>
                <span className="tnum shrink-0 text-[12px] font-semibold">{formatMoney(mst.value)}</span>
              </button>
            );
          })}
        </div>

        {/* Live billing summary */}
        <div className="mt-4 space-y-2 rounded-xl border border-border bg-muted/40 p-3.5">
          <Row label={lang === "tr" ? "Faturalanabilir tutar" : "Billable amount"} value={formatMoney(totals.billable)} />
          <Row
            label={`${lang === "tr" ? "Teminat" : "Retainage"} (${demoProject.retainage}%)`}
            value={`− ${formatMoney(totals.retainage)}`}
            muted
          />
          <div className="my-1 border-t border-border" />
          <Row label={lang === "tr" ? "Bu hakedişte ödenecek" : "Due this invoice"} value={formatMoney(totals.net)} strong />
        </div>

        <button className="mt-3.5 flex w-full items-center justify-center gap-1.5 rounded-xl bg-primary py-2.5 text-[13px] font-semibold text-primary-foreground transition-opacity hover:opacity-90">
          <ReceiptText className="h-4 w-4" />
          {lang === "tr" ? "Hakediş hazırla" : "Draft progress invoice"}
        </button>
      </div>
    </div>
  );
}

function Row({ label, value, muted, strong }: { label: string; value: string; muted?: boolean; strong?: boolean }) {
  return (
    <div className="flex items-center justify-between">
      <span className={cn("text-[12.5px]", muted ? "text-muted-foreground" : strong ? "font-semibold" : "text-foreground/80")}>
        {label}
      </span>
      <span className={cn("tnum text-[13px]", strong ? "text-base font-bold text-primary" : muted ? "text-muted-foreground" : "font-semibold")}>
        {value}
      </span>
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────────────────
   ── Deep-dive panel: a static "schedule of values" billing breakdown ─────────
   ───────────────────────────────────────────────────────────────────────────── */
function BillingDeepDivePanel({ lang }: { lang: "tr" | "en" }) {
  const lines: { trade: Trade; label: L; value: number; pct: number }[] = [
    { trade: "concrete", label: { tr: "Temel & kaba yapı", en: "Foundation & structure" }, value: 940_000, pct: 100 },
    { trade: "frame", label: { tr: "Çatı & kabuk", en: "Roof & envelope" }, value: 620_000, pct: 100 },
    { trade: "elec", label: { tr: "Tesisat altyapısı", en: "MEP rough-in" }, value: 540_000, pct: 70 },
    { trade: "finish", label: { tr: "İnce işler", en: "Interior finishes" }, value: 480_000, pct: 12 },
    { trade: "hvac", label: { tr: "Teslim & kabul", en: "Handover & punch" }, value: 260_000, pct: 0 },
  ];
  const total = lines.reduce((s, l) => s + l.value, 0);
  const billed = lines.reduce((s, l) => s + (l.value * l.pct) / 100, 0);
  const retainage = billed * 0.05;

  return (
    <div className="overflow-hidden rounded-2xl border border-border bg-card shadow-pop">
      <div className="flex items-center gap-2 border-b border-border px-5 py-3.5">
        <Calculator className="h-4 w-4 text-primary" />
        <span className="font-display text-[13px] font-bold tracking-tight">
          {lang === "tr" ? "Hakediş özeti — Maple Ridge" : "Schedule of values — Maple Ridge"}
        </span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border text-left">
              <th className="label-mono py-2.5 pl-5 font-medium text-muted-foreground">{lang === "tr" ? "Kalem" : "Item"}</th>
              <th className="label-mono py-2.5 font-medium text-muted-foreground">{lang === "tr" ? "Değer" : "Value"}</th>
              <th className="label-mono py-2.5 font-medium text-muted-foreground">%</th>
              <th className="label-mono py-2.5 pr-5 text-right font-medium text-muted-foreground">{lang === "tr" ? "Faturalandı" : "Billed"}</th>
            </tr>
          </thead>
          <tbody>
            {lines.map((l) => (
              <tr key={l.label.en} className="border-b border-border/60 last:border-0">
                <td className="py-2.5 pl-5">
                  <span className="flex items-center gap-2 text-[12.5px] font-medium">
                    <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: TRADE_META[l.trade].color }} />
                    <span className="truncate">{l.label[lang]}</span>
                  </span>
                </td>
                <td className="tnum py-2.5 text-[12px] text-muted-foreground">{formatMoney(l.value)}</td>
                <td className="py-2.5">
                  <span className="inline-flex items-center gap-1.5">
                    <span className="h-1.5 w-10 overflow-hidden rounded-full bg-muted">
                      <span className="block h-full rounded-full bg-primary" style={{ width: `${l.pct}%` }} />
                    </span>
                    <span className="tnum text-[11px] font-semibold">{l.pct}</span>
                  </span>
                </td>
                <td className="tnum py-2.5 pr-5 text-right text-[12px] font-semibold">{formatMoney((l.value * l.pct) / 100)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="grid grid-cols-3 gap-px border-t border-border bg-border">
        {[
          { label: lang === "tr" ? "Sözleşme" : "Contract", value: formatMoney(total), tone: "text-foreground" },
          { label: lang === "tr" ? "Faturalandı" : "Billed", value: formatMoney(billed), tone: "text-success" },
          { label: lang === "tr" ? "Teminat (5%)" : "Retainage (5%)", value: formatMoney(retainage), tone: "text-foreground" },
        ].map((s) => (
          <div key={s.label} className="bg-card px-4 py-3 text-center">
            <p className="text-[10px] text-muted-foreground">{s.label}</p>
            <p className={cn("tnum mt-1 text-[13px] font-bold", s.tone)}>{s.value}</p>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────────────────
   ── Inline-SVG company marks for the trusted-by strip ────────────────────────
   Each is a tiny construction-flavored glyph + a wordmark, rendered in a muted
   ink so the strip reads as a quiet logo wall.
   ───────────────────────────────────────────────────────────────────────────── */
type CompanyGlyph = "crane" | "frame" | "tree" | "level" | "block" | "beam" | "peak" | "bolt";

const COMPANY_GLYPHS: Record<CompanyGlyph, React.ReactNode> = {
  crane: <path d="M5 21 V5 H6 L16 5 M6 8 L14 5 M11 5 V8 M16 5 V9 M16 9 a1.4 1.4 0 1 0 0 0.01 Z" />,
  frame: <path d="M4 4 H20 V20 H4 Z M4 9 H20 M9 9 V20" />,
  tree: <path d="M12 3 L7 10 H10 L6 16 H11 V21 H13 V16 H18 L14 10 H17 Z" />,
  level: <path d="M3 9 H21 V15 H3 Z M8 11 v2 M12 11 v2 M16 11 v2" />,
  block: <path d="M4 8 L12 4 L20 8 L12 12 Z M4 8 V16 L12 20 V12 M20 8 V16 L12 20" />,
  beam: <path d="M3 7 H21 M3 17 H21 M7 7 L11 17 M13 7 L17 17 M11 7 L7 17 M17 7 L13 17" />,
  peak: <path d="M3 20 L9 8 L13 15 L16 10 L21 20 Z" />,
  bolt: <path d="M13 3 L5 13 H11 L9 21 L19 10 H13 Z" />,
};

function CompanyMark({ name, glyph }: { name: string; glyph: CompanyGlyph }) {
  return (
    <span className="inline-flex items-center gap-2 text-muted-foreground/70 grayscale transition-colors hover:text-foreground/80">
      <svg viewBox="0 0 24 24" className="h-5 w-5 shrink-0" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        {COMPANY_GLYPHS[glyph]}
      </svg>
      <span className="font-display text-[15px] font-bold tracking-tight">{name}</span>
    </span>
  );
}

/* ── A comparison-table cell (boolean check / dash, or text). ───────────────── */
function CompareCell({
  value,
  lang,
  highlight = false,
}: {
  value: boolean | L | string;
  lang: "tr" | "en";
  highlight?: boolean;
}) {
  const text = typeof value === "string" ? value : typeof value === "object" ? value[lang] : null;
  return (
    <td className={cn("px-5 py-3.5 text-center", highlight && "bg-primary/[0.04]")}>
      {typeof value === "boolean" ? (
        value ? (
          <span className={cn("mx-auto grid h-5 w-5 place-items-center rounded-full", highlight ? "bg-primary text-primary-foreground" : "bg-success/12 text-success")}>
            <Check className="h-3 w-3" strokeWidth={3} />
          </span>
        ) : (
          <span className="mx-auto grid h-5 w-5 place-items-center rounded-full bg-muted text-muted-foreground">
            <Minus className="h-3 w-3" />
          </span>
        )
      ) : (
        <span className={cn("text-[13px] font-medium", highlight ? "text-primary" : "text-muted-foreground")}>{text}</span>
      )}
    </td>
  );
}
