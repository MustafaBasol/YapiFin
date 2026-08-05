/**
 * ┌──────────────────────────────────────────────────────────────────────────┐
 * │  app.config.ts — the single source of truth for this starter.            │
 * │                                                                          │
 * │  Every user-facing string is bilingual: { tr: "...", en: "..." }.        │
 * │  The guided setup (run `/setup`, or say "bu projeyi kur") edits this      │
 * │  file plus app/globals.css and .env.local.                               │
 * └──────────────────────────────────────────────────────────────────────────┘
 *
 *  YAPIFIN — construction project management. Estimates & bids, jobs,
 *  subcontractors, progress billing (hakediş) and schedules, in one place.
 *  Modeled on real, working products (Buildertrend, Procore). English brand;
 *  copy toggles TR/EN.
 */
import type { L } from "@/lib/i18n/config";

export type IconName = string;

export interface NavItem {
  label: L;
  href: string;
  icon: IconName;
  /** Optional "Soon" / "Beta" style badge shown muted in the sidebar. */
  badge?: L;
  /** Render as disabled/muted (e.g. a not-yet-shipped section). */
  muted?: boolean;
}

export interface NavGroup {
  label: L;
  items: NavItem[];
}

export interface Feature {
  icon: IconName;
  title: L;
  body: L;
}

export interface Stat {
  value: string;
  label: L;
}

export interface PricingTier {
  name: string;
  price: string;
  period?: L;
  tagline: L;
  features: L[];
  cta: L;
  featured?: boolean;
}

export interface FaqItem {
  q: L;
  a: L;
}

export interface Integration {
  key: string;
  name: string;
  envVars: string[];
  required: boolean;
  docsUrl: string;
  purpose: string;
}

export interface AppConfig {
  name: string;
  tagline: L;
  description: L;
  domain: string;
  logoText: string;
  accentName: string;
  marketing: {
    badge: L;
    heroTitle: L;
    heroAccent: L;
    heroSubtitle: L;
    heroCtaPrimary: L;
    heroCtaSecondary: L;
    features: Feature[];
    stats: Stat[];
    pricing: PricingTier[];
    faq: FaqItem[];
  };
  /** Sidebar navigation, grouped (Build / Office). */
  navGroups: NavGroup[];
  /** Flat nav (kept for the topbar title lookup + back-compat). */
  nav: NavItem[];
  integrations: Integration[];
}

