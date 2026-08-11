import type { Metadata } from "next";
import localFont from "next/font/local";
import "./globals.css";
import { ThemeProvider } from "@/components/theme-provider";
import appConfig from "@/app.config";

// Hanken Grotesk drives both body and display weights for YapiFin — a clean,
// structural grotesque. JetBrains Mono carries tabular numbers (budgets, %).
// Both are self-hosted (SIL OFL, see app/fonts/*/LICENSE.txt) via next/font/local
// so the build doesn't depend on fonts.gstatic.com at build time.
const sans = localFont({
  variable: "--font-sans-app",
  display: "swap",
  src: [
    { path: "./fonts/hanken-grotesk/hanken-grotesk-latin-400-normal.woff2", weight: "400", style: "normal" },
    { path: "./fonts/hanken-grotesk/hanken-grotesk-latin-500-normal.woff2", weight: "500", style: "normal" },
    { path: "./fonts/hanken-grotesk/hanken-grotesk-latin-600-normal.woff2", weight: "600", style: "normal" },
    { path: "./fonts/hanken-grotesk/hanken-grotesk-latin-700-normal.woff2", weight: "700", style: "normal" },
    { path: "./fonts/hanken-grotesk/hanken-grotesk-latin-800-normal.woff2", weight: "800", style: "normal" },
  ],
});

const display = localFont({
  variable: "--font-display-app",
  display: "swap",
  src: [
    { path: "./fonts/hanken-grotesk/hanken-grotesk-latin-600-normal.woff2", weight: "600", style: "normal" },
    { path: "./fonts/hanken-grotesk/hanken-grotesk-latin-700-normal.woff2", weight: "700", style: "normal" },
    { path: "./fonts/hanken-grotesk/hanken-grotesk-latin-800-normal.woff2", weight: "800", style: "normal" },
  ],
});

const mono = localFont({
  variable: "--font-mono-app",
  display: "swap",
  src: [
    { path: "./fonts/jetbrains-mono/jetbrains-mono-latin-wght-normal.woff2", weight: "100 800", style: "normal" },
  ],
});

export const metadata: Metadata = {
  title: `${appConfig.name} — ${appConfig.tagline}`,
  description: appConfig.description,
  applicationName: appConfig.name,
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html
      lang="tr"
      suppressHydrationWarning
      className={`${sans.variable} ${display.variable} ${mono.variable} h-full`}
    >
      <body className="min-h-full bg-background text-foreground antialiased font-sans">
        <ThemeProvider attribute="class" defaultTheme="light" enableSystem={false}>
          {children}
        </ThemeProvider>
      </body>
    </html>
  );
}
