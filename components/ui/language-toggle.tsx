"use client";

import { LANGS, LANG_LABEL } from "@/lib/i18n/config";
import { useLang } from "@/components/i18n/language-provider";
import { cn } from "@/lib/utils";

export function LanguageToggle({
  className,
  onDark = false,
}: {
  className?: string;
  onDark?: boolean;
}) {
  const { lang, setLang } = useLang();
  return (
    <div
      className={cn(
        "inline-flex items-center rounded-lg border p-0.5 text-xs font-semibold",
        onDark ? "border-white/15" : "border-border",
        className,
      )}
    >
      {LANGS.map((l) => (
        <button
          key={l}
          onClick={() => setLang(l)}
          aria-pressed={lang === l}
          className={cn(
            "rounded-md px-2 py-1 transition-colors cursor-pointer",
            lang === l
              ? "bg-primary text-primary-foreground"
              : onDark
                ? "text-white/60 hover:text-white"
                : "text-muted-foreground hover:text-foreground",
          )}
        >
          {LANG_LABEL[l]}
        </button>
      ))}
    </div>
  );
}