export const appConfig: AppConfig = {
  name: "YapiFin",
  tagline: {
    tr: "Projelerinin finansını tek panelden yönet.",
    en: "Manage every project finance from one panel.",
  },
  description: {
    tr: "Gelir, gider, tahsilat, ödeme, kasa-banka ve proje kârlılığını tek panelden takip et.",
    en: "Track income, expenses, collections, payments, cash and project profitability in one panel.",
  },
  domain: "yapifin.com",
  logoText: "Y",
  accentName: "teal",

  marketing: {
    badge: { tr: "İnşaat proje yönetimi", en: "Construction project management" },
    heroTitle: {
      tr: "Her inşaatı zamanında",
      en: "Run every build on time",
    },
    heroAccent: {
      tr: "ve bütçesinde yönet.",
      en: "and on budget.",
    },
    heroSubtitle: {
      tr: "Keşiften programa, sahadan hakedişe. YapiFin işlerini, taşeronlarını ve bütçeni tek panelde toplar — tabloları ve WhatsApp'ı geride bırak, her projeyi kontrol altında tut.",
      en: "From estimate to schedule, from site to billing. YapiFin brings your jobs, subcontractors and budget into one panel — leave the spreadsheets and WhatsApp behind and keep every project on track.",
    },
    heroCtaPrimary: { tr: "Ücretsiz başla", en: "Start free" },
    heroCtaSecondary: { tr: "Canlı demoyu gör", en: "See the live demo" },
    features: [
      { icon: "calculator", title: { tr: "Keşif & teklif", en: "Estimates & bids" }, body: { tr: "Kalemli keşifler hazırla, taşeron tekliflerini topla ve tek tıkla sözleşmeye çevir.", en: "Build line-item estimates, collect subcontractor bids, and turn the winning one into a contract in a click." } },
      { icon: "calendar-range", title: { tr: "Program & faz takibi", en: "Scheduling" }, body: { tr: "Fazları bir zaman çizelgesine diz, bağımlılıkları gör ve gecikmeleri herkes fark etmeden yakala.", en: "Lay phases on a timeline, see dependencies, and catch slippage before anyone else notices." } },
      { icon: "wallet", title: { tr: "Bütçe takibi", en: "Budget tracking" }, body: { tr: "Her kalemde bütçe ve gerçek harcamayı yan yana gör; aşımları kırmızıda yakala.", en: "See budgeted vs actual side by side on every line, and catch overruns in the red." } },
      { icon: "hard-hat", title: { tr: "Taşeron yönetimi", en: "Subcontractor management" }, body: { tr: "Ekipleri işe ata, sözleşmeleri ve sigorta tarihlerini takip et, ilerlemeyi tek yerden gör.", en: "Assign crews to jobs, track contracts and insurance dates, and watch progress from one place." } },
      { icon: "receipt-text", title: { tr: "Hakediş & ödeme", en: "Progress billing" }, body: { tr: "Tamamlanma yüzdesine göre hakediş kes, teminatı (retainage) hesapla ve müşteriye gönder.", en: "Bill by percent complete, calculate retainage, and send progress invoices to the client." } },
      { icon: "clipboard-list", title: { tr: "Günlük şantiye kaydı", en: "Daily logs" }, body: { tr: "Hava durumu, ekip sayısı, görevler ve gecikmeler — sahanın resmi her gün bir tıkla.", en: "Weather, crew counts, tasks and delays — the official record of your site, one click a day." } },
    ],
    stats: [
      { value: "0.9%", label: { tr: "ortalama bütçe sapması", en: "avg budget variance" } },
      { value: "+40%", label: { tr: "zamanında teslim", en: "on-time delivery" } },
      { value: "6 hafta", label: { tr: "kazanılan süre / yıl", en: "weeks saved / year" } },
      { value: "1 panel", label: { tr: "tüm projeler", en: "for all projects" } },
    ],
    pricing: [
      { name: "Solo", price: "$0", period: { tr: "/ay", en: "/mo" }, tagline: { tr: "Tek müteahhit için.", en: "For the solo contractor." }, features: [{ tr: "1 aktif proje", en: "1 active project" }, { tr: "Keşif & program", en: "Estimates & schedule" }, { tr: "Günlük şantiye kaydı", en: "Daily logs" }, { tr: "Demo modu", en: "Demo mode" }], cta: { tr: "Başla", en: "Get started" } },
      { name: "Crew", price: "$59", period: { tr: "/ay", en: "/mo" }, tagline: { tr: "Büyüyen yükleniciler için.", en: "For growing builders." }, features: [{ tr: "10 aktif proje", en: "10 active projects" }, { tr: "Taşeron & teklif yönetimi", en: "Subcontractors & bids" }, { tr: "Hakediş & teminat", en: "Progress billing & retainage" }, { tr: "Bütçe vs gerçek raporları", en: "Budget vs actual reports" }, { tr: "Öncelikli destek", en: "Priority support" }], cta: { tr: "Ücretsiz dene", en: "Start free trial" }, featured: true },
      { name: "Firm", price: "Custom", tagline: { tr: "Kurumsal şirketler için.", en: "For established firms." }, features: [{ tr: "Sınırsız proje", en: "Unlimited projects" }, { tr: "Roller & onay akışları", en: "Roles & approvals" }, { tr: "Muhasebe & e-imza entegrasyonu", en: "Accounting & e-sign integration" }, { tr: "SLA & denetim kaydı", en: "SLA & audit log" }, { tr: "Özel hesap yöneticisi", en: "Dedicated manager" }], cta: { tr: "Satışa ulaş", en: "Contact sales" } },
    ],
    faq: [
      { q: { tr: "YapiFin tam olarak ne yapıyor?", en: "What does YapiFin actually do?" }, a: { tr: "Keşif ve teklifi, programı, taşeronları, bütçeyi ve hakedişi tek panelde toplar. İnşaat firmaları için Buildertrend / Procore tarzı bir proje yönetim aracı.", en: "It brings estimates & bids, the schedule, subcontractors, budget and progress billing into one panel — a Buildertrend / Procore-style project tool for construction firms." } },
      { q: { tr: "Hakediş (progress billing) nasıl çalışıyor?", en: "How does progress billing work?" }, a: { tr: "Her hakediş kalemini tamamlanma yüzdesine göre faturalandırırsın; YapiFin teminatı (retainage) düşer, kalan bakiyeyi hesaplar ve müşteriye gönderilecek hakediş özetini hazırlar.", en: "You bill each milestone by percent complete; YapiFin deducts retainage, computes the remaining balance, and prepares the progress invoice to send to the client." } },
      { q: { tr: "Taşeronları ve teklifleri yönetebilir miyim?", en: "Can I manage subcontractors and bids?" }, a: { tr: "Evet. Taşeronları işlere atar, sözleşme ve sigorta tarihlerini takip eder, gelen teklifleri yan yana karşılaştırıp kazananı sözleşmeye çevirirsin.", en: "Yes. Assign subs to jobs, track contract and insurance dates, compare incoming bids side by side, and turn the winner into a contract." } },
      { q: { tr: "Bütçeyi gerçek harcamayla nasıl kıyaslıyor?", en: "How does it track budget vs actual?" }, a: { tr: "Her kalemde bütçelenen ve gerçekleşen tutar yan yana durur; harcama bütçeyi aştığında kalem kırmızıya döner, proje genelinde sapma yüzdesini görürsün.", en: "Each line shows budgeted vs actual side by side; a line turns red when spend exceeds budget, and you see the variance percentage across the whole project." } },
      { q: { tr: "Denemek için anahtar gerekli mi?", en: "Do I need keys to try it?" }, a: { tr: "Hayır. Gerçekçi örnek projelerle demo modda açılır — hemen tıklayabilirsin.", en: "No. It boots in demo mode with realistic sample projects — click around immediately." } },
      { q: { tr: "Teknoloji nedir?", en: "What's the stack?" }, a: { tr: "Next.js 16, React 19, Tailwind v4. Supabase, dosya/fotoğraf depolama, muhasebe dışa aktarımı ve sözleşme e-imzası ile bağlanır.", en: "Next.js 16, React 19, Tailwind v4. Wires to Supabase, file/photo storage, an accounting export, and contract e-sign." } },
      { q: { tr: "Sahadan, telefondan kullanabilir miyim?", en: "Can I use it from the field, on my phone?" }, a: { tr: "Evet — duyarlı bir web uygulamasıdır. Şantiye kayıtlarını ve görevleri telefondan, ofis işlerini masaüstünden yönet.", en: "Yes — it's a responsive web app. Manage daily logs and tasks from your phone, and office work from the desktop." } },
      { q: { tr: "Yayına alabilir miyim?", en: "Can I deploy it?" }, a: { tr: "Evet — standart bir Next.js uygulaması. Vercel'e veya herhangi bir Node sunucusuna gönder.", en: "Yes — it's a standard Next.js app. Push to Vercel or any Node host." } },
    ],
  },

  navGroups: [
    {
      label: { tr: "Saha", en: "Build" },
      items: [
        { label: { tr: "Panel", en: "Dashboard" }, href: "/dashboard", icon: "layout-dashboard" },
        { label: { tr: "Projeler", en: "Projects" }, href: "/projects", icon: "hard-hat" },
        { label: { tr: "Program", en: "Schedule" }, href: "/schedule", icon: "calendar-range" },
        { label: { tr: "Taşeronlar", en: "Subcontractors" }, href: "/subcontractors", icon: "users", badge: { tr: "Yakında", en: "Soon" }, muted: true },
      ],
    },
    {
      label: { tr: "Ofis", en: "Office" },
      items: [
        { label: { tr: "Keşif & teklif", en: "Estimates" }, href: "/estimates", icon: "calculator", muted: true },
        { label: { tr: "Hakediş", en: "Billing" }, href: "/billing", icon: "receipt-text", muted: true },
        { label: { tr: "Raporlar", en: "Reports" }, href: "/reports", icon: "chart-no-axes-column", muted: true },
        { label: { tr: "Entegrasyonlar", en: "Integrations" }, href: "/settings", icon: "plug" },
      ],
    },
  ],

  nav: [
    { label: { tr: "Panel", en: "Dashboard" }, href: "/dashboard", icon: "layout-dashboard" },
    { label: { tr: "Projeler", en: "Projects" }, href: "/projects", icon: "hard-hat" },
    { label: { tr: "Program", en: "Schedule" }, href: "/schedule", icon: "calendar-range" },
    { label: { tr: "Ayarlar", en: "Settings" }, href: "/settings", icon: "settings" },
  ],

  integrations: [
    {
      key: "supabase",
      name: "Supabase",
      envVars: ["NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_ANON_KEY"],
      required: false,
      docsUrl: "https://supabase.com/dashboard/project/_/settings/api",
      purpose: "Database & auth for projects, jobs and billing. Without it, the app runs in demo mode.",
    },
    {
      key: "blob_storage",
      name: "Blob / Photo Storage",
      envVars: ["BLOB_READ_WRITE_TOKEN"],
      required: false,
      docsUrl: "https://vercel.com/docs/storage/vercel-blob",
      purpose: "Store plans, site photos and signed documents. Without it, attachments are demo placeholders.",
    },
    {
      key: "accounting_export",
      name: "Accounting Export (QuickBooks)",
      envVars: ["QUICKBOOKS_CLIENT_ID", "QUICKBOOKS_CLIENT_SECRET"],
      required: false,
      docsUrl: "https://developer.intuit.com/app/developer/qbo/docs/get-started",
      purpose: "Push progress invoices and cost codes to your books. Without it, billing exports to CSV.",
    },
    {
      key: "esign",
      name: "E-Sign (DocuSign)",
      envVars: ["DOCUSIGN_INTEGRATION_KEY", "DOCUSIGN_SECRET_KEY"],
      required: false,
      docsUrl: "https://developers.docusign.com/",
      purpose: "Send contracts and change orders for signature. Without it, contracts stay as draft PDFs.",
    },
  ],
};

export default appConfig;
