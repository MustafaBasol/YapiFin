import type { Metadata } from "next";
import { JetBrains_Mono } from "next/font/google";
import localFont from "next/font/local";
import "./globals.css";
import { ThemeProvider } from "@/components/theme-provider";
import appConfig from "@/app.config";

// Hanken Grotesk drives both body and display weights for YapiFin — a clean,
// structural grotesque. Self-hosted (SIL OFL, see app/fonts/hanken-grotesk/LICENSE.txt)
// via next/font/local so the build doesn't depend on fonts.gstatic.com at build time.
// JetBrains Mono carries tabular numbers (budgets, %).
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

const mono = JetBrains_Mono({
  variable: "--font-mono-app",
  subsets: ["latin"],
  display: "swap",
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
