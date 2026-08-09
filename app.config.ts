/**
 * app.config.ts — YapiFin'in marka ve navigasyon yapılandırması. Ürün tek
 * dilde (Türkçe) olduğu için tüm metinler düz string'dir; bkz. CLAUDE.md.
 */
import type { UserRole } from "@prisma/client";

export interface NavItem {
  label: string;
  href: string;
  icon: string;
  /** Bu sayfa henüz bu fazda uygulanmadıysa true — tıklanamaz, "Yakında" rozeti gösterilir. */
  comingSoon?: boolean;
  /** Belirtilirse yalnızca bu rollere sahip kullanıcılara gösterilir. */
  roles?: UserRole[];
}

const nav: NavItem[] = [
    { label: "Panel", href: "/dashboard", icon: "layout-dashboard" },
    { label: "Projeler", href: "/projects", icon: "hard-hat" },
    { label: "Gelirler", href: "/income", icon: "trending-up" },
    { label: "Giderler", href: "/expenses", icon: "trending-down" },
    {
      label: "Belge Yükle (OCR)",
      href: "/documents/ocr/new",
      icon: "scan-line",
      roles: ["OWNER", "ADMIN", "FINANCE", "PROJECT_MANAGER"],
    },
    { label: "Tahsilatlar", href: "/collections", icon: "hand-coins", comingSoon: true },
    { label: "Ödemeler", href: "/payments", icon: "banknote", comingSoon: true },
    {
      label: "Kasa ve Banka",
      href: "/accounts",
      icon: "landmark",
      roles: ["OWNER", "ADMIN", "FINANCE"],
    },
    {
      label: "Banka İçe Aktarım",
      href: "/bank-import",
      icon: "file-up",
      roles: ["OWNER", "ADMIN", "FINANCE"],
    },
    { label: "Müşteriler", href: "/customers", icon: "users" },
    {
      label: "Tedarikçiler / Taşeronlar",
      href: "/suppliers",
      icon: "truck",
      roles: ["OWNER", "ADMIN", "FINANCE"],
    },
    {
      label: "Kategoriler",
      href: "/categories",
      icon: "tags",
      roles: ["OWNER", "ADMIN", "FINANCE"],
    },
    { label: "Raporlar", href: "/reports", icon: "chart-no-axes-column" },
    { label: "AI İçgörüleri", href: "/ai-insights", icon: "sparkles" },
    { label: "Kullanıcılar", href: "/users", icon: "user-cog", roles: ["OWNER", "ADMIN"] },
    { label: "Entegrasyonlar", href: "/settings/integrations", icon: "plug", roles: ["OWNER", "ADMIN"] },
    { label: "Ayarlar", href: "/settings", icon: "settings", roles: ["OWNER", "ADMIN"] },
];

export const appConfig = {
  name: "YapiFin",
  tagline: "Projelerinin finansını tek panelden yönet.",
  description:
    "Gelir, gider, tahsilat, ödeme, kasa-banka ve proje kârlılığını tek panelden takip et.",
  domain: "yapifin.com",

  nav,

  marketing: {
    badge: "İnşaat proje finansı",
    heroTitle: "Şantiyenin parasını",
    heroAccent: "tek panelden yönet.",
    heroSubtitle:
      "Gelir, gider, tahsilat, ödeme, kasa-banka ve bütçeyi proje bazında takip et. Excel tablolarını ve dağınık defterleri bırak; her projenin kârlılığını anında gör.",
    heroCtaPrimary: "Ücretsiz başla",
    heroCtaSecondary: "Giriş yap",
    features: [
      {
        icon: "hard-hat",
        title: "Proje bazlı takip",
        body: "Her şantiyenin gelir, gider ve bütçesini ayrı ayrı gör; hangi proje kâr ediyor anında anla.",
      },
      {
        icon: "trending-up",
        title: "Gelir ve gider",
        body: "KDV'li tutarları kaydet, vade takibi yap, vadesi geçen alacak ve borçları kaçırma.",
      },
      {
        icon: "hand-coins",
        title: "Parçalı tahsilat ve ödeme",
        body: "Bir faturayı birden fazla tahsilata böl; kalan bakiye ve durum otomatik hesaplansın.",
      },
      {
        icon: "landmark",
        title: "Kasa ve banka",
        body: "Nakit, banka ve kredi kartı hesaplarını tek yerde yönet, hesaplar arası transferi kaydet.",
      },
      {
        icon: "users",
        title: "Rol tabanlı erişim",
        body: "Firma sahibi, yönetici, finans ve proje yöneticisi rolleriyle kim neyi görür sen belirle.",
      },
      {
        icon: "shield-check",
        title: "Denetim kaydı",
        body: "Kritik finansal işlemler kayıt altında; kim, ne zaman, ne değiştirdi her zaman izlenebilir.",
      },
    ],
  },
};

export default appConfig;
