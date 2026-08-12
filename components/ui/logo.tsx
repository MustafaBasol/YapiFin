import Image from "next/image";
import { cn } from "@/lib/utils";
import appConfig from "@/app.config";

// Both lockups share the same 1536x1024 canvas — intrinsic size drives the
// aspect ratio; actual on-screen size is set via className (h-*).
const LOGO_WIDTH = 1536;
const LOGO_HEIGHT = 1024;

export function Logo({
  className,
  withChevron = false,
  onDark = false,
  priority = false,
}: {
  className?: string;
  /** Render a small chevron after the wordmark (matches the sidebar header). */
  withChevron?: boolean;
  /** Use the dark-surface lockup (white/mavi üzerine lacivert zemin) — örn. auth marka paneli. */
  onDark?: boolean;
  priority?: boolean;
}) {
  return (
    <span className={cn("inline-flex items-center gap-1.5", className)}>
      <Image
        src={onDark ? "/brand/yapifin-logo-dark.png" : "/brand/yapifin-logo-transparent.png"}
        alt={appConfig.name}
        width={LOGO_WIDTH}
        height={LOGO_HEIGHT}
        priority={priority}
        className="h-8 w-auto"
      />
      {withChevron && (
        <svg
          viewBox="0 0 16 16"
          className={cn("h-3.5 w-3.5", onDark ? "text-white/70" : "text-muted-foreground")}
          aria-hidden
        >
          <path
            d="M5 6l3 3 3-3"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
            fill="none"
          />
        </svg>
      )}
    </span>
  );
}
