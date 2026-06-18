import { cn } from "@/lib/utils";

/**
 * Meridian brand mark — the compass needle (system #1).
 *
 * Cinnabar north / jade south on a cream+ink pivot. Carries both brand colors
 * in one balanced mark; fills are token-driven (no hardcoded hex) so the needle
 * follows the theme. Sits beside the Cormorant wordmark in the sidebar header.
 */
export function MeridianMark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 48 48"
      fill="none"
      aria-hidden="true"
      className={cn("size-7 shrink-0", className)}
    >
      <path d="M24 4 L29 24 L24 22 L19 24 Z" className="fill-cinnabar" />
      <path d="M24 44 L19 24 L24 26 L29 24 Z" className="fill-primary" />
      <circle cx="24" cy="24" r="2.5" className="fill-cream" />
      <circle cx="24" cy="24" r="1" className="fill-ink-deep" />
    </svg>
  );
}
