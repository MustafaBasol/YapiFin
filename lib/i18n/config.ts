/**
 * Bilingual support. Every user-facing string in this kit is available in
 * Turkish and English. The language toggle (top-right) switches live and the
 * choice is remembered in localStorage.
 *
 * `L` is the shape of a translatable string: { tr, en }. The guided setup keeps
 * both languages in app.config.ts; pick() reads the active one.
 */
export const LANGS = ["tr", "en"] as const;
export type Lang = (typeof LANGS)[number];

/** Default language shown on first load. Change to "en" to default to English. */
export const DEFAULT_LANG: Lang = "tr";

export const LANG_LABEL: Record<Lang, string> = { tr: "TR", en: "EN" };

/** A translatable string. */
export type L = { tr: string; en: string };

/** Pick the active language out of an L (falls back to the other if missing). */
export function pick(value: L, lang: Lang): string {
  return value[lang] ?? value[lang === "tr" ? "en" : "tr"];
}
