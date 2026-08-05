import { cn } from "@/lib/utils";
import appConfig from "@/app.config";

/**
 * YapiFin brand mark — a bespoke inline-SVG logomark in a construction
 * amber→orange gradient. The motif is a blueprint corner bracket cradling a
 * tower-crane silhouette (the jib + hook line), reading as "structure being
 * built." No external image. The setup can swap `appConfig.name` for the
 * wordmark; drop a real file at public/logo.svg if you have one.
 */
export function LogoMark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 32 32"
      className={cn("h-8 w-8 shrink-0", className)}
      aria-hidden
      fill="none"
    >
      <defs>
        <linearGradient id="buildr-mark" x1="4" y1="3" x2="28" y2="29" gradientUnits="userSpaceOnUse">
          <stop stopColor="oklch(74% 0.16 70)" />
          <stop offset="1" stopColor="oklch(62% 0.19 45)" />
        </linearGradient>
      </defs>
      <rect width="32" height="32" rx="9" fill="url(#buildr-mark)" />
      {/* blueprint corner bracket */}
      <path
        d="M8 9 V23 H22"
        stroke="#fff"
        strokeOpacity="0.5"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
      {/* tower-crane mast + jib */}
      <path
        d="M13 23 V11 M10.5 11 H22.5 M13 11 L17 8"
        stroke="#fff"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {/* hook line + load */}
      <path d="M20 11 V14.5" stroke="#fff" strokeWidth="1.5" strokeLinecap="round" />
      <rect x="18.6" y="14.5" width="2.8" height="2.4" rx="0.6" fill="#fff" />
    </svg>
  );
}

export function Logo({
  className,
  withWordmark = true,
  withChevron = false,
  onDark = false,
}: {
  className?: string;
  withWordmark?: boolean;
  /** Render a small chevron after the wordmark (matches the sidebar header). */
  withChevron?: boolean;
  /** Use light wordmark on a dark surface (e.g. the auth brand panel). */
  onDark?: boolean;
}) {
  return (
    <span className={cn("inline-flex items-center gap-2.5", className)}>
      <LogoMark className="h-8 w-8 shadow-pill" />
      {withWordmark && (
        <span className="inline-flex items-center gap-1.5">
          <span
            className={cn(
              "font-display text-[17px] font-bold tracking-[-0.02em]",
              onDark ? "text-white" : "text-foreground",
            )}
          >
            {appConfig.name}
          </span>
          {withChevron && (
            <svg viewBox="0 0 16 16" className="h-3.5 w-3.5 text-muted-foreground" aria-hidden>
              <path d="M5 6l3 3 3-3" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" fill="none" />
            </svg>
          )}
        </span>
      )}
    </span>
  );
}
