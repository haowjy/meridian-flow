import { cn } from "@/lib/utils";

/** Needle scale inside the cream-jade disc — reaches toward the ring like a compass. */
const NEEDLE_IN_DISC_SCALE = 0.92;

/**
 * Meridian brand mark — compass needle on a cream-jade disc (disc-cream-ring).
 *
 * Cinnabar north / jade south on a cream+ink pivot, seated on a warm cream+jade
 * puck with a hairline border ring. Token-driven fills (mark-disc-fill utility).
 */
export function MeridianMark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 48 48"
      fill="none"
      aria-hidden="true"
      className={cn("size-7 shrink-0", className)}
    >
      <circle cx={24} cy={24} r={22} className="mark-disc-fill" />
      <circle cx={24} cy={24} r={22} className="fill-none stroke-border" strokeWidth={1} />
      <g transform={`translate(24 24) scale(${NEEDLE_IN_DISC_SCALE}) translate(-24 -24)`}>
        <path d="M24 4 L29 24 L24 22 L19 24 Z" className="fill-cinnabar" />
        <path d="M24 44 L19 24 L24 26 L29 24 Z" className="fill-primary" />
        <circle cx={24} cy={24} r={2.5} className="fill-cream" />
        <circle cx={24} cy={24} r={1} className="fill-ink-deep" />
      </g>
    </svg>
  );
}
