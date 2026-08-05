import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/** YapiFin Türkiye pazarı için tek para birimi. */
export const CURRENCY = "TRY";

/** `1.250.000,00 ₺` biçiminde tr-TR para gösterimi. Kabul edilebilir Prisma Decimal, string veya number girdisi. */
export function formatMoney(amount: number | string, currency: string = CURRENCY) {
  const value = typeof amount === "string" ? Number(amount) : amount;
  return new Intl.NumberFormat("tr-TR", {
    style: "currency",
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
}

export function formatNumber(n: number) {
  return new Intl.NumberFormat("tr-TR").format(n);
}

export function formatPercent(n: number, digits = 1) {
  return `${n > 0 ? "+" : ""}${n.toFixed(digits).replace(".", ",")}%`;
}

/** `GG.AA.YYYY` biçiminde tarih. */
export function formatDate(d: Date | string) {
  const date = typeof d === "string" ? new Date(d) : d;
  return new Intl.DateTimeFormat("tr-TR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    timeZone: "Europe/Istanbul",
  }).format(date);
}

/** `GG.AA.YYYY SS:DD` biçiminde tarih + 24 saat. */
export function formatDateTime(d: Date | string) {
  const date = typeof d === "string" ? new Date(d) : d;
  return new Intl.DateTimeFormat("tr-TR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZone: "Europe/Istanbul",
  }).format(date);
}

export function formatRelative(d: Date | string) {
  const date = typeof d === "string" ? new Date(d) : d;
  const diff = Date.now() - date.getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return "az önce";
  if (m < 60) return `${m} dk önce`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} sa önce`;
  const days = Math.floor(h / 24);
  if (days < 7) return `${days} gün önce`;
  return formatDate(date);
}

export function initials(name: string) {
  return name
    .split(" ")
    .map((p) => p[0])
    .join("")
    .toUpperCase()
    .slice(0, 2);
}
